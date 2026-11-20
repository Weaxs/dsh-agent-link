import { type ChildProcess, spawn } from 'node:child_process';
import { Duplex } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';
import type { AgentConfig } from '../types.js';

export function sshBaseArguments(config: AgentConfig): string[] {
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
  ];
}

export function sshArguments(config: AgentConfig): string[] {
  return [...sshBaseArguments(config), '-W', `127.0.0.1:${config.port}`, config.ssh!];
}

export function shellQuote(argument: string): string {
  return `'${argument.replaceAll("'", "'\\''")}'`;
}

export class StdioSocket extends Duplex {
  readonly child: ChildProcess;
  private stderr = '';
  private readonly stderrDecoder = new StringDecoder('utf8');

  constructor(child: ChildProcess) {
    super();
    this.child = child;
    child.stdout?.on('data', (chunk: Buffer) => {
      if (!this.push(chunk)) child.stdout?.pause();
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      this.stderr = (this.stderr + this.stderrDecoder.write(chunk)).slice(-8_192);
    });
    child.on('error', (error) => this.destroy(error));
    child.on('close', (code) => {
      this.stderr = (this.stderr + this.stderrDecoder.end()).slice(-8_192);
      if (code !== 0 && !this.destroyed) this.destroy(new Error(this.stderr.trim() || `ssh exited with code ${code}`));
      else this.push(null);
    });
  }

  override _read(): void {
    this.child.stdout?.resume();
  }

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
