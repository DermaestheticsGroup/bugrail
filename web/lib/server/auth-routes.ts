import type { Db } from '../db-types';
import { normalizeEmail } from '../domain/auth';
import { verifyPassword, hashPassword } from './password';
import { rateLimited } from './rate-limit';

// A fixed hash so an unknown email costs the same scrypt time as a wrong password.
let dummy: Promise<string> | undefined;

export type LoginResult =
  | { ok: true; userId: string; sessionVersion: number }
  | { ok: false; status: 400 | 401 | 429 };

export function clientIp(h: Headers): string {
  return (process.env.BUGRAIL_TRUSTED_PROXY === '1' && h.get('x-forwarded-for')?.split(',')[0].trim()) || 'unknown';
}

export async function login(db: Db, ip: string, email: unknown, password: unknown): Promise<LoginResult> {
  if (rateLimited(`login-ip:${ip}`, 50)) return { ok: false, status: 429 };
  if (typeof email !== 'string' || typeof password !== 'string' || !password) return { ok: false, status: 400 };
  if (rateLimited(`login-email:${normalizeEmail(email)}`)) return { ok: false, status: 429 };
  const u = await db.get('SELECT id, password_hash, session_version FROM users WHERE lower(email) = ?', normalizeEmail(email));
  dummy ??= hashPassword('bugrail-dummy');
  const ok = await verifyPassword(password, u?.password_hash ?? (await dummy));
  if (!u || !ok) return { ok: false, status: 401 };
  return { ok: true, userId: u.id, sessionVersion: Number(u.session_version ?? 0) };
}
