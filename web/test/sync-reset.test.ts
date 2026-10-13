import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { SCHEMA_VERSION } from '../db/schema/index';
import { bumpAccess, pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import { localWrite, pullAll, pushOutbox, type Transport } from '../lib/sync/client';
import type { Db, Row } from '../lib/db-types';

let server: Db;
const h = (ms: number, dev = 'a') => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const direct = (user: keyof typeof USERS): Transport => ({
  push: (rows) => push(server, USERS[user], rows),
  pull: (since, av, sv) => pull(server, USERS[user], since, av, sv),
});
const bugRow = (over: Row): Row => ({ id: 'X', file_id: 'fa', title: 't', status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over });
async function device(): Promise<Db> {
  const db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'local');
  return db;
}

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(server, 'server');
  await seedUsers(server);
  await push(server, USERS.admin, [
    { tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h(1) } },
    { tbl: 'files', row: { id: 'fb', name: 'fb', workspace_id: 'ws-a', hlc: h(1) } },
    { tbl: 'bugs', row: bugRow({}) },
  ]);
});

describe('access_version / schema_version reset', () => {
  test('moving a file out of the workspace removes it from the client after bumpAccess', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT id FROM bugs WHERE id = 'X'"))?.id).toBe('X');
    await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    await pullAll(a, direct('alice'));
    expect(await a.get("SELECT id FROM bugs WHERE id = 'X'")).toBeFalsy();
    expect(await a.get("SELECT id FROM files WHERE id = 'fa'")).toBeFalsy();
    expect((await a.get("SELECT id FROM files WHERE id = 'fb'"))?.id).toBe('fb');
  });

  test('reset keeps unpushed outbox rows and the next push delivers them', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ id: 'N1', file_id: 'fb', title: 'unpushed', hlc: h(5), status_hlc: h(5) }));
    await bumpAccess(server, 'alice');
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT title FROM bugs WHERE id = 'N1'"))?.title).toBe('unpushed');
    expect((await a.get("SELECT count(*) AS n FROM outbox WHERE row_id = 'N1'")).n).toBe(1);
    await pushOutbox(a, direct('alice'));
    expect((await server.get("SELECT title FROM bugs WHERE id = 'N1'"))?.title).toBe('unpushed');
  });

  test('matching av and sv never returns reset', async () => {
    const av = await bumpAccess(server, 'alice');
    const r = await pull(server, USERS.alice, 0, av, SCHEMA_VERSION);
    expect('reset' in r).toBe(false);
  });

  test('av mismatch returns reset with current av and sv, no rows', async () => {
    const av = await bumpAccess(server, 'alice');
    expect(await pull(server, USERS.alice, 0, av - 1, SCHEMA_VERSION)).toEqual({ reset: true, av, sv: SCHEMA_VERSION });
  });

  test('sv behind returns reset', async () => {
    const r = await pull(server, USERS.alice, 0, 0, SCHEMA_VERSION - 1);
    expect(r).toEqual({ reset: true, av: 0, sv: SCHEMA_VERSION });
  });

  test('a push that moves a file bumps users of the old and new workspace, not others', async () => {
    await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    expect('reset' in (await pull(server, USERS.alice, 0, 0, SCHEMA_VERSION))).toBe(true);
    expect('reset' in (await pull(server, USERS.vendor, 0, 0, SCHEMA_VERSION))).toBe(true);
    await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fb', name: 'renamed', workspace_id: 'ws-a', hlc: h(2) } }]);
    expect('reset' in (await pull(server, USERS.vendor, 0, 1, SCHEMA_VERSION))).toBe(false);
  });

  test('a file_shares change bumps users of the target and owning workspace', async () => {
    const share = { id: 's1', file_id: 'fb', workspace_id: 'ws-v', hlc: h(2) };
    await push(server, USERS.alice, [{ tbl: 'file_shares', row: share }]);
    expect('reset' in (await pull(server, USERS.vendor, 0, 0, SCHEMA_VERSION))).toBe(true);
    expect('reset' in (await pull(server, USERS.bob, 0, 0, SCHEMA_VERSION))).toBe(true);
    await push(server, USERS.alice, [{ tbl: 'file_shares', row: { ...share, deleted_at: 'now', hlc: h(3) } }]);
    expect('reset' in (await pull(server, USERS.vendor, 0, 1, SCHEMA_VERSION))).toBe(true);
  });

  test('admin moving a bug to a file in another workspace removes it from the client', async () => {
    await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fv', name: 'fv', workspace_id: 'ws-v', hlc: h(1) } }]);
    const a = await device();
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT id FROM bugs WHERE id = 'X'"))?.id).toBe('X');
    await push(server, USERS.admin, [{ tbl: 'bugs', row: bugRow({ file_id: 'fv', hlc: h(2) }) }]);
    await pullAll(a, direct('alice'));
    expect(await a.get("SELECT id FROM bugs WHERE id = 'X'")).toBeFalsy();
  });

  test('an outbox bug survives a reset that wipes its parent file', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ id: 'N2', file_id: 'fa', title: 'orphan', hlc: h(5), status_hlc: h(5) }));
    await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    await pullAll(a, direct('alice'));
    expect(await a.get("SELECT id FROM files WHERE id = 'fa'")).toBeFalsy();
    expect((await a.get("SELECT title FROM bugs WHERE id = 'N2'"))?.title).toBe('orphan');
    expect((await a.get("SELECT count(*) AS n FROM outbox WHERE row_id = 'N2'")).n).toBe(1);
  });

  test('pull throws when the user has no users row', async () => {
    const ghost = { id: 'ghost', email: 'g@x.test', role: 'user' as const, workspaceIds: ['ws-a'] };
    await expect(pull(server, ghost, 0, 0, SCHEMA_VERSION)).rejects.toThrow(/no users row/);
  });
});
