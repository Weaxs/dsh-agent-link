import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { AcpBridge } from '../src/acp/bridge.js';
import { AcpAdapter } from '../src/adapters/acp.js';
import type { AgentAdapter, AgentEvent } from '../src/types.js';

class FakeNativeAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  readonly prompts: Array<{ sessionId: string; text: string }> = [];
  choice?: string;
  cancelled = false;

  constructor(readonly id = 'native') {}

  async health() {
    return { ok: true };
  }

  async listSessions() {
    return [
      { id: this.prompts[0]?.sessionId ?? 'session-1', title: 'ACP session', updatedAt: '2026-01-01T00:00:00.000Z' },
    ];
  }

  async *prompt(sessionId: string | undefined, text: string): AsyncIterable<AgentEvent> {
    this.prompts.push({ sessionId: sessionId ?? '', text });
    yield { type: 'text', text: 'hello ' };
    yield { type: 'tool', phase: 'start', requestId: 'tool-1', name: 'test-tool' };
    yield { type: 'tool', phase: 'end', requestId: 'tool-1', name: 'test-tool' };
    yield { type: 'approval', requestId: 'permission-1', choices: ['approve', 'reject'], text: 'Allow the test?' };
    while (!this.choice) await new Promise((resolve) => setTimeout(resolve, 1));
    yield { type: 'text', text: 'world' };
    yield { type: 'final', text: 'hello world', stopReason: 'completed' };
  }

  async cancel() {
    this.cancelled = true;
  }

  async respond(_sessionId: string, _requestId: string, choice: string) {
    this.choice = choice;
  }

  async close() {}
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

describe('ACP provider and bridge', () => {
  it('runs prompts, continuations, tools and permissions over the official ACP WebSocket transport', async () => {
    const native = new FakeNativeAdapter();
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const adapter = new AcpAdapter('unified', {
      id: 'unified',
      kind: 'acp',
      transport: 'local',
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    });
    cleanups.push(async () => {
      await adapter.close();
      await bridge.close();
    });

    expect(await adapter.health()).toMatchObject({ ok: true, protocol: 'acp', protocolVersion: 1 });
    const first = [];
    for await (const event of adapter.prompt('alias-1', 'first prompt')) {
      first.push(event);
      if (event.type === 'approval') await adapter.respond('alias-1', event.requestId!, 'approve');
    }
    expect(first.at(-1)).toMatchObject({ type: 'final', text: 'hello world', stopReason: 'end_turn' });
    expect(first.filter((event) => event.type === 'tool')).toHaveLength(2);
    expect(native.choice).toBe('approve');

    native.choice = undefined;
    const second = [];
    for await (const event of adapter.prompt('alias-1', 'continuation')) {
      second.push(event);
      if (event.type === 'approval') await adapter.respond('alias-1', event.requestId!, 'approve');
    }
    expect(second.at(-1)).toMatchObject({ type: 'final', text: 'hello world' });
    expect(native.prompts.map((prompt) => prompt.text)).toEqual(['first prompt', 'continuation']);
    expect(new Set(native.prompts.map((prompt) => prompt.sessionId)).size).toBe(1);
    expect(await adapter.listSessions()).toEqual([
      { id: native.prompts[0]!.sessionId, title: 'ACP session', updatedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });

  it('propagates cancellation through ACP session/cancel', async () => {
    class SlowAdapter extends FakeNativeAdapter {
      override async *prompt(sessionId: string | undefined): AsyncIterable<AgentEvent> {
        void sessionId;
        yield { type: 'text', text: 'working' };
        while (!this.cancelled) await new Promise((resolve) => setTimeout(resolve, 1));
        yield { type: 'final', text: 'working', stopReason: 'cancelled' };
      }
    }
    const native = new SlowAdapter();
    const bridge = new AcpBridge({ id: 'native', kind: 'hermes' }, () => native);
    const address = await bridge.start({ port: 0, token: 'acp-test-token' });
    const adapter = new AcpAdapter('unified', {
      id: 'unified',
      kind: 'acp',
      transport: 'local',
      host: address.host,
      port: address.port,
      token: 'acp-test-token',
    });
    cleanups.push(async () => {
      await adapter.close();
      await bridge.close();
    });

    const events = [];
    for await (const event of adapter.prompt('cancel-alias', 'wait')) {
      events.push(event);
      if (event.type === 'text') await adapter.cancel('cancel-alias');
    }
    expect(native.cancelled).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: 'final', stopReason: 'cancelled' });
  });

  it('connects to a standard ACP stdio agent through ndJsonStream', async () => {
    const adapter = new AcpAdapter('stdio', {
      id: 'stdio',
      kind: 'acp',
      transport: 'local',
      acpTransport: 'stdio',
      acpCommand: process.execPath,
      acpArgs: [fileURLToPath(new URL('./fixtures/acp-stdio-agent.mjs', import.meta.url))],
    });
    cleanups.push(() => adapter.close());
    expect(await adapter.health()).toMatchObject({ ok: true, protocol: 'acp', protocolVersion: 1 });
    const events = [];
    for await (const event of adapter.prompt('stdio-alias', 'hello')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'stdio:hello', stopReason: 'end_turn' });
  });
});
