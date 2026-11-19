import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentManager } from './manager.js';

const execute = promisify(execFile);

export interface DoctorStep {
  name: string;
  ok: boolean;
  detail: string;
  hint?: string;
}

export async function runDoctor(
  manager: AgentManager,
  only?: string,
): Promise<{ agents: Array<{ id: string; steps: DoctorStep[] }> }> {
  const configs = manager.configs.filter((config) => !only || config.id === only);
  if (only && configs.length === 0) throw new Error(`Unknown agent "${only}"`);
  return {
    agents: await Promise.all(
      configs.map(async (config) => {
        const steps: DoctorStep[] = [];
        if ((config.transport ?? 'ssh') === 'ssh') {
          const sshOptions = config.sshConfig ? ['-F', config.sshConfig] : [];
          try {
            const { stdout } = await execute('ssh', [...sshOptions, '-G', config.ssh!], {
              timeout: 10_000,
              maxBuffer: 2_000_000,
            });
            const picked = stdout
              .split('\n')
              .filter((line) => /^(hostname|user|port|identityfile|proxycommand|proxyjump) /.test(line));
            steps.push({ name: 'ssh-config', ok: true, detail: picked.join('\n') });
          } catch (error) {
            steps.push(failure('ssh-config', error));
            return { id: config.id, steps };
          }
          try {
            await execute(
              'ssh',
              [...sshOptions, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=10', config.ssh!, 'echo', 'ok'],
              {
                timeout: 15_000,
              },
            );
            steps.push({ name: 'ssh-login', ok: true, detail: 'Non-interactive SSH login succeeded.' });
          } catch (error) {
            steps.push(failure('ssh-login', error));
            return { id: config.id, steps };
          }
        } else if (config.transport === 'direct') {
          steps.push({
            name: 'direct-transport',
            ok: true,
            detail: `Connecting to ${config.host}:${config.port}. Keep the gateway on a trusted interface.`,
          });
        } else {
          steps.push({ name: 'local-transport', ok: true, detail: 'Using the local loopback transport.' });
        }
        try {
          const health = await manager.adapter(config.id).health();
          steps.push({ name: 'gateway-health', ok: true, detail: JSON.stringify(health) });
        } catch (error) {
          steps.push(failure('gateway-health', error));
        }
        return { id: config.id, steps };
      }),
    ),
  };
}

export function sshHint(text: string): string {
  const value = text.toLowerCase();
  if (value.includes('too many authentication failures'))
    return 'Set IdentitiesOnly yes and one IdentityFile for this host.';
  if (value.includes('permission denied'))
    return 'Check User, IdentityFile, and the authorized_keys entry on the server.';
  if (value.includes('unprotected private key')) return 'Run chmod 600 on the private key.';
  if (value.includes('invalid format') || value.includes('ppk'))
    return 'Convert a PuTTY .ppk key to OpenSSH format with puttygen.';
  if (value.includes('no matching host key type'))
    return 'For this host only, add the server-offered HostKeyAlgorithms and PubkeyAcceptedAlgorithms.';
  if (value.includes('no matching key exchange'))
    return 'For this host only, add the server-offered KexAlgorithms; plan a server upgrade.';
  if (value.includes('remote host identification has changed'))
    return 'Verify the server was reinstalled before replacing its known_hosts entry.';
  if (value.includes('host key verification failed')) return 'Connect once manually and verify the host fingerprint.';
  if (value.includes('could not resolve hostname')) return 'Check HostName and DNS in ~/.ssh/config.';
  if (value.includes('connection timed out')) return 'Check the address, security group, firewall, and TCP port 22.';
  if (value.includes('connection refused')) return 'Check sshd and the configured Port.';
  if (value.includes('passphrase'))
    return 'Add the private key to ssh-agent or the macOS keychain; background SSH cannot prompt.';
  if (value.includes('openclaw_session_token') || value.includes('openclaw_gateway_token'))
    return 'Set OPENCLAW_GATEWAY_TOKEN or configure tokenEnv.';
  if (value.includes('hermes_api_key')) return 'Set HERMES_API_KEY or configure tokenEnv.';
  if (value.includes('launch token') || value.includes('dsh_gateway_token'))
    return 'Copy the launch token from the remote dsh web URL into DSH_GATEWAY_TOKEN or configure tokenEnv.';
  return 'See docs/SSH.md. The plugin never changes ~/.ssh/config automatically.';
}

function failure(name: string, error: unknown): DoctorStep {
  const detail = error instanceof Error ? error.message : String(error);
  return { name, ok: false, detail, hint: sshHint(detail) };
}
