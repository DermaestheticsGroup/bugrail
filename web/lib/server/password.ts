import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const KEYLEN = 64;
const run = (pw: string, salt: Buffer) =>
  new Promise<Buffer>((res, rej) => scrypt(pw, salt, KEYLEN, (e, k) => (e ? rej(e) : res(k))));

// Stored as "scrypt$<salt hex>$<hash hex>".
export async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await run(pw, salt)).toString('hex')}`;
}

export async function verifyPassword(pw: string, stored: string | null | undefined): Promise<boolean> {
  const [alg, salt, hash] = String(stored ?? '').split('$');
  if (alg !== 'scrypt' || !salt || !hash) return false;
  const want = Buffer.from(hash, 'hex');
  const got = await run(pw, Buffer.from(salt, 'hex'));
  return want.length === got.length && timingSafeEqual(want, got);
}
