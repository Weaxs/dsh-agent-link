import { describe, expect, it } from 'vitest';
import { AgentManager } from '../src/manager.js';
import type { AgentAdapter, AgentConfig, AgentEvent } from '../src/types.js';

class FakeAdapter implements AgentAdapter {
  readonly kind = 'hermes' as const;
  cancelled = false;
  constructor(readonly id: string) {}
  async health() {
    return { ok: true };
  }
  async listSessions() {
    return [];
  }
  async *prompt(session: string | undefined, _text?: string, _signal?: AbortSignal): AsyncIterable<AgentEvent> {
    void session;
    yield { type: 'text', text: 'part ' };
    yield { type: 'approval', requestId: 'r1', choices: ['once', 'deny'], text: 'Run bash?' };
    yield { type: 'final', text: 'part done' };
  }
  async cancel() {
    this.cancelled = true;
  }
  async respond(_session: string, _request: string, choice: string) {
    expect(choice).toBe('once');
  }
  async close() {}
}

const config: AgentConfig = { id: 'remote', kind: 'hermes', ssh: 'box' };

describe('AgentManager', () => {
  it('tracks jobs, approvals and completion notifications', async () => {
    const adapter = new FakeAdapter('remote');
    const manager = new AgentManager([config], 10_000, () => adapter);
    let notified = false;
    const job = manager.start('remote', 'work', undefined, () => {
      notified = true;
    });
    expect(job.sessionId).toMatch(/^dsh_/);
    const completed = await manager.wait(job.id);
    expect(completed.status).toBe('completed');
    expect(completed.text).toBe('part done');
    expect(notified).toBe(true);
    await expect(manager.respond(job.id, 'once', undefined, 'wrong-request')).rejects.toThrow(/no longer pending/);
    await manager.respond(job.id, 'once', undefined, 'r1');
    expect(manager.get(job.id).pendingApproval).toBeUndefined();
  });

  it('retries remote cancellation after a gateway failure', async () => {
    let cancelAttempts = 0;
    class FlakyCancelAdapter extends FakeAdapter {
      override async *prompt(
        session: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: '', sessionId: session ?? 'live-session-1' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      override async cancel() {
        cancelAttempts++;
        if (cancelAttempts === 1) throw new Error('temporary gateway error');
        this.cancelled = true;
      }
    }
    const adapter = new FlakyCancelAdapter('remote');
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start('remote', 'work', undefined);
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.cancel(job.id)).rejects.toThrow(/temporary gateway error/);
    expect(cancelAttempts).toBe(1);
    const retried = await manager.cancel(job.id);
    expect(retried.status).toBe('cancelled');
    expect(cancelAttempts).toBe(2);
    expect(adapter.cancelled).toBe(true);

    // Once a newer job starts on the same session, retrying cancel on a superseded job is rejected
    cancelAttempts = 0;
    adapter.cancelled = false;
    const oldJob = manager.start('remote', 'turn 1', 'shared-session');
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.cancel(oldJob.id)).rejects.toThrow(/temporary gateway error/);
    const newerJob = manager.start('remote', 'turn 2', 'shared-session');
    await new Promise((r) => setTimeout(r, 10));
    await expect(manager.cancel(oldJob.id)).rejects.toThrow(/newer job/);
    expect(cancelAttempts).toBe(1);
    expect(manager.get(newerJob.id).status).toBe('running');
    await manager.cancel(newerJob.id);
    expect(cancelAttempts).toBe(2);
  });

  it('clears only the handled pendingApproval when a newer approval arrives mid-respond', async () => {
    let releaseRespond!: () => void;
    class SlowRespondAdapter extends FakeAdapter {
      override async *prompt(): AsyncIterable<AgentEvent> {
        yield { type: 'approval', requestId: 'r1', choices: ['once', 'deny'], text: 'First?' };
        await new Promise((r) => setTimeout(r, 15));
        yield { type: 'approval', requestId: 'r2', choices: ['once', 'deny'], text: 'Second?' };
        await new Promise((r) => setTimeout(r, 30));
        yield { type: 'final', text: 'done' };
      }
      override async respond() {
        await new Promise<void>((resolve) => {
          releaseRespond = resolve;
        });
      }
    }
    const manager = new AgentManager([config], 10_000, () => new SlowRespondAdapter('remote'));
    const job = manager.start('remote', 'work', 'sess-a');
    await new Promise((r) => setTimeout(r, 5));
    const responding = manager.respond(job.id, 'once', undefined, 'r1');
    await new Promise((r) => setTimeout(r, 20));
    expect(manager.get(job.id).pendingApproval?.requestId).toBe('r2');
    releaseRespond();
    await responding;
    expect(manager.get(job.id).pendingApproval?.requestId).toBe('r2');
    await manager.wait(job.id);
  });

  it('does not remotely cancel a newer job on the same session when an older job times out', async () => {
    let remoteCancels = 0;
    class HangingSessionAdapter extends FakeAdapter {
      override async *prompt(
        _session: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      }
      override async cancel() {
        remoteCancels++;
      }
    }
    const manager = new AgentManager([config], 40, () => new HangingSessionAdapter('remote'));
    const oldJob = manager.start('remote', 'turn 1', 'timeout-session');
    const newJob = manager.start('remote', 'turn 2', 'timeout-session');
    await new Promise((r) => setTimeout(r, 60));
    expect(manager.get(oldJob.id).status).toBe('cancelled');
    // Only the latest job's own timeout may call adapter.cancel (at most 1, never from oldJob)
    expect(remoteCancels).toBeLessThanOrEqual(1);
    await manager.wait(newJob.id);
  });

  it('cancels active work, aborts local stream and rejects unknown agents', async () => {
    let aborted = false;
    class HangingAdapter extends FakeAdapter {
      override async *prompt(
        _session: string | undefined,
        _text: string,
        signal?: AbortSignal,
      ): AsyncIterable<AgentEvent> {
        yield { type: 'text', text: 'partial' };
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            aborted = true;
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => {
            aborted = true;
            resolve();
          });
        });
      }
    }
    const adapter = new HangingAdapter('remote');
    const manager = new AgentManager([config], 10_000, () => adapter);
    const job = manager.start('remote', 'work', 'session-1');
    expect((await manager.cancel(job.id)).status).toBe('cancelled');
    const settled = await manager.wait(job.id);
    expect(settled.status).toBe('cancelled');
    expect(aborted).toBe(true);
    expect(adapter.cancelled).toBe(true);
    expect(() => manager.start('missing', 'x', undefined)).toThrow(/Unknown agent/);
  });
});
