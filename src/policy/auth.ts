import { createHash, timingSafeEqual } from 'node:crypto';

export function verifyBearerToken(header: string | undefined, expected: string): boolean {
  if (!header?.startsWith('Bearer ')) return false;
  const actual = header.slice(7);
  const actualHash = createHash('sha256').update(actual).digest();
  const expectedHash = createHash('sha256').update(expected).digest();
  return timingSafeEqual(actualHash, expectedHash);
}
