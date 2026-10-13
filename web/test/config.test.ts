import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { buildConfig } from '../lib/server/config';
import { push } from '../lib/sync/server';
import type { Db } from '../lib/db-types';
import type { User } from '../lib/sync/users';

let db: Db;
const u = (id: string, role: string, ws: string[]): User => ({ id, email: `${id}@x.test`, role, workspaceIds: ws });
const h = '000000000000001-00000-a';

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'server');
  for (const [id, name] of [['ws-a', 'Alpha'], ['ws-v', 'Vendor'], ['ws-z', 'Zulu']]) await db.run('INSERT INTO workspaces (id, name) VALUES (?, ?)', id, name);
  const add = (id: string, role: string, ws: string[]) => db.run("INSERT INTO users (id, email, name, role, workspace_ids, password_hash, session_version, access_version) VALUES (?, ?, '', ?, ?, 'secret-hash', 7, 3)", id, `${id}@x.test`, role, JSON.stringify(ws));
  await add('root', 'admin', []);
  await add('ann', 'qa_internal', ['ws-a', 'ws-z']);
  await add('vic', 'qa_vendor', ['ws-v']);
  await add('vic2', 'qa_vendor', ['ws-v', 'ws-a']);
});

describe('buildConfig isolation', () => {
  test('a vendor sees only its own workspace and the members it shares one with, cut to the intersection', async () => {
    const c = await buildConfig(db, u('vic', 'qa_vendor', ['ws-v']));
    expect(c.workspaces).toEqual([{ id: 'ws-v', name: 'Vendor' }]);
    expect(c.users.map((x) => x.id).sort()).toEqual(['vic', 'vic2']);
    expect(c.users.find((x) => x.id === 'vic2')!.workspaceIds).toEqual(['ws-v']); // ws-a is not vic's to learn about
  });
  test('a user who may share files sees every workspace name', async () => {
    const c = await buildConfig(db, u('ann', 'qa_internal', ['ws-a', 'ws-z']));
    expect(c.workspaces.map((w) => w.id)).toEqual(['ws-a', 'ws-v', 'ws-z']);
    expect(c.users.map((x) => x.id).sort()).toEqual(['ann', 'vic2']); // vic shares no workspace with ann
  });
  test('admin sees everything with full workspace lists', async () => {
    const c = await buildConfig(db, u('root', 'admin', []));
    expect(c.users.length).toBe(4);
    expect(c.users.find((x) => x.id === 'vic2')!.workspaceIds).toEqual(['ws-v', 'ws-a']);
  });
  test('never leaks hashes, versions or the user list of strangers', async () => {
    const text = JSON.stringify(await buildConfig(db, u('vic', 'qa_vendor', ['ws-v'])));
    expect(text).not.toContain('secret-hash');
    expect(text).not.toMatch(/session_version|access_version|password/);
    expect(text).not.toContain('ann@x.test');
  });
});

describe('buildConfig roles', () => {
  test('defaults when nothing is saved; saved matrix replaces the seed row', async () => {
    let c = await buildConfig(db, u('ann', 'qa_internal', ['ws-a']));
    expect(c.roles.map((r) => r.value)).toContain('qa_vendor');
    expect(c.rolePermissions.qa_vendor.bugreport_create).toBeUndefined();
    await db.run("INSERT INTO secrets (key, value) VALUES ('role_permissions', ?)", JSON.stringify({ qa_vendor: { bugreport_create: true } }));
    c = await buildConfig(db, u('ann', 'qa_internal', ['ws-a']));
    expect(c.rolePermissions.qa_vendor).toEqual({ bugreport_create: true });
  });
  test('corrupt secrets fall back to the defaults instead of throwing', async () => {
    await db.run("INSERT INTO secrets (key, value) VALUES ('roles', '{oops')");
    expect((await buildConfig(db, u('ann', 'qa_internal', ['ws-a']))).roles.length).toBe(4);
  });
});

describe('test case codes on push', () => {
  const admin = u('root', 'admin', []);
  const tc = (id: string, file: string, module: string) => ({ tbl: 'testcases' as const, row: { id, file_id: file, module, status: 'Open', status_hlc: h, hlc: h } });
  test('codes come from the module abbreviation, per workspace, numbering continues and never reuses', async () => {
    await push(db, admin, [
      { tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h } },
      { tbl: 'files', row: { id: 'fv', name: 'fv', workspace_id: 'ws-v', hlc: h } },
    ]);
    await push(db, admin, [tc('t1', 'fa', 'Login'), tc('t2', 'fa', 'Login'), tc('t3', 'fa', 'User Management'), tc('t4', 'fv', 'Login')]);
    const code = async (id: string) => (await db.get('SELECT code FROM testcases WHERE id = ?', id)).code;
    expect([await code('t1'), await code('t2'), await code('t3'), await code('t4')]).toEqual(['LOG-0001', 'LOG-0002', 'UMS-0001', 'LOG-0001']);
    // delete the top one: the next number must not reuse it
    await push(db, admin, [{ tbl: 'testcases', row: { id: 't2', file_id: 'fa', module: 'Login', status: 'Open', status_hlc: h, hlc: '000000000000002-00000-a', deleted_at: 'x' } }]);
    await push(db, admin, [tc('t5', 'fa', 'Login')]);
    expect(await code('t5')).toBe('LOG-0003');
  });
  test('a file with no workspace is its own scope', async () => {
    await push(db, admin, [{ tbl: 'files', row: { id: 'fn', name: 'fn', hlc: h } }]);
    await push(db, admin, [tc('n1', 'fn', 'Login'), tc('n2', 'fn', 'Login')]);
    expect((await db.all("SELECT code FROM testcases WHERE file_id = 'fn' ORDER BY code")).map((r: any) => r.code)).toEqual(['LOG-0001', 'LOG-0002']);
  });
});
