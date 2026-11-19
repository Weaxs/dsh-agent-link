import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { StdioSocket } from '../src/transports/stdio-socket.js';

describe('StdioSocket', () => {
  it('reports the ssh stderr before ending the readable stream', async () => {
    const socket = new StdioSocket(
      spawn('sh', ['-c', 'echo "forwarding refused" >&2; exit 255'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      }),
    );
    let ended = false;
    socket.on('end', () => {
      ended = true;
    });
    socket.resume();
    const error = await new Promise<Error>((resolve) => socket.once('error', resolve));
    expect(error.message).toContain('forwarding refused');
    expect(ended).toBe(false);
  });
});
