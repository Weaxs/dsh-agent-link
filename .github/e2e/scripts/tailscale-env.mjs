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
const suffix = process.env.E2E_NODE_SUFFIX ?? 'local';

const targets = (process.env.E2E_TARGET ?? 'hermes,openclaw').split(',').filter(Boolean);
for (const kind of targets) {
  const hostname = `${kind}-e2e-${suffix}`;
  const peer = peers.find((item) => item.HostName === hostname);
  const ip = peer?.TailscaleIPs?.[0];
  if (!ip) throw new Error(`Tailscale peer ${hostname} is not online or has no IPv4 address`);
  console.log(`export ${kind.toUpperCase()}_HOST=${ip}`);
}
