import { describe, expect, it } from 'vitest';
import { normalizeConfig } from '../src/config.js';
import { sshHint } from '../src/doctor.js';
import { redact, redactText } from '../src/policy/redact.js';
import { sshArguments } from '../src/transports/stdio-socket.js';

describe('configuration and policy', () => {
  it('defaults to SSH and assigns protocol ports', () => {
    const value = normalizeConfig({
      agents: [
        { id: 'hermes', kind: 'hermes', ssh: 'gpu' },
        { id: 'claw', kind: 'openclaw', ssh: 'claw' },
        { id: 'remote-dsh', kind: 'dsh', ssh: 'dsh' },
        { id: 'acp', kind: 'acp', ssh: 'acp' },
      ],
    });
    expect(value.agents.map((agent) => [agent.transport, agent.port])).toEqual([
      ['ssh', 8642],
      ['ssh', 18789],
      ['ssh', 18790],
      ['ssh', 18792],
    ]);
  });

  it('rejects duplicate ids, unsafe aliases and invalid ports', () => {
    expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'hermes', ssh: '-oProxyCommand=bad' }] })).toThrow(/ssh/);
    expect(() => normalizeConfig({ agents: [{ id: 'x', kind: 'hermes', transport: 'local', port: 0 }] })).toThrow(
      /port/,
    );
    expect(() =>
      normalizeConfig({
        agents: [{ id: 'x', kind: 'acp', transport: 'direct', acpTransport: 'stdio', acpCommand: 'agent' }],
      }),
    ).toThrow(/stdio/);
    expect(() =>
      normalizeConfig({
        agents: [
          { id: 'x', kind: 'hermes', ssh: 'a' },
          { id: 'x', kind: 'hermes', ssh: 'b' },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  it('uses OpenSSH options without a shell', () => {
    const args = sshArguments({ id: 'x', kind: 'hermes', ssh: 'gpu', port: 8642 });
    expect(args).toContain('BatchMode=yes');
    expect(args).toContain('ExitOnForwardFailure=yes');
    expect(args.slice(-3)).toEqual(['-W', '127.0.0.1:8642', 'gpu']);
  });

  it('supports an explicit SSH config file for isolated E2E credentials', () => {
    const args = sshArguments({ id: 'x', kind: 'hermes', ssh: 'gpu', sshConfig: '/tmp/e2e_ssh_config', port: 8642 });
    expect(args.slice(0, 2)).toEqual(['-F', '/tmp/e2e_ssh_config']);
  });

  it('redacts credentials recursively and safely handles circular objects', () => {
    expect(redactText('Bearer abcdefghijklmnop')).toBe('[REDACTED]');
    expect(redactText('Basic dXNlcjpwYXNzd29yZA==')).toBe('[REDACTED]');
    const cyclic: Record<string, unknown> = {
      access_token: 'abc',
      nested: { text: 'Bearer abcdefghijklmnop' },
      safe: 42,
    };
    cyclic.self = cyclic;
    const value = redact(cyclic);
    expect(value.access_token).toBe('[REDACTED]');
    expect((value.nested as { text: string }).text).not.toContain('abcdefghijklmnop');
    expect(value.safe).toBe(42);
    expect(value.self).toBe('[Circular]');
  });

  it('rejects wildcard MCP hosts', () => {
    expect(() => normalizeConfig({ mcp: { enabled: true, host: '0.0.0.0' } })).toThrow(/0\.0\.0\.0/);
    expect(() => normalizeConfig({ mcp: { enabled: true, host: '::' } })).toThrow(/::/);
  });

  it('maps common SSH failures to actionable hints', () => {
    expect(sshHint('Too many authentication failures')).toMatch(/IdentitiesOnly/);
    expect(sshHint('no matching host key type found. Their offer: ssh-rsa')).toMatch(/HostKeyAlgorithms/);
    expect(sshHint('Enter passphrase for key')).toMatch(/ssh-agent/);
  });
});
