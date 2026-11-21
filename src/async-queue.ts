export class AsyncQueue<T> {
  private values: T[] = [];
  private waiters: Array<{
    resolve: (result: IteratorResult<T>) => void;
    reject: (error: unknown) => void;
    cleanup?: () => void;
  }> = [];
  private error: unknown;
  private done = false;

  constructor(
    private readonly maxBuffer = 0,
    private readonly overflow: 'drop-oldest' | 'error' = 'drop-oldest',
  ) {}

  push(value: T): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter.cleanup?.();
      waiter.resolve({ value, done: false });
    } else {
      if (this.maxBuffer > 0 && this.values.length >= this.maxBuffer) {
        if (this.overflow === 'error') {
          this.fail(new Error(`Event queue overflow: exceeded ${this.maxBuffer} buffered events`));
          return;
        }
        this.values.shift();
      }
      this.values.push(value);
    }
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup?.();
      waiter.resolve({ value: undefined, done: true });
    }
  }

  fail(error: unknown): void {
    if (this.done) return;
    this.error = error;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter.cleanup?.();
      waiter.reject(error);
    }
  }

  async next(signal?: AbortSignal): Promise<IteratorResult<T>> {
    const value = this.values.shift();
    if (value !== undefined) return { value, done: false };
    if (this.error !== undefined) throw this.error;
    if (this.done) return { value: undefined, done: true };
    if (signal?.aborted) throw signal.reason ?? new Error('aborted');
    return new Promise<IteratorResult<T>>((resolve, reject) => {
      const waiter: {
        resolve: (result: IteratorResult<T>) => void;
        reject: (error: unknown) => void;
        cleanup?: () => void;
      } = { resolve, reject };
      if (signal) {
        const onAbort = () => {
          const index = this.waiters.indexOf(waiter);
          if (index >= 0) this.waiters.splice(index, 1);
          reject(signal.reason ?? new Error('aborted'));
        };
        signal.addEventListener('abort', onAbort, { once: true });
        waiter.cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.waiters.push(waiter);
    });
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return this;
  }
}
