import { afterEach, describe, expect, it } from 'vitest';
import { DshAdapter } from '../src/adapters/dsh.js';
import type { HttpRequest, HttpResponse, Transport } from '../src/types.js';

class FakeTransport implements Transport {
  readonly kind = 'local' as const;
  readonly calls: HttpRequest[] = [];
  closed = false;

  async request(input: HttpRequest): Promise<HttpResponse> {
    this.calls.push(input);
    if (input.path.startsWith('/connect?')) {
      return { status: 302, headers: { 'set-cookie': 'dsh-cookie=secret; Path=/; HttpOnly' }, text: '' };
    }
    expect(input.headers?.Cookie).toBe('dsh-cookie=secret');
    const body = input.body as any;
    expect(body.type).toBe('client-request');
    expect(body.method).toBe(input.path.replace('/api/', ''));
    const args = body.payload.args;
    switch (body.method) {
      case 'session/list':
        expect(args).toEqual({ _request: {} });
        return ok({ items: [{ sessionId: 'dsh-session-1', title: 'Remote' }] });
      case 'session/create':
        return ok({ sessionId: args.request.sessionId, agentPreset: 'default' });
      case 'session/selectModel':
        return ok({ selected: { provider: args.request.provider, model: args.request.model } });
      case 'session/prompt':
        expect(args.request.content).toEqual([{ type: 'text', text: 'remember AL-TEST' }]);
        return ok({ accepted: true });
      case 'session/wait':
        return ok({
          reason: 'idle',
          state: { cursor: 7, active: false, running: false },
          output: {
            records: [
              {
                type: 'event',
                event: {
                  type: 'assistant/message',
                  seq: 7,
                  data: { message: { content: [{ type: 'text', text: 'AL-TEST' }] } },
                },
              },
            ],
            truncated: false,
          },
        });
      case 'session/cancel':
        return ok({ accepted: true });
      default:
        throw new Error(`Unexpected method ${body.method}`);
    }
  }

  async stream(): Promise<never> {
    throw new Error('not used');
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function ok(value: unknown): HttpResponse {
  return {
    status: 200,
    headers: {},
    text: JSON.stringify({ type: 'server-response', rpcId: 'test', result: { ok: true, value } }),
  };
}

afterEach(() => {
  delete process.env.DSH_GATEWAY_TOKEN;
});

describe('DSH adapter', () => {
  it('uses native session RPC with an API cookie and returns assistant output', async () => {
    process.env.DSH_GATEWAY_TOKEN = 'launch-token';
    const transport = new FakeTransport();
    const adapter = new DshAdapter(
      'remote',
      {
        id: 'remote',
        kind: 'dsh',
        transport: 'local',
        model: 'glm-test',
        dshProvider: 'openai',
      },
      transport,
    );

    expect(await adapter.health()).toEqual({ ok: true, sessions: 1 });
    expect(await adapter.listSessions()).toEqual([{ id: 'dsh-session-1', title: 'Remote', updatedAt: undefined }]);
    const events = [];
    for await (const event of adapter.prompt('dsh-session-1', 'remember AL-TEST')) events.push(event);
    expect(events.at(-1)).toMatchObject({ type: 'final', text: 'AL-TEST', stopReason: 'idle' });
    expect(transport.calls.some((call) => (call.body as any)?.method === 'session/selectModel')).toBe(true);
    expect(transport.calls.find((call) => (call.body as any)?.method === 'session/wait')?.body).toMatchObject({
      payload: { args: { request: { afterSeq: 0, timeoutMs: 30_000 } } },
    });
    await adapter.cancel('dsh-session-1');
    await adapter.close();
    expect(transport.closed).toBe(true);
  });
});
