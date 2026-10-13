import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { hashPassword, verifyPassword } from '../lib/server/password';
import { rateLimited, resetRateLimit } from '../lib/server/rate-limit';
import { login } from '../lib/server/auth-routes';
import { userFromSession } from '../lib/server/session';
import type { Db } from '../lib/db-types';

let db: Db;
beforeEach(async () => {
  resetRateLimit();
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'server');
  await db.run("INSERT INTO users (id, email, role, workspace_ids, password_hash, session_version, access_version) VALUES ('u1', 'Ann@X.test', 'qa_internal', '[\"ws-a\"]', ?, 3, 0)", await hashPassword('s3cret'));
});

describe('password', () => {
  test('hash verifies, differs per call, rejects wrong and malformed', async () => {
    const a = await hashPassword('pw'), b = await hashPassword('pw');
    expect(a).not.toBe(b);
    expect(await verifyPassword('pw', a)).toBe(true);
    expect(await verifyPassword('nope', a)).toBe(false);
    expect(await verifyPassword('pw', 'plaintext')).toBe(false);
    expect(await verifyPassword('pw', null)).toBe(false);
  });
});

describe('login', () => {
  test('email is case-insensitive and returns the session version', async () => {
    expect(await login(db, 'ip', ' ann@x.test ', 's3cret')).toEqual({ ok: true, userId: 'u1', sessionVersion: 3 });
  });
  test('wrong password, unknown email and bad body', async () => {
    expect(await login(db, 'ip', 'ann@x.test', 'bad')).toEqual({ ok: false, status: 401 });
    expect(await login(db, 'ip', 'who@x.test', 's3cret')).toEqual({ ok: false, status: 401 });
    expect(await login(db, 'ip', 5, 's3cret')).toEqual({ ok: false, status: 400 });
  });
  test('rate limit trips after 10 attempts per IP, other IPs unaffected', async () => {
    for (let i = 0; i < 10; i++) await login(db, 'ip', 'ann@x.test', 'bad');
    expect(await login(db, 'ip', 'ann@x.test', 's3cret')).toEqual({ ok: false, status: 429 });
    expect((await login(db, 'other', 'ann@x.test', 's3cret')).ok).toBe(true);
  });
});

describe('rateLimited window', () => {
  test('old hits expire', () => {
    for (let i = 0; i < 2; i++) expect(rateLimited('k', 2, 1000, 0)).toBe(false);
    expect(rateLimited('k', 2, 1000, 500)).toBe(true);
    expect(rateLimited('k', 2, 1000, 2000)).toBe(false);
  });
});

describe('userFromSession', () => {
  test('valid session loads the user', async () => {
    expect(await userFromSession(db, { userId: 'u1', sessionVersion: 3 })).toEqual({ id: 'u1', email: 'Ann@X.test', role: 'qa_internal', workspaceIds: ['ws-a'] });
  });
  test('stale version, unknown user and empty session are refused', async () => {
    expect(await userFromSession(db, { userId: 'u1', sessionVersion: 2 })).toBeUndefined();
    expect(await userFromSession(db, { userId: 'nope', sessionVersion: 3 })).toBeUndefined();
    expect(await userFromSession(db, {})).toBeUndefined();
    expect(await userFromSession(db, null)).toBeUndefined();
  });
});
