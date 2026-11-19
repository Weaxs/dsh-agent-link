import { randomUUID } from 'node:crypto';
import { HermesAdapter } from './adapters/hermes.js';
import { OpenClawAdapter } from './adapters/openclaw.js';
import type { AgentAdapter, AgentConfig, AgentJob, PluginConfig } from './types.js';

export type AdapterFactory = (config: AgentConfig) => AgentAdapter;

export class AgentManager {
  readonly adapters = new Map<string, AgentAdapter>();
  private readonly jobs = new Map<string, AgentJob>();
  private readonly completions = new Map<string, Promise<AgentJob>>();

  constructor(
    readonly configs: AgentConfig[],
    private readonly timeoutMs = 1_800_000,
    factory: AdapterFactory = defaultFactory,
  ) {
    for (const config of configs) this.adapters.set(config.id, factory(config));
  }

  list(): Array<Pick<AgentConfig, 'id' | 'kind' | 'transport' | 'host' | 'ssh' | 'port'>> {
    return this.configs.map(({ id, kind, transport, host, ssh, port }) => ({ id, kind, transport, host, ssh, port }));
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
      sessionId ??
      (adapter.kind === 'hermes'
        ? `dsh_${randomUUID()}`
        : `agent:${config.openclawAgentId ?? 'main'}:dsh-agent-link:${randomUUID()}`);
    const id = randomUUID();
    const job: AgentJob = {
      id,
      agentId,
      sessionId: remoteSession,
      status: 'queued',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      text: '',
    };
    this.jobs.set(id, job);
    const completion = this.run(job, adapter, text, remoteSession, onDone);
    this.completions.set(id, completion);
    completion.finally(() => this.completions.delete(id)).catch(() => {});
    return job;
  }

  get(id: string): AgentJob {
    const job = this.jobs.get(id);
    if (!job) throw new Error(`Unknown job "${id}"`);
    return job;
  }

  async wait(id: string): Promise<AgentJob> {
    return this.completions.get(id) ?? this.get(id);
  }

  async cancel(id: string): Promise<AgentJob> {
    const job = this.get(id);
    if (['completed', 'failed', 'cancelled'].includes(job.status)) return job;
    await this.adapter(job.agentId).cancel(job.sessionId!);
    job.status = 'cancelled';
    job.updatedAt = Date.now();
    return job;
  }

  async respond(id: string, choice: string): Promise<AgentJob> {
    const job = this.get(id);
    const pending = job.pendingApproval;
    if (!pending) throw new Error(`Job ${id} has no pending approval`);
    const adapter = this.adapter(job.agentId);
    if (!adapter.respond) throw new Error(`${job.agentId} does not support approval responses through this adapter`);
    await adapter.respond(job.sessionId!, pending.requestId, choice);
    delete job.pendingApproval;
    job.updatedAt = Date.now();
    return job;
  }

  async close(): Promise<void> {
    await Promise.allSettled([...this.adapters.values()].map((adapter) => adapter.close()));
  }

  private async run(
    job: AgentJob,
    adapter: AgentAdapter,
    text: string,
    sessionId: string,
    onDone?: (job: AgentJob) => void,
  ): Promise<AgentJob> {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      controller.abort(new Error(`job timed out after ${this.timeoutMs}ms`));
      adapter.cancel(sessionId).catch(() => {});
    }, this.timeoutMs);
    job.status = 'running';
    job.updatedAt = Date.now();
    try {
      for await (const event of adapter.prompt(sessionId, text, controller.signal)) {
        if (event.type === 'text' && event.text) job.text = (job.text + event.text).slice(-2_000_000);
        else if (event.type === 'approval') {
          job.pendingApproval = { requestId: event.requestId ?? '', choices: event.choices ?? [], text: event.text };
        } else if (event.type === 'error') throw new Error(event.text ?? 'remote agent failed');
        else if (event.type === 'final') {
          if (event.text) job.text = event.text;
          job.status = 'completed';
        }
        job.updatedAt = Date.now();
      }
      if (job.status === 'running') job.status = 'completed';
    } catch (error) {
      job.status = controller.signal.aborted ? 'cancelled' : 'failed';
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
  return config.kind === 'hermes' ? new HermesAdapter(config.id, config) : new OpenClawAdapter(config.id, config);
}

export function fromConfig(config: PluginConfig): AgentManager {
  return new AgentManager(config.agents ?? [], config.jobTimeoutMs);
}
