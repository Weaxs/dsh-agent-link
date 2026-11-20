import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { Config } from '../src/index.js';
import { AgentManager } from '../src/manager.js';
import { McpServer } from '../src/mcp/server.js';
import type { SessionControllerLike } from '../src/mcp/session-service.js';
import type { AgentAdapter, AgentConfig, AgentEvent } from '../src/types.js';
import { registerWebRoutes, WEB_ROUTES } from '../src/web/routes.js';

class StubAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  responded?: string;
  cancelled = false;
  constructor(readonly id: string) {}
  async health() {
    return { ok: true };
  }
  async listSessions() {
    return [{ id: 'remote-1', title: 'Remote Task', updatedAt: '2026-11-20T00:00:00Z' }];
  }
  async *prompt(): AsyncIterable<AgentEvent> {
    yield { type: 'approval', requestId: 'req-1', choices: ['approve', 'deny'], text: 'Run pytest?' };
    await new Promise((resolve) => setTimeout(resolve, 200));
    yield { type: 'final', text: 'done' };
  }
  async cancel() {
    this.cancelled = true;
  }
  async respond(_sessionId: string, _requestId: string, choice: string) {
    this.responded = choice;
  }
  async close() {}
}

const sessionsController: SessionControllerLike = {
  async list() {
    return { items: [{ sessionId: 'local-1', title: 'Local Session', cwd: '/work' }] };
  },
  async events() {
    return { records: [] };
  },
  async *follow() {},
};

let mcp: McpServer | undefined;
afterEach(async () => {
  await mcp?.close();
  mcp = undefined;
  delete process.env.DSH_KNOT_STATE_DIR;
});

describe('web UI host routes & schemastery Config', () => {
  it('exports a valid schemastery Config schema', () => {
    expect(Config).toBeDefined();
    const parsed = Config({});
    expect(parsed.agents).toEqual([]);
    expect(parsed.jobTimeoutMs).toBe(1_800_000);
    expect(parsed.mcp?.enabled).toBe(false);
  });

  it('serves state, doctor, sessions, respond, cancel, and live mcp-share toggles', async () => {
    const config: AgentConfig = { id: 'hermes-local', kind: 'hermes', transport: 'local', port: 8642 };
    const adapter = new StubAdapter('hermes-local');
    const manager = new AgentManager([config], 10_000, () => adapter);
    mcp = new McpServer({ port: 0, token: 'secret-tok', allowSessions: [] }, sessionsController);
    await mcp.start();

    const routes = new Map<string, (req: Request) => Promise<Response>>();
    const ctx = {
      connection: {
        fetch: {
          register(route: { path: string; fetch: (req: Request) => Promise<Response> }) {
            routes.set(route.path, route.fetch);
            return () => routes.delete(route.path);
          },
        },
      },
      effect() {},
    } as any;

    registerWebRoutes(ctx, manager, mcp, sessionsController);
    expect([...routes.keys()].sort()).toEqual(Object.values(WEB_ROUTES).sort());

    const post = async (path: string, body: Record<string, unknown> = {}) => {
      const handler = routes.get(path)!;
      const res = await handler(
        new Request(`http://localhost${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return (await res.json()) as any;
    };

    const initial = await post(WEB_ROUTES.state);
    expect(initial.ok).toBe(true);
    expect(initial.value.agents).toHaveLength(1);
    expect(initial.value.mcp.enabled).toBe(true);
    expect(initial.value.mcp.localSessions[0].shared).toBe(false);
    expect(JSON.stringify(initial)).not.toContain('secret-tok');

    const toggled = await post(WEB_ROUTES.mcpShare, { sessionId: 'local-1', allow: true });
    expect(toggled.ok).toBe(true);
    expect(toggled.value.allowSessions).toEqual(['local-1']);

    const remoteSessions = await post(WEB_ROUTES.sessions, { agentId: 'hermes-local' });
    expect(remoteSessions.ok).toBe(true);
    expect(remoteSessions.value.sessions[0].id).toBe('remote-1');

    const doc = await post(WEB_ROUTES.doctor, { agent: 'hermes-local' });
    expect(doc.ok).toBe(true);
    expect(doc.value.agents[0].steps.every((s: any) => s.ok)).toBe(true);

    const job = manager.start('hermes-local', 'test', undefined);
    await new Promise((resolve) => setTimeout(resolve, 15));
    const responded = await post(WEB_ROUTES.respond, { jobId: job.id, choice: 'approve' });
    expect(responded.ok).toBe(true);
    expect(adapter.responded).toBe('approve');

    const cancelled = await post(WEB_ROUTES.cancel, { jobId: job.id });
    expect(cancelled.ok).toBe(true);
    expect(cancelled.value.status).toBe('cancelled');

    process.env.DSH_KNOT_STATE_DIR = mkdtempSync(join(tmpdir(), 'dsh-knot-store-'));
    const saved = await post(WEB_ROUTES.agentSave, {
      id: 'hermes-second',
      kind: 'hermes',
      transport: 'ssh',
      ssh: 'gpu-2',
      token: 'per-agent-secret-token',
    });
    expect(saved.ok).toBe(true);
    expect(saved.value.agents.map((a: any) => [a.id, a.hasToken])).toContainEqual(['hermes-second', true]);
    expect(JSON.stringify(saved)).not.toContain('per-agent-secret-token');

    const deleted = await post(WEB_ROUTES.agentDelete, { id: 'hermes-second' });
    expect(deleted.ok).toBe(true);
    expect(deleted.value.agents.map((a: any) => a.id)).not.toContain('hermes-second');
    await manager.close();
  });
});
