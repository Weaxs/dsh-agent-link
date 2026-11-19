import { randomUUID } from 'node:crypto';
import WebSocket, { type RawData } from 'ws';
import { AsyncQueue } from '../async-queue.js';
import type { Transport } from '../types.js';

interface Pending {
  resolve: (value: Record<string, any>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export class GatewayWebSocket {
  private ws?: WebSocket;
  private readonly pending = new Map<string, Pending>();
  private events = new AsyncQueue<Record<string, any>>();
  private connected = false;

  constructor(
    private readonly transport: Transport,
    private readonly timeoutMs = 30_000,
  ) {}

  get isOpen(): boolean {
    return this.connected;
  }

  async openWebSocket(options: { host: string; port: number; tls?: boolean; origin: string }): Promise<void> {
    if (this.connected) return;
    this.events = new AsyncQueue<Record<string, any>>();
    const protocol = options.tls ? 'wss' : 'ws';
    const ws = new WebSocket(`${protocol}://${options.host}:${options.port}/`, 'json', {
      origin: options.origin,
      handshakeTimeout: this.timeoutMs,
      ...(this.transport.kind === 'ssh' && this.transport.socket
        ? { createConnection: () => this.transport.socket!() }
        : {}),
    });
    this.ws = ws;
    ws.on('message', (data) => this.message(data));
    ws.on('error', (error) => {
      if (this.ws === ws) this.fail(error);
    });
    ws.on('close', () => {
      if (this.ws === ws) this.fail(new Error('Gateway WebSocket closed'));
    });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Gateway WebSocket upgrade timed out')), this.timeoutMs);
      ws.once('open', () => {
        clearTimeout(timer);
        this.connected = true;
        resolve();
      });
      ws.once('error', (error) => {
        clearTimeout(timer);
        reject(error);
      });
    });
  }

  request(
    method: string,
    params: Record<string, unknown> = {},
    timeoutMs = this.timeoutMs,
  ): Promise<Record<string, any>> {
    if (!this.connected || !this.ws) return Promise.reject(new Error('Gateway is not connected'));
    const id = randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws!.send(JSON.stringify({ type: 'req', id, method, params }), (error) => {
        if (error) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(error);
        }
      });
    });
  }

  async nextEvent(): Promise<IteratorResult<Record<string, any>>> {
    return this.events.next();
  }

  async close(): Promise<void> {
    this.connected = false;
    this.ws?.close();
    this.ws = undefined;
    this.events.finish();
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Gateway connection closed'));
      this.pending.delete(id);
    }
  }

  private message(data: RawData): void {
    let frame: Record<string, any>;
    try {
      frame = JSON.parse(data.toString());
    } catch {
      return;
    }
    if (frame.type === 'event') {
      this.events.push(frame);
      return;
    }
    if (frame.type === 'res' && typeof frame.id === 'string') {
      const pending = this.pending.get(frame.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(frame.id);
        if (frame.ok === false)
          pending.reject(new Error(frame.error?.message ?? frame.error?.code ?? 'Gateway request failed'));
        else pending.resolve(frame.payload ?? {});
      }
      return;
    }
    if (frame.type === 'req' && typeof frame.id === 'string') {
      this.ws?.send(
        JSON.stringify({
          type: 'res',
          id: frame.id,
          ok: false,
          error: { code: 'NOT_SUPPORTED', message: 'This client does not serve reverse requests' },
        }),
      );
    }
  }

  private fail(error: Error): void {
    this.connected = false;
    this.events.fail(error);
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
