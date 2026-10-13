import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import { dismissRejected, listRejected, localWrite, pullAll, pushOutbox, type Transport } from '../lib/sync/client';
import type { Db, Row } from '../lib/db-types';

let server: Db;
const h = (ms: number, dev = 'a') => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const direct = (user: keyof typeof USERS): Transport => ({
  push: (rows) => push(server, USERS[user], rows),
  pull: (since, av, sv) => pull(server, USERS[user], since, av, sv),
});
const bugRow = (over: Row): Row => ({ id: 'X', file_id: 'fa', title: 't', status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over });
const outboxCount = async (db: Db) => Number((await db.get('SELECT count(*) AS n FROM outbox')).n);
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
    { tbl: 'bugs', row: bugRow({}) },
  ]);
});

describe('rejected pushes', () => {
  test('same id in two tables parks two rejections; dismiss by tbl drops only that one', async () => {
    const v = await device();
    await v.run("INSERT INTO rejected (row_id, tbl, reason, at) VALUES ('Z', 'files', 'r1', 't'), ('Z', 'bugs', 'r2', 't')");
    expect((await listRejected(v)).length).toBe(2);
    await dismissRejected(v, 'Z', 'files');
    expect((await listRejected(v)).map((p) => p.tbl)).toEqual(['bugs']);
  });

  test('reset pull keeps a parked rejection and its local row; dismiss then drops both', async () => {
    const v = await device();
    await pullAll(v, direct('vendor'));
    await localWrite(v, 'bugs', bugRow({ id: 'N9', title: 'sneaky', hlc: h(5), status_hlc: h(5) }));
    await pushOutbox(v, direct('vendor'));
    await v.run("DELETE FROM meta WHERE key IN ('access_version', 'schema_version')");
    await pullAll(v, direct('vendor'));
    expect((await listRejected(v)).map((p) => p.row_id)).toEqual(['N9']);
    expect((await v.get("SELECT title FROM bugs WHERE id = 'N9'"))?.title).toBe('sneaky');
    await dismissRejected(v, 'N9');
    expect(await listRejected(v)).toEqual([]);
    expect(await v.get("SELECT id FROM bugs WHERE id = 'N9'")).toBeFalsy();
  });

  test('reset pull keeps a queued outbox row intact even when the server holds a newer copy', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ title: 'mine', hlc: h(5), status_hlc: h(5) }));
    await push(server, USERS.admin, [{ tbl: 'bugs', row: bugRow({ title: 'theirs', hlc: h(9), status_hlc: h(9) }) }]);
    await a.run("DELETE FROM meta WHERE key IN ('access_version', 'schema_version')");
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT title FROM bugs WHERE id = 'X'"))?.title).toBe('mine');
    expect((await a.get("SELECT count(*) AS n FROM outbox WHERE row_id = 'X'")).n).toBe(1);
  });

  test('a rejected write leaves the outbox and is parked with its reason', async () => {
    const v = await device();
    await localWrite(v, 'bugs', bugRow({ id: 'N1', title: 'sneaky', hlc: h(5), status_hlc: h(5) }));
    const r = await pushOutbox(v, direct('vendor'));
    expect(r?.rejected).toEqual([{ id: 'N1', tbl: 'bugs', reason: 'file not visible' }]);
    expect(await outboxCount(v)).toBe(0);
    const parked = await listRejected(v);
    expect(parked.map((p) => [p.row_id, p.tbl, p.reason])).toEqual([['N1', 'bugs', 'file not visible']]);
    expect(typeof parked[0].at).toBe('string');
    expect(await server.get("SELECT id FROM bugs WHERE id = 'N1'")).toBeFalsy();
  });

  test('a transport failure leaves the outbox untouched and parks nothing', async () => {
    const a = await device();
    await localWrite(a, 'bugs', bugRow({ id: 'N2', hlc: h(5), status_hlc: h(5) }));
    const broken: Transport = { push: async () => { throw new Error('offline'); }, pull: direct('alice').pull };
    await expect(pushOutbox(a, broken)).rejects.toThrow('offline');
    expect(await outboxCount(a)).toBe(1);
    expect(await listRejected(a)).toEqual([]);
    await pushOutbox(a, direct('alice'));
    expect((await server.get("SELECT id FROM bugs WHERE id = 'N2'"))?.id).toBe('N2');
  });

  test('dismissRejected clears the row and drops the local copy of a never-accepted insert', async () => {
    const v = await device();
    await localWrite(v, 'bugs', bugRow({ id: 'N1', hlc: h(5), status_hlc: h(5) }));
    await pushOutbox(v, direct('vendor'));
    await dismissRejected(v, 'N1');
    expect(await listRejected(v)).toEqual([]);
    expect(await v.get("SELECT id FROM bugs WHERE id = 'N1'")).toBeFalsy();
  });

  test('dismissing a rejected edit restores the server copy on the next pull', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    // alice may edit X but not move it: the server rejects, the local copy shows the move until dismissed.
    await localWrite(a, 'bugs', bugRow({ file_id: 'elsewhere', title: 'moved', hlc: h(5), status_hlc: h(5) }));
    await pushOutbox(a, direct('alice'));
    expect((await listRejected(a)).map((p) => p.reason)).toEqual(['only admin can move a bug']);
    await dismissRejected(a, 'X');
    await pullAll(a, direct('alice'));
    expect(await a.get("SELECT file_id, title FROM bugs WHERE id = 'X'")).toMatchObject({ file_id: 'fa', title: 't' });
  });
});
