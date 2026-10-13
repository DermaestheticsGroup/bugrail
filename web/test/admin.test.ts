import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import * as A from '../lib/server/admin';
import { login } from '../lib/server/auth-routes';
import { resetRateLimit } from '../lib/server/rate-limit';
import { userFromSession } from '../lib/server/session';
import { push } from '../lib/sync/server';
import type { Db } from '../lib/db-types';

let db: Db, ws: string, admin: string;
const mk = async (over: object = {}) => {
  const r = await A.createUser(db, { email: 'a@x.test', role: 'qa_internal', password: 'longenough', workspaceIds: [ws], ...over });
  if (!r.ok) throw new Error(r.error);
  return r.id;
};

beforeEach(async () => {
  resetRateLimit();
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'server');
  const w = await A.createWorkspace(db, 'Alpha');
  if (!w.ok) throw new Error('ws');
  ws = w.id;
  admin = await mk({ email: 'root@x.test', role: 'admin', workspaceIds: [] });
});

describe('users', () => {
  test('create validates email, role, password, workspace and uniqueness', async () => {
    expect(await A.createUser(db, { email: 'nope', role: 'qa_internal', password: 'longenough' })).toMatchObject({ ok: false, error: 'invalid email' });
    expect(await A.createUser(db, { email: 'b@x.test', role: 'god', password: 'longenough' })).toMatchObject({ error: 'invalid role' });
    expect(await A.createUser(db, { email: 'b@x.test', role: 'qa_internal', password: 'short' })).toMatchObject({ ok: false });
    expect(await A.createUser(db, { email: 'b@x.test', role: 'qa_internal', password: 'longenough', workspaceIds: ['ghost'] })).toMatchObject({ error: 'unknown workspace' });
    await mk({ email: 'dup@x.test' });
    expect(await A.createUser(db, { email: 'DUP@x.test', role: 'qa_internal', password: 'longenough' })).toMatchObject({ status: 409 });
  });

  test('new user can log in; password never listed', async () => {
    await mk({ email: 'Log@x.test' });
    expect((await login(db, 'ip', 'log@x.test', 'longenough')).ok).toBe(true);
    expect(JSON.stringify(await A.listUsers(db))).not.toContain('scrypt');
  });

  test('password reset ends existing sessions and old password stops working', async () => {
    const id = await mk();
    const s = await login(db, 'ip', 'a@x.test', 'longenough');
    if (!s.ok) throw new Error('login');
    expect(await userFromSession(db, { userId: s.userId, sessionVersion: s.sessionVersion })).toBeDefined();
    expect(await A.updateUser(db, id, { password: 'brand-new-pass' })).toEqual({ ok: true });
    expect(await userFromSession(db, { userId: s.userId, sessionVersion: s.sessionVersion })).toBeUndefined();
    expect((await login(db, 'ip', 'a@x.test', 'longenough')).ok).toBe(false);
    expect((await login(db, 'ip', 'a@x.test', 'brand-new-pass')).ok).toBe(true);
  });

  test('role or workspace change bumps access_version', async () => {
    const id = await mk();
    await A.updateUser(db, id, { role: 'pm_ba' });
    await A.updateUser(db, id, { workspaceIds: [] });
    expect(Number((await db.get('SELECT access_version AS v FROM users WHERE id = ?', id)).v)).toBe(2);
  });

  test('a refused update changes nothing', async () => {
    const id = await mk();
    expect(await A.updateUser(db, id, { role: 'pm_ba', workspaceIds: ['ghost'] })).toMatchObject({ ok: false });
    expect((await db.get('SELECT role FROM users WHERE id = ?', id)).role).toBe('qa_internal');
  });

  test('the last admin cannot be demoted or deleted', async () => {
    expect(await A.updateUser(db, admin, { role: 'pm_ba' })).toMatchObject({ status: 409 });
    expect(await A.deleteUser(db, admin)).toMatchObject({ status: 409 });
    const second = await mk({ email: 'two@x.test', role: 'admin' });
    expect(await A.deleteUser(db, second)).toEqual({ ok: true });
  });

  test('malformed workspaceIds are refused, not silently trimmed', async () => {
    expect(await A.createUser(db, { email: 'w@x.test', role: 'qa_internal', password: 'longenough', workspaceIds: [ws, 7] })).toMatchObject({ error: 'unknown workspace' });
    const id = await mk({ email: 'w2@x.test' });
    expect(await A.updateUser(db, id, { workspaceIds: [ws, null] })).toMatchObject({ ok: false });
    expect(await A.updateUser(db, id, { workspaceIds: 'ws' })).toMatchObject({ ok: false });
    expect(JSON.parse((await db.get('SELECT workspace_ids AS w FROM users WHERE id = ?', id)).w)).toEqual([ws]);
  });

  test('concurrent creates of one email: exactly one wins, the other gets 409', async () => {
    const mkp = () => A.createUser(db, { email: 'Race@x.test', role: 'qa_internal', password: 'longenough' });
    const rs = await Promise.all([mkp(), mkp()]);
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect(rs.find((r) => !r.ok)).toMatchObject({ status: 409 });
  });

  test('two admins deleting each other concurrently cannot remove every admin', async () => {
    const second = await mk({ email: 'two@x.test', role: 'admin' });
    const rs = await Promise.all([A.deleteUser(db, admin), A.deleteUser(db, second)]);
    expect(rs.filter((r) => r.ok).length).toBe(1);
    expect(Number((await db.get("SELECT count(*) AS n FROM users WHERE role = 'admin'")).n)).toBe(1);
  });

  test('a deleted user has no session', async () => {
    const id = await mk();
    await A.deleteUser(db, id);
    expect(await userFromSession(db, { userId: id, sessionVersion: 0 })).toBeUndefined();
    expect(await A.deleteUser(db, id)).toMatchObject({ status: 404 });
  });
});

describe('permissions and workspaces', () => {
  test('saved permissions drive push checks', async () => {
    await A.createWorkspace(db, 'Beta');
    const u = { id: 'q', email: 'q@x.test', role: 'qa_vendor', workspaceIds: [ws] };
    const h = '000000000000001-00000-a';
    await push(db, { id: 'root', email: 'root@x.test', role: 'admin', workspaceIds: [] }, [{ tbl: 'files', row: { id: 'f', name: 'f', workspace_id: ws, hlc: h } }]);
    const row = { id: 'b', file_id: 'f', title: 't', status_code: 'OPEN', status_hlc: h, hlc: h };
    expect((await push(db, u, [{ tbl: 'bugs', row }])).rejected[0].reason).toBe('not allowed: bugreport_create');
    expect(await A.savePermissions(db, { qa_vendor: { bugreport_create: true } })).toEqual({ ok: true });
    expect((await push(db, u, [{ tbl: 'bugs', row }])).accepted).toEqual(['b']);
  });

  test('savePermissions refuses unknown keys, non-booleans and an admin row', async () => {
    expect(await A.savePermissions(db, { qa_vendor: { fly: true } })).toMatchObject({ ok: false });
    expect(await A.savePermissions(db, { qa_vendor: { report: 'yes' } })).toMatchObject({ ok: false });
    expect(await A.savePermissions(db, { admin: { report: false } })).toMatchObject({ ok: false });
    expect(await A.savePermissions(db, [])).toMatchObject({ ok: false });
  });

  test('workspace names are unique; delete refused while used', async () => {
    expect(await A.createWorkspace(db, ' alpha ')).toMatchObject({ status: 409 });
    expect(await A.createWorkspace(db, '  ')).toMatchObject({ ok: false });
    await mk({ email: 'm@x.test' });
    expect(await A.deleteWorkspace(db, ws)).toMatchObject({ error: 'workspace still has users' });
    const other = await A.createWorkspace(db, 'Gamma');
    if (!other.ok) throw new Error('x');
    expect(await A.renameWorkspace(db, other.id, 'ALPHA')).toMatchObject({ status: 409 }); // rename cannot create a duplicate either
    expect(await A.renameWorkspace(db, other.id, 'Delta')).toEqual({ ok: true });
    expect(await A.deleteWorkspace(db, other.id)).toEqual({ ok: true });
    expect(await A.renameWorkspace(db, 'ghost', 'x')).toMatchObject({ status: 404 });
  });

  test('gemini key set and cleared', async () => {
    await A.setSecret(db, 'gemini_api_key', ' k ');
    expect((await db.get("SELECT value FROM secrets WHERE key = 'gemini_api_key'")).value).toBe('k');
    await A.setSecret(db, 'gemini_api_key', '');
    expect(await db.get("SELECT value FROM secrets WHERE key = 'gemini_api_key'")).toBeUndefined();
  });
});
