import { describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { TABLES } from '../db/tables';
import { mergeArgs, mergeSql } from '../lib/lww';
import { applySchema } from '../lib/schema';
import type { Db, Row } from '../lib/db-types';

async function freshDb(): Promise<Db> {
  const db = (await connect(':memory:')) as unknown as Db;
  await applySchema(db, ['schema']);
  return db;
}

const bug = (over: Row): Row => ({
  id: 'b1', code: null, file_id: 'f1', title: 't0', description: 'd0',
  status_code: 'OPEN', status_hlc: '000000000001000-00000-a', hlc: '000000000001000-00000-a',
  ...over,
});

async function apply(db: Db, tbl: keyof typeof TABLES, row: Row) {
  return db.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
}

const get = (db: Db, id = 'b1') => db.get('SELECT * FROM bugs WHERE id = ?', id);

describe('lww merge on @tursodatabase/database', () => {
  test('insert when the row does not exist', async () => {
    const db = await freshDb();
    const r = await apply(db, 'bugs', bug({}));
    expect(r.changes).toBe(1);
    expect((await get(db)).title).toBe('t0');
  });

  test('newer hlc wins, older is ignored and reports 0 changes', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({}));
    await apply(db, 'bugs', bug({ title: 'new', hlc: '000000000002000-00000-b' }));
    const old = await apply(db, 'bugs', bug({ title: 'old', hlc: '000000000001500-00000-c' }));
    expect(old.changes).toBe(0);
    expect((await get(db)).title).toBe('new');
  });

  test('status clock is independent of the row clock', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({}));
    // A: description edit at t2 (status untouched)
    await apply(db, 'bugs', bug({ description: 'A', hlc: '000000000002000-00000-a' }));
    // B: status move at t3 with an older row hlc (B never saw A's edit)
    await apply(db, 'bugs', bug({ status_code: 'RETEST', status_hlc: '000000000003000-00000-b' }));
    const row = await get(db);
    expect(row.description).toBe('A');
    expect(row.status_code).toBe('RETEST');
    expect(row.hlc).toBe('000000000002000-00000-a');
    expect(row.status_hlc).toBe('000000000003000-00000-b');
  });

  test('code is first-non-null-wins and applies even with an older hlc', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({ title: 'local', hlc: '000000000005000-00000-a' }));
    await apply(db, 'bugs', bug({ code: 'BUG-0001', title: 'server', hlc: '000000000001000-00000-a' }));
    let row = await get(db);
    expect(row.code).toBe('BUG-0001');
    expect(row.title).toBe('local');
    await apply(db, 'bugs', bug({ code: 'BUG-0002', hlc: '000000000009000-00000-a' }));
    row = await get(db);
    expect(row.code).toBe('BUG-0001');
  });

  test('tombstone travels like any field', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({}));
    await apply(db, 'bugs', bug({ deleted_at: '2026-10-13T00:00:00Z', hlc: '000000000002000-00000-a' }));
    expect((await get(db)).deleted_at).toBe('2026-10-13T00:00:00Z');
  });

  test('insert-only tables ignore a second insert with the same id', async () => {
    const db = await freshDb();
    const e = { id: 'e1', bug_id: 'b1', kind: 'comment', text: 'first' };
    await apply(db, 'bug_events', e);
    const second = await apply(db, 'bug_events', { ...e, text: 'second' });
    expect(second.changes).toBe(0);
    expect((await db.get('SELECT text FROM bug_events WHERE id = ?', 'e1')).text).toBe('first');
  });

  test('random interleavings converge (1000 edits, two orders)', async () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const ops: { tbl: 'bugs' | 'bug_events'; row: Row }[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `b${Math.floor(rand() * 20)}`;
      const t = `${String(1000 + i).padStart(15, '0')}-00000-d${Math.floor(rand() * 3)}`;
      const r = rand();
      if (r < 0.4) ops.push({ tbl: 'bugs', row: bug({ id, title: `t${i}`, hlc: t }) });
      else if (r < 0.7) ops.push({ tbl: 'bugs', row: bug({ id, status_code: `S${i}`, status_hlc: t }) });
      else if (r < 0.8) ops.push({ tbl: 'bugs', row: bug({ id, deleted_at: `x${i}`, hlc: t }) });
      else ops.push({ tbl: 'bug_events', row: { id: `e${i}`, bug_id: id, kind: 'comment', text: `c${i}` } });
    }
    const shuffled = [...ops];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = await freshDb();
    const b = await freshDb();
    for (const op of ops) await apply(a, op.tbl, op.row);
    for (const op of shuffled) await apply(b, op.tbl, op.row);
    for (const t of ['bugs', 'bug_events']) {
      const ra = await a.all(`SELECT * FROM ${t} ORDER BY id`);
      const rb = await b.all(`SELECT * FROM ${t} ORDER BY id`);
      expect(rb).toEqual(ra);
    }
  });
});
