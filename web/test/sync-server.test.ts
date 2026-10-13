import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers, type User } from '../lib/sync/users';
import { SCHEMA_VERSION } from '../db/schema/index';
import type { Db, Row } from '../lib/db-types';

let db: Db;
// Pull with matching av/sv; a reset here would be a test failure.
async function pullPage(u: User, since: number, av: number, sv: number, limit?: number) {
  const r = await pull(db, u, since, av, sv, limit);
  if ('reset' in r) throw new Error('unexpected reset');
  return r;
}
const h = (ms: number, dev = 'a') => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const file = (id: string, ws: string, over: Row = {}): Row => ({ id, name: id, workspace_id: ws, hlc: h(1), ...over });
const bug = (id: string, fileId: string, over: Row = {}): Row => ({
  id, file_id: fileId, title: id, module: 'Login', status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over,
});

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'server');
  await seedUsers(db);
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
    const all = await pullPage(USERS.admin, 0, 0, SCHEMA_VERSION);
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
    await db.run("INSERT INTO users (id, access_version) VALUES ('n', 0)");
    expect((await pullPage(nobody, 0, 0, SCHEMA_VERSION)).rows).toEqual([]);
    const r = await push(db, nobody, [
      { tbl: 'files', row: file('fn', 'ws-a', { hlc: h(9) }) },
      { tbl: 'bugs', row: bug('bn', 'fa', { hlc: h(9) }) },
    ]);
    expect(r.accepted).toEqual([]);
  });

  test('vendor pull contains only ws-v rows', async () => {
    const r = await pullPage(USERS.vendor, 0, 0, SCHEMA_VERSION);
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
    let ids = (await pullPage(USERS.vendor, 0, 1, SCHEMA_VERSION)).rows.map((x) => x.row.id);
    expect(ids).toContain('fa');
    expect(ids).toContain('ba');
    expect(ids).toContain('ea');
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(10), deleted_at: 'now' } }]);
    ids = (await pullPage(USERS.vendor, 0, 2, SCHEMA_VERSION)).rows.map((x) => x.row.id);
    expect(ids).not.toContain('fa');
    expect(ids).not.toContain('ba');
  });

  test('share id collision cannot rewrite another workspace share', async () => {
    await push(db, USERS.admin, [{ tbl: 'file_shares', row: { id: 'fv:ws-a', file_id: 'fv', workspace_id: 'ws-a', hlc: h(2) } }]);
    const r = await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fv:ws-a', file_id: 'fa', workspace_id: 'ws-v', hlc: h(50) } }]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.length).toBe(1);
    const row = await db.get('SELECT file_id, workspace_id FROM file_shares WHERE id = ?', 'fv:ws-a');
    expect(row).toEqual({ file_id: 'fv', workspace_id: 'ws-a' });
  });

  test('share cannot change file_id or workspace_id on an owned share', async () => {
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(2) } }]);
    const r = await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-x', hlc: h(3) } }]);
    expect(r.accepted).toEqual([]);
  });

  test('vendor cannot move a bug to another visible file', async () => {
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } }]);
    const r = await push(db, USERS.vendor, [{ tbl: 'bugs', row: bug('bv', 'fa', { hlc: h(20) }) }]);
    expect(r.accepted).toEqual([]);
    expect((await db.get('SELECT file_id FROM bugs WHERE id = ?', 'bv')).file_id).toBe('fv');
  });

  test('rows beyond MAX_PUSH are rejected, malformed rows rejected', async () => {
    const many = Array.from({ length: 502 }, (_, i) => ({ tbl: 'bugs', row: bug(`m${i}`, 'fa', { hlc: h(30) }) }));
    const r = await push(db, USERS.alice, many);
    expect(r.accepted.length + r.rejected.length).toBe(502);
    expect(r.rejected.length).toBe(2);
    const bad = await push(db, USERS.alice, [null, { tbl: 'bugs', row: bug('z', 'fa', { file_id: { x: 1 } }) }]);
    expect(bad.rejected.length).toBe(2);
  });

  test('pull limit below 1 is clamped', async () => {
    const r = await pullPage(USERS.admin, 0, 0, SCHEMA_VERSION, 0);
    expect(r.rows.length).toBe(1);
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
      const page = await pullPage(USERS.admin, since, 0, SCHEMA_VERSION, 2);
      seen.push(...page.rows.map((r) => r.row.id as string));
      since = page.next;
      if (!page.more) break;
    }
    expect(seen.sort()).toEqual(['ba', 'bv', 'ea', 'fa', 'fv']);
  });
});

describe('trust boundary', () => {
  test('bug_events id owned by another workspace is rejected and never echoed', async () => {
    await push(db, USERS.admin, [{ tbl: 'bug_events', row: { id: 'ev-v', bug_id: 'bv', kind: 'comment', text: 'vsecret' } }]);
    const r = await push(db, USERS.alice, [{ tbl: 'bug_events', row: { id: 'ev-v', bug_id: 'ba', kind: 'comment', text: 'mine' } }]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.map((x) => x.id)).toEqual(['ev-v']);
    expect(r.server.find((s) => s.row.id === 'ev-v')).toBeUndefined();
    expect((await db.get('SELECT bug_id FROM bug_events WHERE id = ?', 'ev-v')).bug_id).toBe('bv');
  });

  test('own idempotent re-push of a bug_event is still accepted', async () => {
    const row = { id: 'ea', bug_id: 'ba', kind: 'comment', text: 'secret' };
    const r = await push(db, USERS.alice, [{ tbl: 'bug_events', row }]);
    expect(r.accepted).toEqual(['ea']);
    expect(r.rejected).toEqual([]);
  });

  test('malformed or far-future hlc is rejected, normal hlc accepted', async () => {
    const far = h(Date.now() + 48 * 3600_000);
    const r = await push(db, USERS.alice, [
      { tbl: 'bugs', row: bug('h1', 'fa', { hlc: 'zzz' }) },
      { tbl: 'bugs', row: bug('h2', 'fa', { hlc: far }) },
      { tbl: 'bugs', row: bug('h3', 'fa', { status_hlc: 'zzz' }) },
      { tbl: 'bugs', row: bug('h4', 'fa', { hlc: h(Date.now()) }) },
    ]);
    expect(r.rejected.map((x) => x.id)).toEqual(['h1', 'h2', 'h3']);
    expect(r.accepted).toEqual(['h4']);
  });
});
