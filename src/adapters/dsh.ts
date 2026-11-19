import { randomUUID } from 'node:crypto';
import { secret } from '../config.js';
import { transportFor } from '../transports/http.js';
import type { AgentAdapter, AgentConfig, AgentEvent, AgentSession, Transport } from '../types.js';

export class DshAdapter implements AgentAdapter {
  readonly kind = 'dsh' as const;
  private readonly transport: Transport;
  private cookie?: string;
  private readonly cursors = new Map<string, number>();
  private readonly sessionIds = new Map<string, string>();

  constructor(
    readonly id: string,
    private readonly config: AgentConfig,
    transport?: Transport,
  ) {
    this.transport = transport ?? transportFor(config);
  }

  async health(signal?: AbortSignal): Promise<Record<string, unknown>> {
    const value = await this.rpc('list', {}, signal);
    return { ok: true, sessions: Array.isArray(value.items) ? value.items.length : 0 };
  }

  async listSessions(signal?: AbortSignal): Promise<AgentSession[]> {
    const value = await this.rpc('list', {}, signal);
    return (value.items ?? [])
      .map((item: any) => ({
        id: String(item.sessionId ?? item.id ?? ''),
        title: item.title ? String(item.title) : undefined,
        updatedAt: item.lastActivity ?? item.updatedAt,
      }))
      .filter((item: AgentSession) => item.id);
  }

  async *prompt(sessionId: string | undefined, text: string, signal?: AbortSignal): AsyncIterable<AgentEvent> {
    const requestedId = sessionId ?? randomUUID();
    let actualId = this.sessionIds.get(requestedId) ?? requestedId;
    try {
      if (!this.sessionIds.has(requestedId)) {
        const created = await this.rpc(
          'create',
          {
            sessionId: requestedId,
            ...(this.config.dshCwd ? { cwd: this.config.dshCwd } : {}),
          },
          signal,
        );
        actualId = String(created.sessionId ?? requestedId);
        this.sessionIds.set(requestedId, actualId);
        this.sessionIds.set(actualId, actualId);
      }
      if (this.config.model) {
        await this.rpc(
          'selectModel',
          {
            sessionId: actualId,
            provider: this.config.dshProvider ?? 'openai',
            model: this.config.model,
            ...(this.config.reasoningEffort ? { reasoningEffort: this.config.reasoningEffort } : {}),
          },
          signal,
        );
      }
      const requestId = randomUUID();
      await this.rpc(
        'prompt',
        {
          requestId,
          sessionId: actualId,
          mode: 'queue',
          content: [{ type: 'text', text }],
          clientTimeZone: 'UTC',
        },
        signal,
      );

      let output = '';
      while (true) {
        const afterSeq = this.cursors.get(actualId) ?? 0;
        const waited = await this.rpc(
          'wait',
          {
            sessionId: actualId,
            timeoutMs: 30_000,
            afterSeq,
            maxMessages: 20,
          },
          signal,
        );
        const records = waited.output?.records ?? [];
        for (const record of records) {
          const text = assistantText(record);
          if (text && text !== output) {
            output = text;
            yield { type: 'text', text };
          }
        }
        const cursor = Number(waited.state?.cursor ?? afterSeq);
        if (records.length === 0 && waited.reason !== 'timeout') {
          const page = await this.rpc(
            'events',
            {
              address: { kind: 'session', sessionId: actualId },
              throughSeq: cursor,
              maxMessages: 50,
            },
            signal,
          );
          const failure = durableFailure(page.records ?? []);
          if (failure) throw new Error(failure);
        }
        this.cursors.set(actualId, Math.max(afterSeq, cursor));
        if (waited.reason !== 'timeout') {
          yield { type: 'final', text: output, stopReason: String(waited.reason ?? 'idle') };
          return;
        }
      }
    } catch (error) {
      if (signal?.aborted) {
        await this.cancel(actualId).catch(() => {});
        yield { type: 'final', text: '', stopReason: 'cancelled' };
        return;
      }
      yield { type: 'error', text: error instanceof Error ? error.message : String(error) };
    }
  }

  async cancel(sessionId: string, signal?: AbortSignal): Promise<void> {
    await this.rpc('cancel', { sessionId: this.sessionIds.get(sessionId) ?? sessionId }, signal);
  }

  async close(): Promise<void> {
    await this.transport.close();
  }

  private async connect(signal?: AbortSignal): Promise<void> {
    if (this.cookie) return;
    const token = secret(this.config);
    if (!token) throw new Error(`${this.id}: a dsh web launch token is required (token or tokenEnv)`);
    const response = await this.transport.request({
      path: `/connect?token=${encodeURIComponent(token)}&interactions=none`,
      signal,
    });
    if (response.status !== 302) throw new Error(`DSH /connect returned HTTP ${response.status}: ${response.text}`);
    const header = response.headers['set-cookie'];
    const cookie = Array.isArray(header) ? header[0] : header;
    const pair = cookie?.split(';', 1)[0]?.trim();
    if (!pair) throw new Error('DSH /connect did not return an API cookie');
    this.cookie = pair;
  }

  private async rpc(method: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<any> {
    await this.connect(signal);
    const response = await this.transport.request({
      method: 'POST',
      path: `/api/session/${method}`,
      headers: { Cookie: this.cookie! },
      body: {
        type: 'client-request',
        rpcId: randomUUID(),
        method: `session/${method}`,
        payload: { args: method === 'list' ? { _request: args } : { request: args } },
      },
      signal,
    });
    const envelope = JSON.parse(response.text);
    const result = envelope.result;
    if (result?.ok !== true) {
      const error = result?.error;
      throw new Error(`${error?.code ?? 'dsh/rpc'}: ${error?.message ?? response.text}`);
    }
    return result.value;
  }
}

function durableFailure(records: any[]): string | undefined {
  for (const record of records) {
    const event = record?.event ?? record;
    if (event?.type === 'turn/end' && event.data?.reason?.kind === 'error') {
      return String(event.data.reason.error?.message ?? 'Remote DSH turn failed');
    }
    if (event?.type === 'assistant/attempt') {
      for (const frame of event.data?.stream ?? []) {
        const reason = frame?.chunk?.reason;
        if (frame?.chunk?.type === 'finish' && reason?.kind === 'error') {
          return String(reason.failure?.message ?? 'Remote DSH model attempt failed');
        }
      }
    }
  }
  return undefined;
}

function assistantText(record: any): string {
  const event = record?.event ?? record;
  if (event?.type !== 'assistant/message') return '';
  const content = event.data?.message?.content ?? event.data?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part) => (part?.type === 'text' ? String(part.text ?? '') : '')).join('');
}
