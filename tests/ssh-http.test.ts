import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { state, openSshSocket } = vi.hoisted(() => ({
  state: { port: 0 },
  openSshSocket: vi.fn(() => net.connect(state.port, '127.0.0.1')),
}));
vi.mock('../src/transports/stdio-socket.js', () => ({ openSshSocket }));

import { NodeHttpTransport } from '../src/transports/http.js';

let server: http.Server | undefined;
afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  openSshSocket.mockClear();
});

describe('SSH HTTP transport', () => {
  it('uses the custom connection factory instead of opening a local TCP socket', async () => {
    server = http.createServer((_request, response) => {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end('{"ok":true}');
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    state.port = (server.address() as AddressInfo).port;

    const transport = new NodeHttpTransport('ssh', {
      id: 'x',
      kind: 'hermes',
      transport: 'ssh',
      ssh: 'test-host',
      port: 8642,
    });
    const result = await transport.request({ path: '/health' });

    expect(result.status).toBe(200);
    expect(result.text).toBe('{"ok":true}');
    expect(openSshSocket).toHaveBeenCalledTimes(1);
  });
});
