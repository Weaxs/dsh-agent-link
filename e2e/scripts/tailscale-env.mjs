import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const command = process.env.E2E_TAILSCALE_SUDO === '1' ? 'sudo' : 'tailscale';
const args =
  process.env.E2E_TAILSCALE_SUDO === '1'
    ? ['tailscale', `--socket=${process.env.TS_SOCKET}`, 'status', '--json']
    : ['status', '--json'];
const { stdout } = await execute(command, args, { timeout: 20_000, maxBuffer: 8 * 1024 * 1024 });
const status = JSON.parse(stdout);
const peers = Object.values(status.Peer ?? {});

for (const kind of ['hermes', 'openclaw']) {
  const peer = peers.find((item) => item.HostName === `${kind}-e2e`);
  const ip = peer?.TailscaleIPs?.[0];
  if (!ip) throw new Error(`Tailscale peer ${kind}-e2e is not online or has no IPv4 address`);
  console.log(`export ${kind.toUpperCase()}_HOST=${ip}`);
}
