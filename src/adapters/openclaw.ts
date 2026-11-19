import { randomUUID } from 'node:crypto';
import { secret } from '../config.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';
import { GatewayWebSocket } from './gateway-ws.js';
import { loadOrCreateIdentity, signClaim } from './openclaw-identity.js';

export class OpenClawAdapter implements AgentAdapter {
  readonly kind = 'openclaw' as const;
  private readonly transport: Transport;
  private readonly gateway: GatewayWebSocket;
  private ready = false;
  private connecting?: Promise<void>;

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
    gateway?: GatewayWebSocket,
  ) {
    this.transport = transport ?? transportFor(config);
    this.gateway = gateway ?? new GatewayWebSocket(this.transport, config.connectTimeoutMs ?? 30_000);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    await abortable(this.connect(), signal);
    return this.gateway.request('health', {}, remaining(15_000, signal));
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    await abortable(this.connect(), signal);
    const value = await this.gateway.request('sessions.list', {}, remaining(30_000, signal));
    const rows = Array.isArray(value) ? value : (value.items ?? value.sessions ?? []);
    return (Array.isArray(rows) ? rows : [])
      .map((row: Record<string, any>) => ({
        id: String(row.sessionKey ?? row.key ?? row.id ?? row.sessionId ?? ''),
        ...(row.title === undefined && row.displayName === undefined
          ? {}
          : { title: String(row.title ?? row.displayName) }),
        ...(row.updatedAt === undefined ? {} : { updatedAt: row.updatedAt }),
      }))
      .filter((row: AgentSession) => row.id);
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    await abortable(this.connect(), signal);
    if (sessionId) {
      await this.gateway.request(
        'sessions.create',
        {
          key: sessionId,
          ...(this.config.openclawAgentId ? { agentId: this.config.openclawAgentId } : {}),
          idempotencyKey: randomUUID(),
        },
        remaining(60_000, signal),
      );
    }
    const started = await this.gateway.request(
      'agent',
      {
        message: text,
        ...(sessionId ? { sessionKey: sessionId } : {}),
        ...(this.config.openclawAgentId ? { agentId: this.config.openclawAgentId } : {}),
        idempotencyKey: randomUUID(),
      },
      remaining(60_000, signal),
    );
    const runId = String(started.runId ?? started.run_id ?? started.id ?? '');
    const sessionKey = String(started.sessionKey ?? started.session_key ?? sessionId ?? '');
    if (!runId) throw new Error(`OpenClaw did not return a run id: ${JSON.stringify(started)}`);
    let completed = this.gateway.request('agent.wait', { runId }, 1_800_000);
    completed.catch(() => {});
    let output = '';
    while (true) {
      const next = this.gateway.nextEvent();
      const result = await Promise.race([
        completed.then((value) => ({ kind: 'done' as const, value })),
        next.then((value) => ({ kind: 'event' as const, value })),
      ]);
      if (result.kind === 'done') {
        if (result.value.status === 'pending' || result.value.status === 'timeout') {
          completed = this.gateway.request('agent.wait', { runId }, 1_800_000);
          completed.catch(() => {});
          continue;
        }
        const textResult = textOf(result.value.output ?? result.value.result ?? result.value.message ?? result.value);
        yield { type: 'final', text: textResult || output, stopReason: String(result.value.status ?? 'completed') };
        return;
      }
      if (result.value.done) throw new Error('OpenClaw event stream ended before the run completed');
      const frame = result.value.value;
      const payload = frame.payload ?? frame.data ?? frame;
      const eventRun = String(payload.runId ?? payload.run_id ?? '');
      if (eventRun && eventRun !== runId) continue;
      const eventName = String(payload.event ?? payload.type ?? frame.event ?? '');
      const delta = textOf(payload.delta ?? payload.textDelta ?? payload.content);
      if (delta) {
        output += delta;
        yield { type: 'text', text: delta };
      }
      if (/approval|permission/.test(eventName)) {
        yield {
          type: 'approval',
          requestId: String(payload.requestId ?? payload.id ?? ''),
          text: String(payload.description ?? payload.command ?? 'Approval requested'),
          choices: [],
        };
      } else if (/tool/.test(eventName)) {
        yield {
          type: 'tool',
          phase: /end|complete|finish/.test(eventName) ? 'end' : 'start',
          name: String(payload.name ?? payload.toolName ?? 'tool'),
        };
      }
      if (sessionKey) (payload as Record<string, unknown>).sessionKey ??= sessionKey;
      if (signal?.aborted) {
        await this.cancel(sessionKey, signal).catch(() => {});
        return;
      }
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await abortable(this.connect(), signal);
    await this.gateway.request('sessions.abort', { key: sessionId }, remaining(30_000, signal));
  }

  async close(): Promise<void> {
    this.ready = false;
    await this.gateway.close();
    await this.transport.close();
  }

  private async connect(): Promise<void> {
    if (this.ready && this.gateway.isOpen) return;
    this.ready = false;
    if (this.connecting) return this.connecting;
    this.connecting = this.handshake()
      .catch(async (error) => {
        await this.gateway.close();
        throw error;
      })
      .finally(() => {
        this.connecting = undefined;
      });
    return this.connecting;
  }

  private async handshake(): Promise<void> {
    const token = secret(this.config);
    if (!token) throw new Error(`${this.id}: set tokenEnv (default OPENCLAW_GATEWAY_TOKEN) for the OpenClaw gateway`);
    const host = this.transport.kind === 'ssh' ? '127.0.0.1' : (this.config.host ?? '127.0.0.1');
    const port = this.config.port ?? 18_789;
    const origin = this.config.origin ?? `http://${host}:${port}`;
    await this.gateway.openWebSocket({
      host,
      port,
      tls: this.transport.kind !== 'ssh' && this.config.tls === true,
      origin,
    });
    const identity = loadOrCreateIdentity(this.id);
    const challenge = await withTimeout(
      this.gateway.nextEvent(),
      this.config.connectTimeoutMs ?? 30_000,
      'OpenClaw pairing challenge',
    );
    if (challenge.done) throw new Error('OpenClaw closed before pairing completed');
    const event = challenge.value;
    if (event.event !== 'connect.challenge') throw new Error(`Unexpected OpenClaw handshake event: ${event.event}`);
    const signedAt = Number(event.payload?.ts);
    if (!Number.isSafeInteger(signedAt) || signedAt < 0) throw new Error('OpenClaw challenge is missing a valid ts');
    await this.pairAgain(identity, token, String(event.payload?.nonce ?? ''), signedAt);
    this.ready = true;
  }

  private async pairAgain(
    identity: ReturnType<typeof loadOrCreateIdentity>,
    token: string,
    nonce: string,
    signedAt: number,
  ): Promise<Record<string, any>> {
    const signature = signClaim(identity, nonce, token, signedAt);
    return this.gateway.request('connect', {
      minProtocol: 4,
      maxProtocol: 4,
      client: { id: 'openclaw-control-ui', version: 'control-ui', platform: 'web', mode: 'webchat' },
      role: 'operator',
      scopes: ['operator.admin', 'operator.read', 'operator.write', 'operator.approvals', 'operator.pairing'],
      auth: { token },
      device: { id: identity.deviceId, publicKey: identity.publicKey.x, signature, nonce, signedAt },
    });
  }
}

function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(textOf).join('');
  if (value && typeof value === 'object') {
    const row = value as Record<string, unknown>;
    return textOf(row.text ?? row.content ?? row.output_text ?? row.output ?? row.message);
  }
  return '';
}

function remaining(ms: number, signal?: AbortSignal): number {
  if (signal?.aborted) throw new Error('request aborted');
  return ms;
}

async function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function abortable(promise: Promise<void>, signal?: AbortSignal): Promise<void> {
  if (!signal) return promise;
  if (signal.aborted) throw new Error('request aborted');
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      signal.addEventListener('abort', () => reject(new Error('request aborted')), { once: true }),
    ),
  ]);
}
