import { type ChildProcess, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import type { AgentConfig } from '../types.js';

export function sshArguments(config: AgentConfig): string[] {
  if (!config.ssh) throw new Error(`${config.id}: an SSH host alias is required`);
  return [
    ...(config.sshConfig ? ['-F', config.sshConfig] : []),
    '-T',
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${Math.ceil((config.connectTimeoutMs ?? 15_000) / 1_000)}`,
    '-o',
    'ExitOnForwardFailure=yes',
    '-o',
    'ServerAliveInterval=30',
    '-o',
    'ServerAliveCountMax=3',
    '-W',
    `127.0.0.1:${config.port}`,
    config.ssh,
  ];
}

export class StdioSocket extends Duplex {
  readonly child: ChildProcess;
  private stderr = '';

  constructor(child: ChildProcess) {
    super();
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => this.push(chunk));
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString('utf8')).slice(-8_192);
    });
    child.on('error', (error) => this.destroy(error));
    child.on('close', (code) => {
      if (code !== 0 && !this.destroyed) this.destroy(new Error(this.stderr.trim() || `ssh exited with code ${code}`));
      else this.push(null);
    });
  }

  override _read(): void {}

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.child.stdin?.writable) {
      callback(new Error('ssh stdin is closed'));
      return;
    }
    this.child.stdin.write(chunk, encoding, callback);
  }

  override _final(callback: (error?: Error | null) => void): void {
    this.child.stdin?.end();
    callback();
  }

  override _destroy(error: Error | null, callback: (error?: Error | null) => void): void {
    this.child.kill('SIGTERM');
    callback(error);
  }

  setTimeout(_timeout: number): this {
    return this;
  }
  setNoDelay(_noDelay?: boolean): this {
    return this;
  }
  setKeepAlive(_enable?: boolean, _initialDelay?: number): this {
    return this;
  }
  ref(): this {
    this.child.ref();
    return this;
  }
  unref(): this {
    this.child.unref();
    return this;
  }
}

export function openSshSocket(config: AgentConfig): StdioSocket {
  return new StdioSocket(
    spawn('ssh', sshArguments(config), {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    }),
  );
}
