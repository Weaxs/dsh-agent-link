import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { verifyBearerToken } from '../policy/auth.js';
import { redact } from '../policy/redact.js';
import type { McpConfig } from '../types.js';
import { VERSION } from '../version.js';
import type { SessionControllerLike } from './session-service.js';

const PROTOCOL_VERSION = '2025-03-26';
const SUPPORTED_PROTOCOL_VERSIONS = new Set(['2025-03-26', '2024-11-05']);
const MAX_BATCH_SIZE = 50;

class BodyTooLargeError extends Error {}

export class McpServer {
  private server?: http.Server;
  private serverAbort?: AbortController;
  private boundAddress?: { host: string; port: number };
  private readonly allowed: Set<string>;
  private readonly activeWatches = new Map<string, Set<AbortController>>();
  private readonly token?: string;

  constructor(
    private readonly config: McpConfig,
    private readonly sessions: SessionControllerLike,
  ) {
    this.allowed = new Set(config.allowSessions ?? []);
    this.token = config.token ?? process.env[config.tokenEnv ?? 'DSH_KNOT_TOKEN'];
  }

  async start(): Promise<{ host: string; port: number }> {
    if (this.server) throw new Error('MCP server is already running');
    if (!this.token)
      throw new Error('MCP is enabled but no bearer token is configured (tokenEnv defaults to DSH_KNOT_TOKEN)');
    const host = this.config.host ?? '127.0.0.1';
    if (host === '0.0.0.0' || host === '::') {
      throw new Error('MCP server must bind to loopback or a specific trusted address, never 0.0.0.0 or ::');
    }
    const port = this.config.port ?? 19_400;
    this.serverAbort = new AbortController();
    this.server = http.createServer((request, response) => {
      this.handle(request, response).catch((error) => {
        if (!response.headersSent) response.writeHead(500, { 'Content-Type': 'application/json' });
        if (!response.writableEnded)
          response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(port, host, () => resolve());
    });
    const address = this.server.address() as AddressInfo;
    this.boundAddress = { host, port: address.port };
    return this.boundAddress;
  }

  get address(): { host: string; port: number } | undefined {
    return this.boundAddress;
  }

  listAllowed(): string[] {
    return [...this.allowed];
  }

  setAllowed(sessionId: string, allow: boolean): void {
    if (!sessionId) return;
    if (allow) {
      this.allowed.add(sessionId);
    } else {
      this.allowed.delete(sessionId);
      const controllers = this.activeWatches.get(sessionId);
      if (controllers) {
        for (const controller of controllers) controller.abort(new Error('Session sharing was revoked'));
      }
    }
  }

  async close(): Promise<void> {
    this.serverAbort?.abort(new Error('MCP server closed'));
    this.serverAbort = undefined;
    if (!this.server) return;
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => this.server!.close(() => resolve()));
    this.server = undefined;
    this.boundAddress = undefined;
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    response.setHeader('Cache-Control', 'no-store');
    const pathname = new URL(request.url ?? '/', 'http://localhost').pathname;
    if (pathname !== '/mcp') return json(response, 404, { error: 'Not found' });
    if (request.method !== 'POST') return json(response, 405, { error: 'Use JSON-RPC over POST' }, { Allow: 'POST' });
    if (!this.isAllowedOrigin(request.headers.origin)) {
      return json(response, 403, { error: 'Forbidden origin' });
    }
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
    const requestAbort = new AbortController();
    const onServerAbort = () => requestAbort.abort(this.serverAbort?.signal.reason ?? new Error('MCP server closed'));
    const onResponseClose = () => {
      if (!response.writableEnded) requestAbort.abort(new Error('client disconnected'));
    };
    this.serverAbort?.signal.addEventListener('abort', onServerAbort, { once: true });
    response.once('close', onResponseClose);
    try {
      const entries: Array<{
        reply: Record<string, unknown>;
        id: unknown;
        sessionId?: string;
        isList?: boolean;
      }> = [];
      for (const item of messages) {
        if (requestAbort.signal.aborted) break;
        const reply = await this.rpc(item, requestAbort.signal);
        if (reply !== undefined) {
          const toolName = item?.method === 'tools/call' ? String(item.params?.name ?? '') : '';
          const sessionId =
            toolName === 'dsh_session_read' || toolName === 'dsh_session_watch'
              ? String(item.params?.arguments?.sessionId ?? '')
              : undefined;
          entries.push({ reply, id: item?.id, sessionId, isList: toolName === 'dsh_sessions_list' });
        }
      }
      if (response.writableEnded || requestAbort.signal.aborted) return;
      const replies = entries.map((entry) => {
        if (entry.sessionId && !this.allowed.has(entry.sessionId)) {
          return errorReply(
            entry.id,
            -32000,
            'This session is not shared. Add its exact id to mcp.allowSessions in the local dsh configuration.',
          );
        }
        if (entry.isList && entry.reply.result && typeof entry.reply.result === 'object') {
          const res = entry.reply.result as { structuredContent?: { sessions?: Array<{ sessionId?: unknown }> } };
          if (Array.isArray(res.structuredContent?.sessions)) {
            const filtered = {
              sessions: res.structuredContent.sessions.filter((item) => this.allowed.has(String(item.sessionId ?? ''))),
            };
            return resultReply(entry.id, {
              content: [{ type: 'text', text: JSON.stringify(filtered) }],
              structuredContent: filtered,
            });
          }
        }
        return entry.reply;
      });
      if (replies.length === 0) {
        response.writeHead(202);
        response.end();
        return;
      }
      json(response, 200, batch ? replies : replies[0]);
    } finally {
      this.serverAbort?.signal.removeEventListener('abort', onServerAbort);
      response.off('close', onResponseClose);
    }
  }

  private async rpc(message: any, signal: AbortSignal): Promise<Record<string, unknown> | undefined> {
    if (message?.jsonrpc !== '2.0' || typeof message.method !== 'string')
      return errorReply(message?.id, -32600, 'Invalid JSON-RPC request');
    const id = message.id;
    try {
      if (message.method === 'initialize') {
        const requested = typeof message.params?.protocolVersion === 'string' ? message.params.protocolVersion : '';
        const protocolVersion = SUPPORTED_PROTOCOL_VERSIONS.has(requested) ? requested : PROTOCOL_VERSION;
        return resultReply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'dsh-knot', version: VERSION },
          instructions: 'Only sessions explicitly allow-listed by the local user are visible. All output is redacted.',
        });
      }
      if (message.method === 'notifications/initialized' || message.method.startsWith('notifications/'))
        return undefined;
      if (message.method === 'ping') return resultReply(id, {});
      if (message.method === 'tools/list') return resultReply(id, { tools: toolDefinitions() });
      if (message.method === 'tools/call') {
        const value = await this.callTool(String(message.params?.name ?? ''), message.params?.arguments ?? {}, signal);
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

  private async callTool(
    name: string,
    args: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    if (name === 'dsh_sessions_list') {
      const value = await this.sessions.list({}, signal);
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
        signal,
      );
      this.assertAllowed(sessionId);
      return redact(value);
    }
    if (name === 'dsh_session_watch') {
      const timeoutMs = bounded(args.timeoutMs, 25_000, 1_000, 30_000);
      return this.watch(sessionId, timeoutMs, bounded(args.since, 0, 0, Number.MAX_SAFE_INTEGER), signal);
    }
    throw new Error(`Unknown tool: ${name}`);
  }

  private async watch(
    sessionId: string,
    timeoutMs: number,
    since: number,
    signal: AbortSignal,
  ): Promise<Record<string, unknown>> {
    const controller = new AbortController();
    let set = this.activeWatches.get(sessionId);
    if (!set) {
      set = new Set();
      this.activeWatches.set(sessionId, set);
    }
    set.add(controller);
    let timedOut = false;
    const onParentAbort = () => controller.abort(signal.reason ?? new Error('aborted'));
    if (signal.aborted) onParentAbort();
    else signal.addEventListener('abort', onParentAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    const frames: unknown[] = [];
    let bytes = 0;
    let cursor = since;
    try {
      for await (const frame of this.sessions.follow(
        { address: { kind: 'session', sessionId }, activate: false, maxMessages: 100 },
        controller.signal,
      )) {
        this.assertAllowed(sessionId);
        if (frame.type === 'assistant-stream') continue;
        const event = frame.event as { seq?: number } | undefined;
        if (typeof event?.seq === 'number') {
          cursor = Math.max(cursor, event.seq);
          if (event.seq <= since) continue;
        }
        let projected: Record<string, unknown> = frame;
        let stopAfterFrame = false;
        if (frame.type === 'snapshot') {
          const snapRecords = Array.isArray(frame.records) ? frame.records : [];
          if (since > 0) {
            const filtered = snapRecords.filter(
              (record: any) => typeof record?.event?.seq !== 'number' || record.event.seq > since,
            );
            const seqs = snapRecords
              .map((record: any) => record?.event?.seq)
              .filter((seq: unknown): seq is number => typeof seq === 'number');
            let earliest = seqs.length > 0 ? Math.min(...seqs) : undefined;
            const collectedOlder: unknown[] = [];
            let incompleteGap = false;
            if (earliest !== undefined && earliest > since + 1) {
              let beforeSeq: number | undefined = earliest;
              let pages = 0;
              while (beforeSeq !== undefined && beforeSeq > since + 1 && pages < 50) {
                pages++;
                const older = await this.sessions.events(
                  { address: { kind: 'session', sessionId }, beforeSeq, maxMessages: 100 },
                  controller.signal,
                );
                this.assertAllowed(sessionId);
                const pageRecords = Array.isArray(older.records) ? older.records : [];
                const relevant = pageRecords.filter(
                  (record: any) =>
                    typeof record?.event?.seq === 'number' && record.event.seq > since && record.event.seq < beforeSeq!,
                );
                collectedOlder.unshift(...relevant);
                const pageSeqs = pageRecords
                  .map((record: any) => record?.event?.seq)
                  .filter((seq: unknown): seq is number => typeof seq === 'number');
                const minPageSeq = pageSeqs.length > 0 ? Math.min(...pageSeqs) : undefined;
                if (!older.hasMore || minPageSeq === undefined || minPageSeq <= since + 1) {
                  earliest = minPageSeq ?? earliest;
                  break;
                }
                if (minPageSeq >= beforeSeq) {
                  incompleteGap = true;
                  break;
                }
                beforeSeq = minPageSeq;
                earliest = minPageSeq;
                if (pages === 50) incompleteGap = true;
              }
            }
            const combined = [...collectedOlder, ...filtered];
            const limit = this.config.maxEventBytes ?? 1_000_000;
            if (incompleteGap) {
              projected = {
                ...frame,
                records: [],
                hasMore: true,
                gapDetected: true,
                ...(earliest !== undefined ? { nextBeforeSeq: earliest } : {}),
              };
              stopAfterFrame = true;
            } else {
              const fitted: unknown[] = [];
              let fittedBytes = 0;
              let truncated = false;
              for (const rec of combined) {
                const safeRec = redact(rec);
                const recSize = JSON.stringify(safeRec).length;
                if (fitted.length > 0 && bytes + fittedBytes + recSize > limit) {
                  truncated = true;
                  break;
                }
                fitted.push(safeRec);
                fittedBytes += recSize;
                const recSeq = (rec as { event?: { seq?: number } })?.event?.seq;
                if (typeof recSeq === 'number') cursor = Math.max(cursor, recSeq);
              }
              if (!truncated && typeof frame.cursor === 'number') {
                cursor = Math.max(cursor, frame.cursor);
              }
              projected = { ...frame, records: fitted, ...(truncated ? { hasMore: true } : {}) };
              if (truncated) stopAfterFrame = true;
            }
          } else if (typeof frame.cursor === 'number') {
            cursor = Math.max(cursor, frame.cursor);
          }
        }
        const safe = redact(projected);
        bytes += JSON.stringify(safe).length;
        frames.push(safe);
        if (stopAfterFrame || controller.signal.aborted || bytes >= (this.config.maxEventBytes ?? 1_000_000)) break;
        if (frame.type === 'event' && timeoutMs > 0) break;
      }
    } catch (error) {
      if (!this.allowed.has(sessionId)) this.assertAllowed(sessionId);
      if (!controller.signal.aborted) throw error;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onParentAbort);
      set.delete(controller);
      if (set.size === 0) this.activeWatches.delete(sessionId);
    }
    this.assertAllowed(sessionId);
    return { sessionId, cursor, frames, timedOut };
  }

  private isAllowedOrigin(origin: string | undefined): boolean {
    if (!origin) return true;
    try {
      const url = new URL(origin);
      if (url.protocol !== 'http:' && url.protocol !== 'https:') return false;
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const boundHost = this.boundAddress?.host.replace(/^\[|\]$/g, '');
      return (
        host === 'localhost' || host === '127.0.0.1' || host === '::1' || (Boolean(boundHost) && host === boundHost)
      );
    } catch {
      return false;
    }
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
