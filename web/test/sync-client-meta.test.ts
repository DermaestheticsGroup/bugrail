import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { SCHEMA_VERSION } from '../db/schema/index';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import { listRejected, localWrite, pullAll, pushOutbox, type Transport } from '../lib/sync/client';
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
const countResets = (t: Transport) => {
  const c = { n: 0 };
  return { c, t: { push: t.push, pull: async (s: number, a: number, v: number) => {
    const r = await t.pull(s, a, v);
    if ('reset' in r) c.n += 1;
    return r;
  } } as Transport };
};

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(server, 'server');
  await seedUsers(server);
  await push(server, USERS.admin, [
    { tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h(1) } },
    { tbl: 'bugs', row: bugRow({}) },
  ]);
});

describe('client meta and rejected bookkeeping', () => {
  test('local migrations never write the schema_version pull sends', async () => {
    const a = await device();
    expect(await a.get("SELECT value FROM meta WHERE key = 'schema_version'")).toBeFalsy();
    expect(Number((await a.get("SELECT value FROM meta WHERE key = 'applied_version'")).value)).toBe(SCHEMA_VERSION);
  });

  test('a device synced at schema 3 gets exactly one reset after migrating to 4', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await a.run("UPDATE meta SET value = '3' WHERE key = 'schema_version'");
    await applyMigrations(a, 'local');
    const { c, t } = countResets(direct('alice'));
    await pullAll(a, t);
    await pullAll(a, t);
    expect(c.n).toBe(1);
    expect((await a.get("SELECT value FROM meta WHERE key = 'schema_version'")).value).toBe(String(SCHEMA_VERSION));
  });

  test('a rejection is parked against the table it came from', async () => {
    const a = await device();
    await localWrite(a, 'files', { id: 'Z', name: 'z', workspace_id: 'ws-a', hlc: h(5) });
    await localWrite(a, 'bug_events', { id: 'Z', bug_id: 'X', kind: 'note', at: 'now' });
    const t: Transport = { push: async () => ({ accepted: ['Z'], rejected: [{ id: 'Z', tbl: 'bug_events', reason: 'nope' }], server: [] }), pull: direct('alice').pull };
    await pushOutbox(a, t);
    expect((await listRejected(a)).map((p) => [p.row_id, p.tbl])).toEqual([['Z', 'bug_events']]);
  });

  test('a reset drops rejected entries whose local row it removed', async () => {
    const v = await device();
    await localWrite(v, 'bugs', bugRow({ id: 'N1', hlc: h(5), status_hlc: h(5) }));
    await pushOutbox(v, direct('vendor'));
    expect((await listRejected(v)).length).toBe(1);
    await pullAll(v, direct('vendor'));
    expect(await v.get("SELECT id FROM bugs WHERE id = 'N1'")).toBeFalsy();
    expect(await listRejected(v)).toEqual([]);
  });
});
