import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { hashPassword, verifyPassword } from '../lib/server/password';
import { rateLimited, rateLimitSize, resetRateLimit } from '../lib/server/rate-limit';
import { clientIp, login } from '../lib/server/auth-routes';
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
  test('email bucket trips after 10 attempts even across different IPs', async () => {
    for (let i = 0; i < 10; i++) await login(db, `ip${i}`, ' Ann@x.test', 'bad');
    expect(await login(db, 'fresh', 'ann@x.test', 's3cret')).toEqual({ ok: false, status: 429 });
    expect(await login(db, 'fresh', 'who@x.test', 'bad')).toEqual({ ok: false, status: 401 });
  });
  test('IP bucket trips after 50 attempts, other IPs unaffected', async () => {
    for (let i = 0; i < 50; i++) await login(db, 'ip', `u${i}@x.test`, 'bad');
    expect(await login(db, 'ip', 'ann@x.test', 's3cret')).toEqual({ ok: false, status: 429 });
    expect((await login(db, 'other', 'ann@x.test', 's3cret')).ok).toBe(true);
  });
  test('clientIp reads x-forwarded-for only when BUGRAIL_TRUSTED_PROXY=1', () => {
    const h = new Headers({ 'x-forwarded-for': '1.2.3.4, 5.6.7.8' });
    delete process.env.BUGRAIL_TRUSTED_PROXY;
    expect(clientIp(h)).toBe('unknown');
    process.env.BUGRAIL_TRUSTED_PROXY = '1';
    try {
      expect(clientIp(h)).toBe('1.2.3.4');
      expect(clientIp(new Headers())).toBe('unknown');
    } finally { delete process.env.BUGRAIL_TRUSTED_PROXY; }
  });
});

describe('rateLimited window', () => {
  test('old hits expire', () => {
    for (let i = 0; i < 2; i++) expect(rateLimited('k', 2, 1000, 0)).toBe(false);
    expect(rateLimited('k', 2, 1000, 500)).toBe(true);
    expect(rateLimited('k', 2, 1000, 2000)).toBe(false);
  });
  test('expired keys are evicted once the map is large', () => {
    for (let i = 0; i <= 10_000; i++) rateLimited(`old${i}`, 1, 1000, 0);
    expect(rateLimitSize()).toBe(10_001);
    rateLimited('new', 1, 1000, 5000);
    expect(rateLimitSize()).toBe(1);
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
