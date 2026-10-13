import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import { SCHEMA_VERSION } from '../db/schema/index';
import type { Db, Row } from '../lib/db-types';

let db: Db;
const h = (ms: number, dev = 'a') => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const bug = (id: string, over: Row = {}): Row => ({
  id, file_id: 'fa', title: id, status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over,
});
const log = (id: string, over: Row = {}): Row => ({
  id, ts: 'now', actor_email: USERS.alice.email, actor_role: 'user', workspace_id: 'ws-a', action: 'create', label: id, ...over,
});

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'server');
  await seedUsers(db);
  await push(db, USERS.admin, [{ tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h(1) } }]);
});

describe('ADR-001 gap b: display codes', () => {
  test('a revived bug keeps its code and no two live bugs share one', async () => {
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b1') }, { tbl: 'bugs', row: bug('b2') }]);
    expect((await db.get("SELECT code FROM bugs WHERE id = 'b2'")).code).toBe('BUG-0002');
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b2', { hlc: h(2), deleted_at: 'now' }) }]);
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b3', { hlc: h(3) }) }]);
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b2', { hlc: h(4), deleted_at: null }) }]);
    const live = await db.all('SELECT id, code FROM bugs WHERE deleted_at IS NULL ORDER BY id');
    expect(live).toEqual([
      { id: 'b1', code: 'BUG-0001' }, { id: 'b2', code: 'BUG-0002' }, { id: 'b3', code: 'BUG-0003' },
    ]);
  });
});

describe('ADR-001 gap c: file_shares id', () => {
  test('a share whose id is not file_id:workspace_id is rejected', async () => {
    const r = await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'other', file_id: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    expect(r.rejected).toEqual([{ id: 'other', reason: 'bad share id' }]);
    const a = await push(db, USERS.admin, [{ tbl: 'file_shares', row: { id: 'x', file_id: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    expect(a.rejected).toEqual([{ id: 'x', reason: 'bad share id' }]);
    const ok = await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    expect(ok.accepted).toEqual(['fa:ws-v']);
  });
});

describe('ADR-001 gap d: activity_log', () => {
  test('a non-admin may only log as themselves', async () => {
    const r = await push(db, USERS.alice, [
      { tbl: 'activity_log', row: log('l1') },
      { tbl: 'activity_log', row: log('l2', { actor_email: USERS.bob.email }) },
    ]);
    expect(r.accepted).toEqual(['l1']);
    expect(r.rejected).toEqual([{ id: 'l2', reason: 'actor is not you' }]);
    const a = await push(db, USERS.admin, [{ tbl: 'activity_log', row: log('l3', { actor_email: USERS.bob.email }) }]);
    expect(a.accepted).toEqual(['l3']);
  });

  test('a non-admin pulls only activity of their workspaces', async () => {
    await push(db, USERS.admin, [
      { tbl: 'activity_log', row: log('la') },
      { tbl: 'activity_log', row: log('lv', { workspace_id: 'ws-v' }) },
    ]);
    const ids = async (u: keyof typeof USERS) => {
      const r = await pull(db, USERS[u], 0, 0, SCHEMA_VERSION);
      if ('reset' in r) throw new Error('unexpected reset');
      return r.rows.filter((x) => x.tbl === 'activity_log').map((x) => x.row.id);
    };
    expect(await ids('bob')).toEqual(['la']);
    expect(await ids('vendor')).toEqual(['lv']);
  });
});

describe('ADR-001 gap e: concurrent pushes on one connection', () => {
  test('10 concurrent pushes get distinct server_seq values', async () => {
    const before = Number((await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value);
    const results = await Promise.all(Array.from({ length: 10 }, (_, i) =>
      push(db, USERS.admin, [{ tbl: 'files', row: { id: `c${i}`, name: `c${i}`, workspace_id: 'ws-a', hlc: h(2) } }])));
    expect(results.every((r) => r.accepted.length === 1)).toBe(true);
    const seqs = (await db.all("SELECT server_seq FROM files WHERE id LIKE 'c%'")).map((r) => Number(r.server_seq));
    expect(new Set(seqs).size).toBe(10);
    expect(Number((await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value)).toBe(before + 10);
  });
});
