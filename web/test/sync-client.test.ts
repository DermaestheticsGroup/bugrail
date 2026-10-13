import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import { SCHEMA_VERSION } from '../db/schema/index';
import { localWrite, pullAll, pushOutbox, type Transport } from '../lib/sync/client';
import type { Db, Row } from '../lib/db-types';

let server: Db;
const h = (ms: number, dev: string) => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const direct = (user: keyof typeof USERS, pageSize?: number): Transport => ({
  push: (rows) => push(server, USERS[user], rows),
  pull: (since, av, sv) => pull(server, USERS[user], since, av, sv, pageSize),
});
async function device(): Promise<Db> {
  const db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'local');
  return db;
}
const bugRow = (over: Row): Row => ({ id: 'X', file_id: 'fa', title: 't', description: 'd', status_code: 'OPEN', status_hlc: h(1, 'a'), hlc: h(1, 'a'), ...over });
const serverBug = (id = 'X') => server.get('SELECT * FROM bugs WHERE id = ?', id);

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(server, 'server');
  await seedUsers(server);
  await push(server, USERS.admin, [
    { tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h(1, 'a') } },
    { tbl: 'bugs', row: bugRow({}) },
  ]);
});

describe('offline scenarios (G0.8)', () => {
  test('G0.1-equivalent: offline writes reach the server after push', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ id: 'N1', title: 'offline', hlc: h(5, 'a'), status_hlc: h(5, 'a') }));
    await localWrite(a, 'bugs', bugRow({ id: 'N2', title: 'offline2', hlc: h(6, 'a'), status_hlc: h(6, 'a') }));
    await pushOutbox(a, direct('alice'));
    expect((await serverBug('N1')).title).toBe('offline');
    expect((await serverBug('N2')).code).toMatch(/^BUG-\d{4}$/);
    expect((await a.get('SELECT count(*) AS n FROM outbox')).n).toBe(0);
  });

  test('true LWW: an older offline edit pushed later loses', async () => {
    const a = await device();
    const b = await device();
    await pullAll(a, direct('alice'));
    await pullAll(b, direct('bob'));
    await localWrite(a, 'bugs', bugRow({ title: 'A at t1', hlc: h(10, 'a') }));
    await localWrite(b, 'bugs', bugRow({ title: 'B at t2', hlc: h(20, 'b') }));
    await pushOutbox(b, direct('bob'));
    await pushOutbox(a, direct('alice'));
    expect((await serverBug()).title).toBe('B at t2');
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT title FROM bugs WHERE id = 'X'")).title).toBe('B at t2');
  });

  test('concurrent offline inserts both survive everywhere', async () => {
    const a = await device();
    const b = await device();
    await localWrite(a, 'bugs', bugRow({ id: 'A1', hlc: h(5, 'a') }));
    await localWrite(b, 'bugs', bugRow({ id: 'B1', hlc: h(5, 'b') }));
    await pushOutbox(a, direct('alice'));
    await pushOutbox(b, direct('bob'));
    await pullAll(a, direct('alice'));
    await pullAll(b, direct('bob'));
    for (const d of [a, b]) {
      const ids = (await d.all('SELECT id FROM bugs ORDER BY id')).map((r) => r.id);
      expect(ids).toEqual(['A1', 'B1', 'X']);
    }
  });

  test('rebase by id: an unpushed edit survives a pull and pushes after', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ title: 'mine', hlc: h(30, 'a') }));
    await push(server, USERS.bob, [{ tbl: 'bugs', row: bugRow({ description: 'theirs', hlc: h(20, 'b') }) }]);
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT title FROM bugs WHERE id = 'X'")).title).toBe('mine');
    await pushOutbox(a, direct('alice'));
    expect((await serverBug()).title).toBe('mine');
  });

  test('status clock: a status move and a description edit both survive', async () => {
    const a = await device();
    const b = await device();
    await pullAll(a, direct('alice'));
    await pullAll(b, direct('bob'));
    await localWrite(a, 'bugs', { ...(await a.get("SELECT * FROM bugs WHERE id = 'X'")), status_code: 'RETEST', status_hlc: h(40, 'a') });
    await localWrite(b, 'bugs', { ...(await b.get("SELECT * FROM bugs WHERE id = 'X'")), description: 'edited', hlc: h(41, 'b') });
    await pushOutbox(a, direct('alice'));
    await pushOutbox(b, direct('bob'));
    const s = await serverBug();
    expect(s.status_code).toBe('RETEST');
    expect(s.description).toBe('edited');
  });

  test('two concurrent comments both remain', async () => {
    const a = await device();
    const b = await device();
    await localWrite(a, 'bug_events', { id: 'ca', bug_id: 'X', kind: 'comment', text: 'from A' });
    await localWrite(b, 'bug_events', { id: 'cb', bug_id: 'X', kind: 'comment', text: 'from B' });
    await pushOutbox(a, direct('alice'));
    await pushOutbox(b, direct('bob'));
    const texts = (await server.all("SELECT text FROM bug_events WHERE bug_id = 'X' ORDER BY id")).map((r) => r.text);
    expect(texts).toEqual(['from A', 'from B']);
  });

  // Review Focus 3
  test('pull loops across pages and applies every row once', async () => {
    for (let i = 0; i < 7; i++) {
      await push(server, USERS.admin, [{ tbl: 'bugs', row: bugRow({ id: `P${i}`, hlc: h(50 + i, 'a') }) }]);
    }
    const a = await device();
    await pullAll(a, direct('alice', 3));
    expect((await a.get('SELECT count(*) AS n FROM bugs')).n).toBe(8);
    expect((await a.get("SELECT value FROM meta WHERE key = 'since'")).value).toBe(
      String((await server.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value),
    );
  });

  test('a write made while a push is in flight stays in the outbox', async () => {
    const a = await device();
    await localWrite(a, 'bugs', bugRow({ id: 'F1', hlc: h(60, 'a') }));
    const slow: Transport = {
      push: async (rows) => {
        await localWrite(a, 'bugs', bugRow({ id: 'F2', hlc: h(61, 'a') }));
        return push(server, USERS.alice, rows);
      },
      pull: (since, av, sv) => pull(server, USERS.alice, since, av, sv),
    };
    await pushOutbox(a, slow);
    const left = (await a.all('SELECT row_id FROM outbox')).map((r) => r.row_id);
    expect(left).toEqual(['F2']);
  });
});
