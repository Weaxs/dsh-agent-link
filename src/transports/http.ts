import http, { type IncomingMessage, type RequestOptions } from 'node:http';
import https from 'node:https';
import type { Socket } from 'node:net';
import type { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
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
      const chunks: Buffer[] = [];
      let bytes = 0;
      for await (const chunk of response) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        bytes += buffer.length;
        if (bytes > MAX_BODY) throw new Error(`response exceeds ${MAX_BODY} bytes`);
        chunks.push(buffer);
      }
      const text = Buffer.concat(chunks).toString('utf8');
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
    const customAgent = factory ? new http.Agent() : undefined;
    if (customAgent && factory) customAgent.createConnection = factory as unknown as () => Socket;
    const options: RequestOptions = {
      protocol: secure ? 'https:' : 'http:',
      host,
      port: this.config.port,
      method: input.method ?? 'GET',
      path: input.path,
      agent: customAgent ?? false,
      headers: {
        Accept: 'application/json, text/event-stream',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
        ...input.headers,
      },
    };
    const driver = secure ? https : http;
    return new Promise<IncomingMessage>((resolve, reject) => {
      const request = driver.request(options, (response) => {
        request.setTimeout(0);
        if ((response.statusCode ?? 500) >= 400) {
          const decoder = new StringDecoder('utf8');
          let detail = '';
          response.on('data', (chunk: Buffer) => {
            detail = (detail + decoder.write(chunk)).slice(-16_384);
          });
          response.on('error', reject);
          response.on('end', () => {
            detail = (detail + decoder.end()).slice(-16_384);
            reject(new Error(`HTTP ${response.statusCode}: ${detail || response.statusMessage || 'request failed'}`));
          });
          return;
        }
        resolve(response);
      });
      if (this.kind !== 'ssh' && this.config.connectTimeoutMs) {
        request.setTimeout(this.config.connectTimeoutMs, () => {
          request.destroy(new Error(`request timed out after ${this.config.connectTimeoutMs}ms`));
        });
      }
      request.on('error', reject);
      const signal = input.signal;
      const abort = () => request.destroy(new Error('request aborted'));
      if (signal?.aborted) request.destroy(new Error('request aborted'));
      else signal?.addEventListener('abort', abort, { once: true });
      responseCleanup(request, () => {
        signal?.removeEventListener('abort', abort);
        customAgent?.destroy();
      });
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
