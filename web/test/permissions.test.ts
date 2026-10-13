import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers, type User } from '../lib/sync/users';
import { SCHEMA_VERSION } from '../db/schema/index';
import type { Db, Row } from '../lib/db-types';

let db: Db;
const h = (ms: number) => `${String(ms).padStart(15, '0')}-00000-a`;
const bug = (id: string, over: Row = {}): Row => ({
  id, file_id: 'fa', title: id, module: 'Login', status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over,
});
const one = async (u: User, tbl: any, row: Row) => (await push(db, u, [{ tbl, row }])).rejected[0]?.reason ?? 'ok';

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'server');
  await seedUsers(db);
  await push(db, USERS.admin, [
    { tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h(1) } },
    { tbl: 'bugs', row: bug('b1') },
    { tbl: 'bugs', row: bug('b2', { status_code: 'RETEST' }) },
  ]);
});

describe('role permission matrix on push', () => {
  test('qa_vendor cannot create a bug, user_umum cannot write at all', async () => {
    const vendorInA: User = { ...USERS.vendor, workspaceIds: ['ws-a'] };
    expect(await one(vendorInA, 'bugs', bug('new'))).toBe('not allowed: bugreport_create');
    const umum: User = { id: 'u', email: 'u@x.test', role: 'user_umum', workspaceIds: ['ws-a'] };
    expect(await one(umum, 'bugs', bug('b1', { title: 'x', hlc: h(5) }))).toBe('not allowed: bugreport_update');
    expect(await one(umum, 'testcases', { id: 't', file_id: 'fa', status: 'Open', status_hlc: h(1), hlc: h(1) })).toBe('not allowed: testcase_create');
  });

  test('pm_ba may change status and priority only', async () => {
    expect(await one(USERS.pm, 'bugs', bug('b1', { priority: 'High', status_code: 'IN_PROGRESS', status_hlc: h(5), hlc: h(5) }))).toBe('ok');
    expect(await one(USERS.pm, 'bugs', bug('b1', { title: 'renamed', hlc: h(6) }))).toBe('not allowed: bugreport_update');
  });

  test('QA role may only take a bug out of RETEST', async () => {
    expect(await one(USERS.alice, 'bugs', bug('b1', { status_code: 'RETEST', status_hlc: h(5), hlc: h(5) }))).toBe('status transition not allowed');
    expect(await one(USERS.alice, 'bugs', bug('b2', { status_code: 'CLOSED', status_hlc: h(5), hlc: h(5) }))).toBe('ok');
  });

  test('a stale status write is not treated as a transition', async () => {
    // Loses the status clock, so it changes nothing and needs no transition check.
    expect(await one(USERS.alice, 'bugs', bug('b2', { status_code: 'OPEN', status_hlc: h(0), hlc: h(0) }))).toBe('ok');
  });

  test('saved role_permissions replace the seed row', async () => {
    await db.run("INSERT INTO secrets (key, value) VALUES ('role_permissions', ?)", JSON.stringify({ qa_vendor: { bugreport_create: true } }));
    const vendorInA: User = { ...USERS.vendor, workspaceIds: ['ws-a'] };
    expect(await one(vendorInA, 'bugs', bug('new'))).toBe('ok');
    expect(await one(vendorInA, 'bugs', bug('b1', { title: 'x', hlc: h(5) }))).toBe('not allowed: bugreport_update');
  });

  test('master and custom field tables need master / settings', async () => {
    expect(await one(USERS.alice, 'bug_status_master', { id: 's', name: 'X', hlc: h(1) })).toBe('not allowed: master');
    expect(await one(USERS.alice, 'custom_field_defs', { id: 'c', label: 'X', hlc: h(1) })).toBe('not allowed: settings');
    expect(await one(USERS.admin, 'bug_status_master', { id: 's', name: 'X', hlc: h(1) })).toBe('ok');
  });

  test('every user receives master and custom field rows on pull', async () => {
    await push(db, USERS.admin, [{ tbl: 'bug_status_master', row: { id: 's', name: 'X', hlc: h(1) } }]);
    const r = await pull(db, USERS.vendor, 0, 0, SCHEMA_VERSION);
    if ('reset' in r) throw new Error('reset');
    expect(r.rows.some((x) => x.tbl === 'bug_status_master')).toBe(true);
  });
});

describe('access bump targets come from the users table', () => {
  test('a real (non-dev) user sharing the moved workspace is bumped', async () => {
    await db.run("INSERT INTO users (id, email, role, workspace_ids, access_version) VALUES ('real', 'r@x.test', 'qa_vendor', '[\"ws-v\"]', 0)");
    await push(db, USERS.admin, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    expect(Number((await db.get("SELECT access_version FROM users WHERE id = 'real'")).access_version)).toBe(1);
  });
});
