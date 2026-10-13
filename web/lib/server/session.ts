import { cookies } from 'next/headers';
import { getIronSession, type SessionOptions } from 'iron-session';
import type { Db } from '../db-types';
import { getServerDb } from '../server-db';
import { userFromHeader, type User } from '../sync/users';

export interface SessionData { userId?: string; sessionVersion?: number }

export function sessionOptions(): SessionOptions {
  const password = process.env.SESSION_PASSWORD ?? '';
  if (password.length < 32) throw new Error('SESSION_PASSWORD must be at least 32 characters');
  return { cookieName: 'bugrail_session', password, ttl: 7 * 24 * 3600, cookieOptions: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production' } };
}

// A cookie only counts while its sessionVersion matches the users row (reset password or removal bumps it).
export async function userFromSession(db: Db, s: SessionData | null | undefined): Promise<User | undefined> {
  if (!s?.userId) return undefined;
  const r = await db.get('SELECT id, email, role, workspace_ids, session_version FROM users WHERE id = ?', s.userId);
  if (!r || Number(r.session_version ?? 0) !== Number(s.sessionVersion ?? -1)) return undefined;
  return { id: r.id, email: r.email, role: r.role, workspaceIds: JSON.parse(r.workspace_ids || '[]') };
}

export async function getSession() {
  return getIronSession<SessionData>(await cookies(), sessionOptions());
}

// Every route handler calls this; proxy.ts only redirects page loads.
export async function requireUser(req: Request): Promise<User | undefined> {
  const dev = userFromHeader(req.headers.get('x-dev-user'));
  if (dev) return dev;
  return userFromSession(await getServerDb(), await getSession());
}
