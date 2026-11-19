import { createHash, createPrivateKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface DeviceIdentity {
  deviceId: string;
  privateKey: JsonWebKey;
  publicKey: JsonWebKey;
  signedAtMs: number;
}

export function loadOrCreateIdentity(agentId: string, root = defaultRoot()): DeviceIdentity {
  const file = join(root, `${agentId}.json`);
  try {
    const value = JSON.parse(readFileSync(file, 'utf8')) as DeviceIdentity;
    if (value.deviceId && value.privateKey && value.publicKey) return value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
      throw new Error(`Cannot read device identity ${file}: ${(error as Error).message}`);
  }
  const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
    publicKeyEncoding: { format: 'jwk' },
    privateKeyEncoding: { format: 'jwk' },
  }) as { publicKey: JsonWebKey; privateKey: JsonWebKey };
  const identity: DeviceIdentity = {
    deviceId: createHash('sha256').update(Buffer.from(publicKey.x!, 'base64url')).digest('hex'),
    publicKey,
    privateKey,
    signedAtMs: Date.now(),
  };
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(identity, null, 2), { mode: 0o600 });
  renameSync(temporary, file);
  return identity;
}

export function signClaim(
  identity: DeviceIdentity,
  nonce: string,
  token: string,
  signedAt = identity.signedAtMs,
): string {
  const payload = [
    'v2',
    identity.deviceId,
    'cli',
    'operator',
    'operator',
    'operator.admin,operator.read,operator.write,operator.approvals,operator.pairing',
    String(signedAt),
    token,
    nonce,
  ].join('|');
  return sign(
    null,
    Buffer.from(payload),
    createPrivateKey({ key: identity.privateKey as any, format: 'jwk' }),
  ).toString('base64url');
}

function defaultRoot(): string {
  return join(
    process.env.DSH_AGENT_LINK_STATE_DIR ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'agent-link'),
    'devices',
  );
}
