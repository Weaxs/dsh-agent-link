import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import type { AgentConfig, HttpRequest, HttpResponse, Transport } from '../types.js';
import { openSshSocket } from './stdio-socket.js';

const MAX_BODY = 16 * 1024 * 1024;

export class NodeHttpTransport implements Transport {
  constructor(
    readonly kind: 'ssh' | 'direct' | 'local',
    private readonly config: AgentConfig,
  ) {}

  async request(input: HttpRequest): Promise<HttpResponse> {
    const response = await this.stream(input);
    try {
      let text = '';
      for await (const chunk of response) {
        text += chunk.toString('utf8');
        if (text.length > MAX_BODY) throw new Error(`response exceeds ${MAX_BODY} bytes`);
      }
      const headers = Object.fromEntries(
        Object.entries(response.headers).filter(([key]) => key.toLowerCase() !== 'authorization'),
      );
      return { status: response.statusCode ?? 0, headers, text };
    } finally {
      response.destroy();
    }
  }

  async stream(input: HttpRequest): Promise<IncomingMessage> {
    const payload = input.body === undefined ? undefined : Buffer.from(JSON.stringify(input.body));
    const host = this.kind === 'ssh' ? '127.0.0.1' : (this.config.host ?? '127.0.0.1');
    const secure = this.kind !== 'ssh' && this.config.tls === true;
    const factory = this.kind === 'ssh' ? () => openSshSocket(this.config) : undefined;
    const options: RequestOptions = {
      protocol: secure ? 'https:' : 'http:',
      host,
      port: this.config.port,
      method: input.method ?? 'GET',
      path: input.path,
      agent: false,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...input.headers,
      },
      ...(factory ? { createConnection: factory as unknown as () => Socket } : {}),
    };
    const driver = secure ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = driver.request(options, (response) => {
        if ((response.statusCode ?? 500) >= 400) {
          let detail = '';
          response.on('data', (chunk: Buffer) => {
            detail = (detail + chunk.toString('utf8')).slice(-16_384);
          });
          response.on('end', () =>
            reject(new Error(`HTTP ${response.statusCode}: ${detail || response.statusMessage || 'request failed'}`)),
          );
          return;
        }
        resolve(response);
      });
      request.on('error', reject);
      const signal = input.signal;
      const abort = () => request.destroy(new Error('request aborted'));
      if (signal?.aborted) request.destroy(new Error('request aborted'));
      else signal?.addEventListener('abort', abort, { once: true });
      responseCleanup(request, () => signal?.removeEventListener('abort', abort));
      request.end(payload);
    });
  }

  socket(): Duplex {
    if (this.kind !== 'ssh') throw new Error('custom sockets are only used by the ssh transport');
    return openSshSocket(this.config);
  }

  async close(): Promise<void> {}
}

function responseCleanup(request: http.ClientRequest, cleanup: () => void): void {
  request.on('close', cleanup);
  request.on('response', (response) => response.on('close', cleanup));
}

export function transportFor(config: AgentConfig): NodeHttpTransport {
  return new NodeHttpTransport(config.transport ?? 'ssh', config);
}
