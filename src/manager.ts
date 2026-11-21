import { randomUUID } from 'node:crypto';
import { AcpAdapter } from './adapters/acp.js';
import { createNativeAdapter, createNativeSessionId } from './adapters/native.js';
import { secret } from './config.js';
import type { AgentAdapter, AgentConfig, AgentJob, PluginConfig } from './types.js';

export type AdapterFactory = (config: AgentConfig) => AgentAdapter;

const MAX_JOBS = 200;

export class AgentManager {
  readonly adapters = new Map<string, AgentAdapter>();
  readonly configs: AgentConfig[];
  private readonly factory: AdapterFactory;
  private readonly jobs = new Map<string, AgentJob>();
  private readonly completions = new Map<string, Promise<AgentJob>>();
  private readonly controllers = new Map<string, AbortController>();
  private readonly remoteCancelled = new Set<string>();

  constructor(
    configs: AgentConfig[],
    private readonly timeoutMs = 1_800_000,
    factory: AdapterFactory = defaultFactory,
  ) {
    this.configs = [...configs];
    this.factory = factory;
    for (const config of this.configs) this.adapters.set(config.id, this.factory(config));
  }

  list(): Array<
    Pick<
      AgentConfig,
      'id' | 'kind' | 'transport' | 'host' | 'ssh' | 'port' | 'tls' | 'acpTransport' | 'acpCommand' | 'model'
    > & {
      hasToken: boolean;
    }
  > {
    return this.configs.map(
      ({ id, kind, transport, host, ssh, port, tls, acpTransport, acpCommand, model, ...rest }) => ({
        id,
        kind,
        transport,
        host,
        ssh,
        port,
        tls,
        acpTransport,
        acpCommand,
        model,
        hasToken: Boolean(
          secret({ id, kind, transport, host, ssh, port, tls, acpTransport, acpCommand, model, ...rest }),
        ),
      }),
    );
  }

  getConfig(id: string): AgentConfig | undefined {
    return this.configs.find((item) => item.id === id);
  }

  async upsert(config: AgentConfig): Promise<void> {
    this.abortJobsForAgent(config.id);
    const existing = this.adapters.get(config.id);
    if (existing) await existing.close().catch(() => {});
    const index = this.configs.findIndex((item) => item.id === config.id);
    if (index >= 0) this.configs[index] = config;
    else this.configs.push(config);
    this.adapters.set(config.id, this.factory(config));
  }

  async remove(id: string): Promise<boolean> {
    this.abortJobsForAgent(id);
    const existing = this.adapters.get(id);
    if (!existing) return false;
    this.adapters.delete(id);
    const index = this.configs.findIndex((item) => item.id === id);
    if (index >= 0) this.configs.splice(index, 1);
    await existing.close().catch(() => {});
    return true;
  }

  adapter(id: string): AgentAdapter {
    const adapter = this.adapters.get(id);
    if (!adapter)
      throw new Error(`Unknown agent "${id}". Available: ${[...this.adapters.keys()].join(', ') || '(none)'}`);
    return adapter;
  }

  start(agentId: string, text: string, sessionId: string | undefined, onDone?: (job: AgentJob) => void): AgentJob {
    const adapter = this.adapter(agentId);
    const config = this.configs.find((item) => item.id === agentId)!;
    const remoteSession =
      sessionId ?? (adapter.kind === 'acp' || adapter.kind === 'dsh' ? undefined : createNativeSessionId(config));
    const id = randomUUID();
    const job: AgentJob = {
      id,
      agentId,
      ...(remoteSession ? { sessionId: remoteSession } : {}),
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: '',
    };
    this.jobs.set(id, job);
    this.evictFinishedJobs();
    const completion = this.run(job, adapter, text, remoteSession, onDone);
    this.completions.set(id, completion);
    completion
      .finally(() => {
        this.completions.delete(id);
        this.controllers.delete(id);
      })
      .catch(() => {});
    return job;
  }

  get(id: string): AgentJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job "${id}"`);
    return job;
  }

  listJobs(): AgentJob[] {
    return [...this.jobs.values()].sort((a, b) => b.updatedAt - a.updatedAt).map((job) => ({ ...job }));
  }

  async wait(id: string, signal?: AbortSignal): Promise<AgentJob> {
    const completion = this.completions.get(id);
    if (!completion) return this.get(id);
    if (!signal) return completion;
    if (signal.aborted) throw signal.reason ?? new Error('request aborted');
    let onAbort: (() => void) | undefined;
    try {
      return await Promise.race([
        completion,
        new Promise<never>((_, reject) => {
          onAbort = () => reject(signal.reason ?? new Error('request aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        }),
      ]);
    } finally {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    }
  }

  async cancel(id: string, signal?: AbortSignal): Promise<AgentJob> {
    const job = this.get(id);
    if (job.status === 'completed' || job.status === 'failed') return job;
    if (job.status === 'cancelled' && this.remoteCancelled.has(id)) return job;
    job.status = 'cancelled';
    delete job.pendingApproval;
    job.updatedAt = Date.now();
    this.controllers.get(id)?.abort(new Error('job cancelled'));
    const adapter = this.adapters.get(job.agentId);
    if (adapter && job.sessionId) {
      await adapter.cancel(job.sessionId, signal);
    }
    this.remoteCancelled.add(id);
    return job;
  }

  async respond(id: string, choice: string, signal?: AbortSignal, expectedRequestId?: string): Promise<AgentJob> {
    const job = this.get(id);
    const pending = job.pendingApproval;
    if (!pending) throw new Error(`Job ${id} has no pending approval`);
    if (expectedRequestId !== undefined && pending.requestId !== expectedRequestId) {
      throw new Error(
        `Approval request "${expectedRequestId}" is no longer pending on job ${id} (current: "${pending.requestId}")`,
      );
    }
    const adapter = this.adapter(job.agentId);
    if (!adapter.respond) throw new Error(`${job.agentId} does not support approval responses through this adapter`);
    await adapter.respond(job.sessionId!, pending.requestId, choice, signal);
    delete job.pendingApproval;
    job.updatedAt = Date.now();
    return job;
  }

  async close(): Promise<void> {
    for (const controller of this.controllers.values()) controller.abort(new Error('manager closed'));
    this.controllers.clear();
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.close()));
  }

  private abortJobsForAgent(agentId: string): void {
    for (const [id, job] of this.jobs) {
      if (job.agentId !== agentId || ['completed', 'failed', 'cancelled'].includes(job.status)) continue;
      job.status = 'cancelled';
      delete job.pendingApproval;
      job.updatedAt = Date.now();
      this.controllers.get(id)?.abort(new Error(`agent "${agentId}" reconfigured`));
    }
  }

  private evictFinishedJobs(): void {
    if (this.jobs.size <= MAX_JOBS) return;
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= MAX_JOBS) break;
      if (['completed', 'failed', 'cancelled'].includes(job.status)) {
        this.jobs.delete(id);
        this.remoteCancelled.delete(id);
      }
    }
  }

  private async run(
    job: AgentJob,
    adapter: AgentAdapter,
    text: string,
    sessionId: string | undefined,
    onDone?: (job: AgentJob) => void,
  ): Promise<AgentJob> {
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    const timer = setTimeout(() => {
      controller.abort(new Error(`job timed out after ${this.timeoutMs}ms`));
      if (job.sessionId) adapter.cancel(job.sessionId).catch(() => {});
    }, this.timeoutMs);
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      for await (const event of adapter.prompt(sessionId, text, controller.signal)) {
        if (event.sessionId) job.sessionId = event.sessionId;
        if (event.type === 'text' && event.text) job.text = (job.text + event.text).slice(-2_000_000);
        else if (event.type === 'approval') {
          job.pendingApproval = { requestId: event.requestId ?? '', choices: event.choices ?? [], text: event.text };
        } else if (event.type === 'error') throw new Error(event.text ?? 'remote agent failed');
        else if (event.type === 'final') {
          if (event.text) job.text = event.text.slice(-2_000_000);
          if (job.status === 'running') job.status = event.stopReason === 'cancelled' ? 'cancelled' : 'completed';
        }
        job.updatedAt = Date.now();
      }
      if (job.status === 'running') job.status = controller.signal.aborted ? 'cancelled' : 'completed';
    } catch (error) {
      job.status = controller.signal.aborted || job.status === 'cancelled' ? 'cancelled' : 'failed';
      job.error = error instanceof Error ? error.message : String(error);
    } finally {
      clearTimeout(timer);
      job.updatedAt = Date.now();
      if (onDone) {
        try {
          onDone({ ...job });
        } catch {
          /* notification failures do not change the remote job */
        }
      }
    }
    return job;
  }
}

function defaultFactory(config: AgentConfig): AgentAdapter {
  return config.kind === 'acp' ? new AcpAdapter(config.id, config) : createNativeAdapter(config);
}

export function fromConfig(config: PluginConfig): AgentManager {
  return new AgentManager(config.agents ?? [], config.jobTimeoutMs);
}
