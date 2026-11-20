import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyBearerToken } from '../policy/auth.js';
import { redact } from '../policy/redact.js';
import type { McpConfig } from '../types.js';
import { VERSION } from '../version.js';
import type { SessionControllerLike } from './session-service.js';

const PROTOCOL_VERSION = '2025-03-26';
const MAX_BATCH_SIZE = 50;

class BodyTooLargeError extends Error {}

export class McpServer {
  private server?: http.Server;
  private readonly allowed: Set<string>;
  private readonly token?: string;

  constructor(
    private readonly config: McpConfig,
    private readonly sessions: SessionControllerLike,
  ) {
    this.allowed = new Set(config.allowSessions ?? []);
    this.token = config.token ?? process.env[config.tokenEnv ?? 'DSH_AGENT_LINK_TOKEN'];
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('MCP server is already running');
    if (!this.token)
      throw new Error('MCP is enabled but no bearer token is configured (tokenEnv defaults to DSH_AGENT_LINK_TOKEN)');
    const host = this.config.host ?? '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') {
      throw new Error('MCP server must bind to loopback or a specific trusted address, never 0.0.0.0 or ::');
    }
    const port = this.config.port ?? 19_400;
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    return { host, port: address.port };
  }

  async close(): Promise<void> {
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/mcp') return json(response, 404, { error: 'Not found' });
    if (request.method !== 'POST') return json(response, 405, { error: 'Use JSON-RPC over POST' }, { Allow: 'POST' });
    if (!verifyBearerToken(request.headers.authorization, this.token!))
      return json(response, 401, { error: 'Unauthorized' });
    let message: any;
    try {
      message = JSON.parse((await readBody(request)).toString('utf8'));
    } catch (error) {
      if (error instanceof BodyTooLargeError) return json(response, 413, { error: error.message });
      return json(response, 400, { error: 'Invalid JSON' });
    }
    const batch = Array.isArray(message);
    const messages = batch ? message : [message];
    if (batch && messages.length > MAX_BATCH_SIZE) {
      return json(response, 400, { error: `JSON-RPC batch exceeds limit of ${MAX_BATCH_SIZE}` });
    }
    const replies = [];
    for (const item of messages) {
      const reply = await this.rpc(item);
      if (reply !== undefined) replies.push(reply);
    }
    if (replies.length === 0) {
      response.writeHead(202);
      response.end();
      return;
    }
    json(response, 200, batch ? replies : replies[0]);
  }

  private async rpc(message: any): Promise<Record<string, unknown> | undefined> {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return errorReply(message?.id, -32600, 'Invalid JSON-RPC request');
    const id = message.id;
    try {
      if (message.method === 'initialize')
        return resultReply(id, {
          protocolVersion:
            typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-agent-link', version: VERSION },
          instructions: 'Only sessions explicitly allow-listed by the local user are visible. All output is redacted.',
        });
      if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/'))
        return undefined;
      if (message.method === 'ping') return resultReply(id, {});
      if (message.method === 'tools/list') return resultReply(id, { tools: toolDefinitions() });
      if (message.method === 'tools/call') {
        const value = await this.callTool(String(message.params?.name ?? ''), message.params?.arguments ?? {});
        return resultReply(id, {
          content: [{ type: 'text', text: JSON.stringify(value) }],
          structuredContent: value,
        });
      }
      return errorReply(id, -32601, `Method not found: ${message.method}`);
    } catch (error) {
      return errorReply(id, -32000, error instanceof Error ? error.message : String(error));
    }
  }

  private async callTool(name: string, args: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (name === 'dsh_sessions_list') {
      const value = await this.sessions.list({}, new AbortController().signal);
      return {
        sessions: redact(
          value.items
            .filter((item) => this.allowed.has(String(item.sessionId)))
            .map((item) => ({
              sessionId: item.sessionId,
              title: item.title,
              cwd: item.cwd,
              lastActivity: item.lastActivity ?? item.updatedAt,
            })),
        ),
      };
    }
    const sessionId = String(args.sessionId ?? '');
    this.assertAllowed(sessionId);
    if (name === 'dsh_session_read') {
      const value = await this.sessions.events(
        {
          address: { kind: 'session', sessionId },
          ...(Number.isSafeInteger(args.beforeSeq) ? { beforeSeq: args.beforeSeq } : {}),
          maxMessages: bounded(args.maxMessages, 100, 1, 500),
        },
        new AbortController().signal,
      );
      return redact(value);
    }
    if (name === 'dsh_session_watch') {
      const timeoutMs = bounded(args.timeoutMs, 25_000, 1_000, 30_000);
      return this.watch(sessionId, timeoutMs, bounded(args.since, 0, 0, Number.MAX_SAFE_INTEGER));
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  private async watch(sessionId: string, timeoutMs: number, since: number): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const frames: unknown[] = [];
    let bytes = 0;
    let cursor = since;
    try {
      for await (const frame of this.sessions.follow(
        { address: { kind: 'session', sessionId }, activate: false, maxMessages: 100 },
        controller.signal,
      )) {
        if (frame.type === 'assistant-stream') continue;
        if (frame.type === 'snapshot' && typeof frame.cursor === 'number') cursor = Math.max(cursor, frame.cursor);
        const event = frame.event as { seq?: number } | undefined;
        if (typeof event?.seq === 'number') {
          cursor = Math.max(cursor, event.seq);
          if (event.seq <= since) continue;
        }
        const projected =
          frame.type === 'snapshot' && since > 0 && Array.isArray(frame.records)
            ? {
                ...frame,
                records: frame.records.filter(
                  (record: any) => typeof record.event?.seq !== 'number' || record.event.seq > since,
                ),
              }
            : frame;
        const safe = redact(projected);
        bytes += JSON.stringify(safe).length;
        frames.push(safe);
        if (controller.signal.aborted || bytes >= (this.config.maxEventBytes ?? 1_000_000)) break;
        if (frame.type === 'event' && timeoutMs > 0) break;
      }
    } catch (error) {
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
    }
    return { sessionId, cursor, frames, timedOut: controller.signal.aborted };
  }

  private assertAllowed(sessionId: string): void {
    if (!this.allowed.has(sessionId))
      throw new Error(
        'This session is not shared. Add its exact id to mcp.allowSessions in the local dsh configuration.',
      );
  }
}

function toolDefinitions(): Array<Record<string, unknown>> {
  return [
    {
      name: 'dsh_sessions_list',
      description: 'List local DeepSeek Harness sessions explicitly shared by the user.',
      inputSchema: { type: 'object', properties: {}, additionalProperties: false },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'dsh_session_read',
      description: 'Read a message-aligned page from one shared DeepSeek Harness session.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          beforeSeq: { type: 'integer' },
          maxMessages: { type: 'integer', minimum: 1, maximum: 500 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
    {
      name: 'dsh_session_watch',
      description: 'Wait for new events in one shared DeepSeek Harness session and return a cursor for the next call.',
      inputSchema: {
        type: 'object',
        properties: {
          sessionId: { type: 'string' },
          since: { type: 'integer', minimum: 0, description: 'Return durable events after this sequence cursor.' },
          timeoutMs: { type: 'integer', minimum: 1000, maximum: 30000 },
        },
        required: ['sessionId'],
        additionalProperties: false,
      },
      annotations: { readOnlyHint: true },
    },
  ];
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}

function resultReply(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function errorReply(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function json(response: ServerResponse, status: number, value: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers });
  response.end(JSON.stringify(value));
}

async function readBody(request: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new BodyTooLargeError('Request body is too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
