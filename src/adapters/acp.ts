import { type ChildProcess, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { Readable, Writable } from 'node:stream';
import {
  type ActiveSession,
  type ActiveSessionMessage,
  type AgentCapabilities,
  type ClientConnection,
  client,
  methods,
  ndJsonStream,
  PROTOCOL_VERSION,
  type RequestPermissionResponse,
  type SessionUpdate,
} from '@agentclientprotocol/sdk';
import { createWebSocketStream, type WebSocketConstructor } from '@agentclientprotocol/sdk/experimental/ws-client';
import WebSocket from 'ws';
import { AsyncQueue } from '../async-queue.js';
import { secret } from '../config.js';
import { transportFor } from '../transports/http.js';
import { shellQuote, sshBaseArguments } from '../transports/stdio-socket.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';
import { VERSION } from '../version.js';

interface PendingPermission {
  sessionId: string;
  resolve: (response: RequestPermissionResponse) => void;
}

type PromptMessage = { kind: 'acp'; value: ActiveSessionMessage } | { kind: 'native'; value: AgentEvent };

export class AcpAdapter implements AgentAdapter {
  readonly kind = 'acp' as const;
  private readonly transport: Transport;
  private readonly queues = new Map<string, AsyncQueue<PromptMessage>>();
  private readonly activeSessions = new Map<string, ActiveSession>();
  private readonly sessionIds = new Map<string, string>();
  private readonly permissions = new Map<string, PendingPermission>();
  private readonly pumping = new Set<string>();
  private connection?: ClientConnection;
  private child?: ChildProcess;
  private connecting?: Promise<void>;
  private capabilities?: AgentCapabilities;

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
  ) {
    this.transport = transport ?? transportFor(config);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    await this.connect(signal);
    return { ok: true, protocol: 'acp', protocolVersion: PROTOCOL_VERSION, capabilities: this.capabilities };
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    await this.connect(signal);
    if (!this.capabilities?.sessionCapabilities?.list) return [];
    const result = await this.connection!.agent.request(
      methods.agent.session.list,
      {},
      {
        cancellationSignal: signal,
        stopWaitingOnCancel: true,
      },
    );
    return result.sessions.map((session) => ({
      id: session.sessionId,
      title: session.title ?? undefined,
      updatedAt: session.updatedAt ?? undefined,
    }));
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const alias = sessionId ?? randomUUID();
    let actualId = alias;
    let output = '';
    const queue = new AsyncQueue<PromptMessage>();
    try {
      await this.connect(signal);
      let active = this.activeSessions.get(alias);
      if (!active) {
        active = await this.connection!.agent.buildSession({ cwd: this.config.dshCwd ?? '/', mcpServers: [] }).start({
          cancellationSignal: signal,
          stopWaitingOnCancel: true,
        });
        actualId = active.sessionId;
        this.rememberSession(alias, actualId, active);
      } else {
        actualId = active.sessionId;
      }
      this.queues.set(actualId, queue);
      const completion = active.prompt(text, { cancellationSignal: signal, stopWaitingOnCancel: true });
      completion.catch((error) => {
        this.queues.get(actualId)?.push({
          kind: 'native',
          value: { type: 'error', text: error instanceof Error ? error.message : String(error) },
        });
      });
      this.pumpUpdates(actualId, active);
      while (true) {
        const next = await queue.next(signal);
        if (next.done) throw new Error('ACP event stream ended before the prompt completed');
        if (next.value.kind === 'acp') {
          if (next.value.value.kind === 'stop') {
            yield { type: 'final', text: output, stopReason: next.value.value.stopReason };
            return;
          }
          const event = acpEvent(next.value.value.update);
          if (!event) continue;
          if (event.type === 'text' && event.text) output += event.text;
          yield event;
        } else {
          const event = next.value.value;
          if (event.type === 'error') throw new Error(event.text ?? 'ACP agent failed');
          if (event.type === 'text' && event.text) output += event.text;
          yield event;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.cancel(actualId).catch(() => {});
        yield { type: 'final', text: output, stopReason: 'cancelled' };
      } else {
        yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
      }
    } finally {
      this.queues.delete(actualId);
      queue.finish();
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.connect(signal);
    const actualId = this.sessionIds.get(sessionId) ?? sessionId;
    await this.connection!.agent.notify(methods.agent.session.cancel, { sessionId: actualId });
    for (const [requestId, pending] of this.permissions) {
      if (pending.sessionId !== actualId) continue;
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.permissions.delete(requestId);
    }
  }

  async respond(sessionId: string, requestId: string, choice: string): Promise<void> {
    void sessionId;
    const pending = this.permissions.get(requestId);
    if (!pending) throw new Error(`No pending ACP permission request ${requestId}`);
    this.permissions.delete(requestId);
    pending.resolve({ outcome: { outcome: 'selected', optionId: choice } });
  }

  async close(): Promise<void> {
    for (const [requestId, pending] of this.permissions) {
      pending.resolve({ outcome: { outcome: 'cancelled' } });
      this.permissions.delete(requestId);
    }
    for (const queue of this.queues.values()) queue.finish();
    this.queues.clear();
    this.clearSessions();
    this.connection?.close();
    this.connection = undefined;
    this.connecting = undefined;
    await this.closeProcess();
    await this.transport.close();
  }

  private clearSessions(): void {
    for (const session of new Set(this.activeSessions.values())) session.dispose();
    this.activeSessions.clear();
    this.sessionIds.clear();
    this.pumping.clear();
  }

  private rememberSession(alias: string, actualId: string, active: ActiveSession): void {
    this.activeSessions.delete(alias);
    this.activeSessions.delete(actualId);
    this.activeSessions.set(alias, active);
    this.activeSessions.set(actualId, active);
    this.sessionIds.delete(alias);
    this.sessionIds.delete(actualId);
    this.sessionIds.set(alias, actualId);
    this.sessionIds.set(actualId, actualId);
    while (this.activeSessions.size > 500) {
      const oldestKey = this.activeSessions.keys().next().value;
      if (oldestKey === undefined) break;
      const evicted = this.activeSessions.get(oldestKey);
      this.activeSessions.delete(oldestKey);
      this.sessionIds.delete(oldestKey);
      if (evicted && ![...this.activeSessions.values()].includes(evicted)) {
        evicted.dispose();
      }
    }
  }

  private pumpUpdates(actualId: string, active: ActiveSession): void {
    if (this.pumping.has(actualId)) return;
    this.pumping.add(actualId);
    void (async () => {
      try {
        while (this.activeSessions.get(actualId) === active) {
          const value = await active.nextUpdate();
          this.queues.get(actualId)?.push({ kind: 'acp', value });
          if (value.kind === 'stop') break;
        }
      } catch (error) {
        this.queues.get(actualId)?.push({
          kind: 'native',
          value: { type: 'error', text: error instanceof Error ? error.message : String(error) },
        });
      } finally {
        this.pumping.delete(actualId);
      }
    })();
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (this.connection && !this.connection.signal.aborted) return;
    if (this.connecting) return this.connecting;
    this.connecting = this.open(signal)
      .catch(async (error) => {
        this.connection?.close();
        this.connection = undefined;
        await this.closeProcess();
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async open(signal?: AbortSignal): Promise<void> {
    this.clearSessions();
    await this.closeProcess();
    const stream = this.config.acpTransport === 'stdio' ? this.openStdio() : this.openWebSocket();
    const app = client({ name: 'dsh-knot' });
    app.onRequest(methods.client.session.requestPermission, ({ params }) => {
      const requestId = params.toolCall.toolCallId;
      this.queues.get(params.sessionId)?.push({
        kind: 'native',
        value: {
          type: 'approval',
          requestId,
          text: params.toolCall.title ?? 'Permission requested',
          choices: params.options.map((option) => option.optionId),
        },
      });
      return new Promise<RequestPermissionResponse>((resolve) => {
        this.permissions.set(requestId, { sessionId: params.sessionId, resolve });
      });
    });
    const connection = app.connect(stream);
    this.connection = connection;
    connection.closed.then(() => {
      if (this.connection === connection) this.clearSessions();
      for (const queue of this.queues.values()) queue.fail(new Error('ACP connection closed'));
      for (const [requestId, pending] of this.permissions) {
        pending.resolve({ outcome: { outcome: 'cancelled' } });
        this.permissions.delete(requestId);
      }
    });
    const initialized = await withTimeout(
      connection.agent.request(methods.agent.initialize, {
        protocolVersion: PROTOCOL_VERSION,
        clientInfo: { name: 'dsh-knot', version: VERSION },
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      }),
      this.config.connectTimeoutMs ?? 30_000,
      'ACP initialize',
      signal,
    );
    this.capabilities = initialized.agentCapabilities;
  }

  private openWebSocket() {
    const host = this.transport.kind === 'ssh' ? '127.0.0.1' : (this.config.host ?? '127.0.0.1');
    const protocol = this.transport.kind !== 'ssh' && this.config.tls ? 'wss' : 'ws';
    const token = secret(this.config);
    return createWebSocketStream(`${protocol}://${host}:${this.config.port ?? 18_792}/acp`, {
      WebSocket: acpWebSocketConstructor(this.transport),
      ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
    });
  }

  private openStdio() {
    const spec = acpStdioSpawnSpec(this.config);
    const child = spawn(spec.command, spec.args, { stdio: ['pipe', 'pipe', 'inherit'] });
    this.child = child;
    child.on('error', (error) => {
      for (const queue of this.queues.values()) queue.fail(error);
      child.stdin!.destroy();
      child.stdout!.destroy();
    });
    return ndJsonStream(
      Writable.toWeb(child.stdin!) as unknown as WritableStream<Uint8Array>,
      Readable.toWeb(child.stdout!) as unknown as ReadableStream<Uint8Array>,
    );
  }

  private async closeProcess(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    if (!child) return;
    child.stdin!.end();
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill();
    await Promise.race([once(child, 'exit'), new Promise((resolve) => setTimeout(resolve, 1000))]);
  }
}

function acpEvent(update: SessionUpdate): AgentEvent | undefined {
  if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
    return { type: 'text', text: update.content.text };
  }
  if (update.sessionUpdate === 'tool_call') {
    return {
      type: 'tool',
      phase: 'start',
      requestId: update.toolCallId,
      name: update.name ?? update.title,
    };
  }
  if (update.sessionUpdate === 'tool_call_update') {
    return {
      type: 'tool',
      phase: update.status === 'completed' || update.status === 'failed' ? 'end' : 'start',
      requestId: update.toolCallId,
      name: update.name ?? update.title ?? update.toolCallId,
    };
  }
  if (update.sessionUpdate === 'notice' && update.severity === 'error') {
    return { type: 'error', text: update.description ?? update.title };
  }
  return undefined;
}

function acpWebSocketConstructor(transport: Transport): WebSocketConstructor {
  if (transport.kind !== 'ssh') return WebSocket;
  return class AcpWebSocket extends WebSocket {
    constructor(url: string, protocols?: string | string[], options?: { headers?: Record<string, string> }) {
      super(url, protocols, { ...options, createConnection: () => transport.socket!() });
    }
  };
}

export function acpStdioSpawnSpec(config: AgentConfig): { command: string; args: string[] } {
  const command = config.acpCommand!;
  const args = config.acpArgs ?? [];
  if ((config.transport ?? 'ssh') !== 'ssh') return { command, args };
  const remoteCommand = [command, ...args].map(shellQuote).join(' ');
  return {
    command: 'ssh',
    args: [...sshBaseArguments(config), config.ssh!, '--', remoteCommand],
  };
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string, signal?: AbortSignal): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  const abort = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    if (signal?.aborted) reject(new Error(`${label} aborted`));
    else if (signal) {
      onAbort = () => reject(new Error(`${label} aborted`));
      signal.addEventListener('abort', onAbort, { once: true });
    }
  });
  try {
    return await Promise.race([promise, abort]);
  } finally {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  }
}
