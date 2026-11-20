import { afterEach, describe, expect, it } from 'vitest';
import { McpServer } from '../src/mcp/server.js';
import type { SessionControllerLike } from '../src/mcp/session-service.js';

const sessions: SessionControllerLike = {
  async list() {
    return {
      items: [
        { sessionId: 'shared', title: 'Shared', cwd: '/work' },
        { sessionId: 'private', title: 'Private', cwd: '/secret' },
      ],
    };
  },
  async events(request) {
    return {
      records: [
        { type: 'event', event: { type: 'assistant/message', seq: 4, data: { text: 'Bearer abcdefghijklmnop' } } },
      ],
      hasMore: false,
      address: request.address,
    };
  },
  async *follow() {
    yield { type: 'snapshot', cursor: 3, records: [] };
    yield { type: 'event', event: { type: 'assistant/message', seq: 4, data: { text: 'new message' } } };
  },
};

let server: McpServer | undefined;
let base = '';
afterEach(async () => {
  await server?.close();
  server = undefined;
});

async function start(): Promise<void> {
  server = new McpServer({ port: 0, token: 'test-token', allowSessions: ['shared'] }, sessions);
  const address = await server.start();
  base = `http://${address.host}:${address.port}/mcp`;
}

async function rpc(method: string, params: unknown = {}, id = 1): Promise<any> {
  const response = await fetch(base, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  return response.json();
}

describe('read-only MCP endpoint', () => {
  it('requires a bearer token', async () => {
    await start();
    const response = await fetch(base, { method: 'POST', body: '{}' });
    expect(response.status).toBe(401);
  });

  it('initializes and lists only allow-listed sessions', async () => {
    await start();
    expect((await rpc('initialize', { protocolVersion: '2025-03-26' })).result.serverInfo.name).toBe('dsh-knot');
    const tools = await rpc('tools/list');
    expect(tools.result.tools.map((tool: any) => tool.name)).toContain('dsh_session_watch');
    const result = await rpc('tools/call', { name: 'dsh_sessions_list', arguments: {} });
    const data = result.result.structuredContent;
    expect(data.sessions).toHaveLength(1);
    expect(data.sessions[0].sessionId).toBe('shared');
  });

  it('redacts reads, watches events and denies private sessions', async () => {
    await start();
    const read = await rpc('tools/call', { name: 'dsh_session_read', arguments: { sessionId: 'shared' } });
    expect(JSON.stringify(read)).not.toContain('abcdefghijklmnop');
    const watch = await rpc('tools/call', {
      name: 'dsh_session_watch',
      arguments: { sessionId: 'shared', timeoutMs: 1000 },
    });
    expect(watch.result.structuredContent.cursor).toBe(4);
    const resumed = await rpc('tools/call', {
      name: 'dsh_session_watch',
      arguments: { sessionId: 'shared', since: 4, timeoutMs: 1000 },
    });
    expect(resumed.result.structuredContent.frames.some((frame: any) => frame.type === 'event')).toBe(false);
    const denied = await rpc('tools/call', { name: 'dsh_session_read', arguments: { sessionId: 'private' } });
    expect(denied.error.message).toMatch(/not shared/);
  });

  it('rejects wildcard hosts, oversized bodies with 413, and oversized batches', async () => {
    const wildcard = new McpServer({ host: '0.0.0.0', port: 0, token: 'test-token' }, sessions);
    await expect(wildcard.start()).rejects.toThrow(/0\.0\.0\.0/);

    await start();
    const oversized = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: 'x'.repeat(1_000_001),
    });
    expect(oversized.status).toBe(413);

    const bigBatch = await fetch(base, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer test-token' },
      body: JSON.stringify(Array.from({ length: 51 }, (_, i) => ({ jsonrpc: '2.0', id: i, method: 'ping' }))),
    });
    expect(bigBatch.status).toBe(400);
  });
});
