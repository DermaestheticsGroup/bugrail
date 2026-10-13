import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applySchema } from '../lib/schema';
import { pull, push } from '../lib/sync/server';
import { USERS } from '../lib/sync/users';
import type { Db, Row } from '../lib/db-types';

let db: Db;
const h = (ms: number, dev = 'a') => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const file = (id: string, ws: string, over: Row = {}): Row => ({ id, name: id, workspace_id: ws, hlc: h(1), ...over });
const bug = (id: string, fileId: string, over: Row = {}): Row => ({
  id, file_id: fileId, title: id, module: 'Login', status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over,
});

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applySchema(db, ['schema', 'server']);
  await push(db, USERS.admin, [
    { tbl: 'files', row: file('fa', 'ws-a') },
    { tbl: 'files', row: file('fv', 'ws-v') },
    { tbl: 'bugs', row: bug('ba', 'fa') },
    { tbl: 'bugs', row: bug('bv', 'fv') },
    { tbl: 'bug_events', row: { id: 'ea', bug_id: 'ba', kind: 'comment', text: 'secret' } },
  ]);
});

describe('push', () => {
  test('accepts rows, bumps server_seq, assigns codes per workspace', async () => {
    const all = await pull(db, USERS.admin, 0);
    expect(all.rows.length).toBe(5);
    expect(all.next).toBe(7); // 5 inserts + 2 code assignments
    const ba = await db.get('SELECT code FROM bugs WHERE id = ?', 'ba');
    const bv = await db.get('SELECT code FROM bugs WHERE id = ?', 'bv');
    expect(ba.code).toBe('BUG-0001');
    expect(bv.code).toBe('BUG-0001'); // separate scope (ws-v)
  });

  test('returns the server row when the server assigned a code', async () => {
    const r = await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b2', 'fa', { hlc: h(5) }) }]);
    expect(r.accepted).toEqual(['b2']);
    expect(r.server.find((s) => s.row.id === 'b2')?.row.code).toBe('BUG-0002');
  });

  test('ignores a client-supplied code and server_seq', async () => {
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b3', 'fa', { code: 'BUG-9999', server_seq: 1e9, hlc: h(5) }) }]);
    const row = await db.get('SELECT code, server_seq FROM bugs WHERE id = ?', 'b3');
    expect(row.code).toBe('BUG-0002');
    expect(row.server_seq).toBeLessThan(1e9);
  });

  test('older write loses and the server row comes back', async () => {
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('ba', 'fa', { title: 'newer', hlc: h(10, 'b') }) }]);
    const r = await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('ba', 'fa', { title: 'older', hlc: h(5, 'c') }) }]);
    expect(r.accepted).toEqual(['ba']);
    expect(r.server[0].row.title).toBe('newer');
  });

  // Review Focus 2
  test('the same push twice changes nothing the second time', async () => {
    const rows = [{ tbl: 'bugs', row: bug('b4', 'fa', { hlc: h(7) }) }];
    await push(db, USERS.alice, rows);
    const seqBefore = (await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value;
    await push(db, USERS.alice, rows);
    const seqAfter = (await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value;
    expect(seqAfter).toBe(seqBefore);
  });

  // Review Focus 1
  test('unknown or malicious table names are rejected, not executed', async () => {
    const r = await push(db, USERS.admin, [
      { tbl: 'sqlite_master', row: { id: 'x', hlc: h(9) } },
      { tbl: 'files; DROP TABLE bugs', row: { id: 'y', hlc: h(9) } },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['unknown table', 'unknown table']);
    expect((await db.get('SELECT count(*) AS n FROM bugs')).n).toBe(2);
  });

  // Review Focus 4
  test('rows without id, hlc or status_hlc are rejected', async () => {
    const r = await push(db, USERS.alice, [
      { tbl: 'bugs', row: { file_id: 'fa', hlc: h(9), status_hlc: h(9) } },
      { tbl: 'bugs', row: { id: 'n1', file_id: 'fa', status_hlc: h(9) } },
      { tbl: 'bugs', row: { id: 'n2', file_id: 'fa', hlc: h(9) } },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['missing id', 'missing hlc', 'missing status_hlc']);
  });
});

describe('isolation', () => {
  test('a non-admin with no workspaces sees nothing and writes nothing', async () => {
    const nobody = { id: 'n', email: 'n@x.test', role: 'user' as const, workspaceIds: [] };
    expect((await pull(db, nobody, 0)).rows).toEqual([]);
    const r = await push(db, nobody, [
      { tbl: 'files', row: file('fn', 'ws-a', { hlc: h(9) }) },
      { tbl: 'bugs', row: bug('bn', 'fa', { hlc: h(9) }) },
    ]);
    expect(r.accepted).toEqual([]);
  });

  test('vendor pull contains only ws-v rows', async () => {
    const r = await pull(db, USERS.vendor, 0);
    expect(r.rows.map((x) => x.row.id).sort()).toEqual(['bv', 'fv']);
  });

  test('vendor cannot write into another workspace', async () => {
    const r = await push(db, USERS.vendor, [
      { tbl: 'files', row: file('fx', 'ws-a', { hlc: h(9) }) },
      { tbl: 'bugs', row: bug('bx', 'fa', { hlc: h(9) }) },
      { tbl: 'bugs', row: bug('ba', 'fa', { title: 'hacked', hlc: h(99) }) },
      { tbl: 'bug_events', row: { id: 'ex', bug_id: 'ba', kind: 'comment', text: 'x' } },
      { tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } },
    ]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.length).toBe(5);
    expect((await db.get('SELECT title FROM bugs WHERE id = ?', 'ba')).title).toBe('ba');
  });

  test('a file shared into ws-v becomes visible to the vendor, and unsharing hides it', async () => {
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } }]);
    let ids = (await pull(db, USERS.vendor, 0)).rows.map((x) => x.row.id);
    expect(ids).toContain('fa');
    expect(ids).toContain('ba');
    expect(ids).toContain('ea');
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(10), deleted_at: 'now' } }]);
    ids = (await pull(db, USERS.vendor, 0)).rows.map((x) => x.row.id);
    expect(ids).not.toContain('fa');
    expect(ids).not.toContain('ba');
  });

  test('vendor can write inside a file shared into ws-v', async () => {
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } }]);
    const r = await push(db, USERS.vendor, [{ tbl: 'bugs', row: bug('bnew', 'fa', { hlc: h(12) }) }]);
    expect(r.accepted).toEqual(['bnew']);
  });
});

describe('pull', () => {
  test('pages by server_seq with no gaps or duplicates', async () => {
    const seen: string[] = [];
    let since = 0;
    for (;;) {
      const page = await pull(db, USERS.admin, since, 2);
      seen.push(...page.rows.map((r) => r.row.id as string));
      since = page.next;
      if (!page.more) break;
    }
    expect(seen.sort()).toEqual(['ba', 'bv', 'ea', 'fa', 'fv']);
  });
});
