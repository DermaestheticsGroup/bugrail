import { beforeAll, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { TABLES, type SyncedTable } from '../db/tables';
import { blobsFromJson, blockingProblems, diffKv, exportKv, statusCodeFromName, transformKv, writeServerDb, type KvBlobs, type Migrated } from '../lib/migrate/kv';
import { hashPassword, verifyPassword } from '../lib/server/password';
import { login } from '../lib/server/auth-routes';
import { resetRateLimit } from '../lib/server/rate-limit';
import { pull, push } from '../lib/sync/server';
import { SCHEMA_VERSION } from '../db/schema/index';
import type { Db } from '../lib/db-types';
import { legacyKv } from './fixtures/legacy-kv';

const NOW = Date.UTC(2026, 9, 13);
// scrypt per user is slow; a cheap deterministic hash keeps the structural tests fast. One test uses the real one.
const fastHash = async (p: string) => `scrypt$00$${Buffer.from(p).toString('hex')}`;
const fresh = async () => { const db = (await connect(':memory:')) as unknown as Db; await applyMigrations(db, 'server'); return db; };

let src: KvBlobs, m: Migrated, db: Db;
beforeAll(async () => {
  src = legacyKv(1);
  m = await transformKv(structuredClone(src), { now: NOW, hash: fastHash });
  db = await fresh();
  await writeServerDb(db, m);
});

describe('G4: counts', () => {
  test('row counts match the blob lengths', async () => {
    const n = async (t: string) => Number((await db.get(`SELECT count(*) AS n FROM ${t}`)).n);
    // +1 file: FILE-DEFAULT for the orphans
    expect(await n('files')).toBe(src.qa_files!.length + 1);
    expect(await n('testcases')).toBe(src.qa_testcases!.length);
    expect(await n('bugs')).toBe(src.qa_bugs!.length);
    expect(await n('activity_log')).toBe(src.qa_activity_log!.length);
    expect(await n('users')).toBe((src.qa_settings!.users as any[]).length);
  });

  test('per bug: timeline events = activity + comments + assignments', async () => {
    for (const b of src.qa_bugs!) {
      const want = (b.activity?.length ?? 0) + (b.comments?.length ?? 0) + (b.assignments?.length ?? 0);
      const got = Number((await db.get('SELECT count(*) AS n FROM bug_events WHERE bug_id = ?', b.id)).n);
      expect({ id: b.id, got }).toEqual({ id: b.id, got: want });
    }
  });

  test('codes are identical, including legacy duplicates', async () => {
    const codes = (rows: any[]) => Object.fromEntries(rows.map((r) => [r.id, r.code || null]));
    expect(Object.fromEntries((await db.all('SELECT id, code FROM bugs')).map((r: any) => [r.id, r.code]))).toEqual(codes(src.qa_bugs!.map((b) => ({ id: b.id, code: b.code }))));
    expect(m.report.duplicateCodes.map((d) => `${d.table}:${d.code}`).sort()).toEqual(['bugs:BUG-0003', 'testcases:LOG-0001'].sort());
  });
});

describe('G4: round trip', () => {
  test('exported blobs equal the originals except normalized fields, passwords and theme', async () => {
    const { blobs } = await exportKv(db, { originalSettings: src.qa_settings });
    const diffs = diffKv(src, blobs as KvBlobs, [
      /\.password$/, /^qa_settings\.theme$/,
      /\.status$/, /\.priority$/,           // 'Not Run'/'Highest' normalized (checked precisely below)
    ]);
    // What is left must be only the intentional changes: orphans pointed at the new Default file, Internal homes removed again,
    // the master list filled in, role permissions merged with defaults, legacy workspaceId folded into workspaceIds.
    const unexpected = diffs.filter((d) =>
      !/^qa_files\.length$/.test(d.path) && !/^qa_testcases\[\d+\]\.fileId$/.test(d.path) && !/^qa_bugs\[\d+\]\.fileId$/.test(d.path)
      && !/^qa_settings\.(bugStatusMaster|rolePermissions)/.test(d.path) && !/^qa_settings\.users\[\d+\]\.(workspaceId|workspaceIds)/.test(d.path)
      && !/^qa_settings\.users\[\d+\]\.(lastSeen|email)$/.test(d.path) && !/^qa_settings\.geminiApiKey$/.test(d.path));
    expect(unexpected).toEqual([]);
  });

  test('normalizations are exactly the specified ones', async () => {
    const { blobs } = await exportKv(db, { originalSettings: src.qa_settings });
    const tcs = new Map(blobs.qa_testcases.map((t) => [t.id, t]));
    for (const t of src.qa_testcases!) {
      const want = t.status === 'Not Run' ? 'Open' : t.status;
      expect(tcs.get(t.id)!.status).toBe(want);
    }
    const bugs = new Map(blobs.qa_bugs.map((b) => [b.id, b]));
    for (const b of src.qa_bugs!) {
      const want = b.priority === 'Highest' || b.priority === 'Critical' ? 'Urgent' : b.priority;
      expect(bugs.get(b.id)!.priority).toBe(want);
      expect(bugs.get(b.id)!.status).toBe(b.status);
    }
  });

  test('unmapped and non-string fields survive through extra', async () => {
    const { blobs } = await exportKv(db, { originalSettings: src.qa_settings });
    const b6 = blobs.qa_bugs.find((b) => b.id === 'BUG-6')!;
    expect(b6.os).toBe('Android 14');
    expect(b6.estimate).toBe(5);
    expect(blobs.qa_testcases.find((t) => t.id === 'TC-5')!.legacyFlag).toBe(true);
  });

  test('event order inside each array is preserved', async () => {
    const { blobs } = await exportKv(db, { originalSettings: src.qa_settings });
    for (const b of src.qa_bugs!) {
      const out = blobs.qa_bugs.find((x) => x.id === b.id)!;
      expect((out.activity ?? []).map((e: any) => e.at)).toEqual((b.activity ?? []).map((e: any) => e.at));
      expect((out.comments ?? []).map((e: any) => e.text)).toEqual((b.comments ?? []).map((e: any) => e.text));
    }
  });

  test('a diff really fails on a tampered export', async () => {
    const { blobs } = await exportKv(db, { originalSettings: src.qa_settings });
    (blobs.qa_bugs[0] as any).title = 'tampered';
    expect(diffKv(src, blobs as KvBlobs).some((d) => d.path === 'qa_bugs[0].title')).toBe(true);
  });
});

describe('status codes', () => {
  test('unknown names (legacy Reopened) get master rows with generated codes; events and bugs use codes', async () => {
    expect(m.report.unknownStatusesAdded).toEqual([{ code: 'REOPENED', name: 'Reopened' }]);
    expect((await db.get("SELECT name FROM bug_status_master WHERE id = 'REOPENED'")).name).toBe('Reopened');
    const codes = new Set((await db.all('SELECT DISTINCT status_code AS c FROM bugs')).map((r: any) => r.c));
    for (const c of codes) expect(c).toMatch(/^[A-Z_0-9]+$/);
    expect(codes.has('IN_PROGRESS')).toBe(true);
    const ev = await db.get("SELECT to_status FROM bug_events WHERE kind = 'status' AND to_status = 'REOPENED' LIMIT 1");
    expect(ev.to_status).toBe('REOPENED');
  });
  test('masterstatus code rule', () => {
    expect(statusCodeFromName(' On hold! ', new Set())).toBe('ON_HOLD');
    expect(statusCodeFromName('Open', new Set(['OPEN']))).toBe('OPEN_2');
    expect(statusCodeFromName('???', new Set())).toBe('STATUS');
  });
});

describe('workspaces and files', () => {
  test('files with no workspace move into Internal; non-vendors (not admin) join it; vendors do not', async () => {
    expect(m.report.movedToInternal.sort()).toEqual(['FILE-DEFAULT', 'FILE-OLD']);
    expect(m.report.internalWorkspaceCreated).toBe(true);
    const ws = (email: string): string[] => JSON.parse(String(m.users.find((u) => u.email === email)!.workspace_ids));
    expect(ws('ann@x.test')).toEqual(['ws-a', 'ws-internal']);
    expect(ws('bob@x.test')).toEqual(['ws-a', 'ws-internal']); // legacy single workspaceId folded in
    expect(ws('vic@v.test')).toEqual(['ws-v']);
    expect(ws('root@x.test')).toEqual([]);
  });
  test('sharedWith becomes file_shares with the file_id:workspace_id key', async () => {
    expect((await db.all('SELECT id, file_id, workspace_id FROM file_shares')).map((r: any) => ({ ...r }))).toEqual([{ id: 'FILE-A1:ws-v', file_id: 'FILE-A1', workspace_id: 'ws-v' }]);
  });
  test('orphan rows land in FILE-DEFAULT and are counted', () => {
    expect(m.report.orphansToDefaultFile).toEqual({ testcases: 1, bugs: 1 });
  });
});

describe('server_seq, hlc and secrets', () => {
  test('every row has a server_seq and one migration HLC; sync seq equals the highest', async () => {
    const seqs: number[] = [];
    for (const t of ['files', 'file_shares', 'testcases', 'bugs', 'bug_events', 'bug_status_master', 'custom_field_defs', 'activity_log']) {
      const hasHlc = TABLES[t as SyncedTable].columns.includes('hlc');
      for (const r of await db.all(`SELECT server_seq${hasHlc ? ', hlc' : ''} FROM ${t}`)) {
        seqs.push(Number(r.server_seq));
        if (hasHlc) expect(r.hlc).toBe(`${String(NOW).padStart(15, '0')}-00000-migrate`);
      }
    }
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(Number((await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value)).toBe(Math.max(...seqs));
  });
  test('gemini key trimmed, merged permissions kept, theme dropped with a warning', async () => {
    expect((await db.get("SELECT value FROM secrets WHERE key = 'gemini_api_key'")).value).toBe('gem-key');
    const perms = JSON.parse((await db.get("SELECT value FROM secrets WHERE key = 'role_permissions'")).value);
    expect(perms.qa_vendor.bugreport_create).toBe(true);
    expect(perms.qa_vendor.testcase_read).toBe(true); // default merged under the saved override
    expect(m.report.warnings.join('\n')).toMatch(/theme dropped/);
    expect(m.report.warnings.join('\n')).toMatch(/qa_counters not migrated/);
  });
});

describe('writer safety', () => {
  test('refuses a database that already has data', async () => {
    await expect(writeServerDb(db, m)).rejects.toThrow(/non-empty/);
  });
  test('a failed write leaves the database empty', async () => {
    const d = await fresh();
    const bad = { ...m, users: [{ ...m.users[0] }, { ...m.users[0] }] }; // duplicate email: unique index rejects the second
    await expect(writeServerDb(d, bad)).rejects.toThrow();
    expect(await d.get('SELECT 1 FROM files LIMIT 1')).toBeUndefined();
  });
});

describe('G4: every migrated user logs in with their old password', () => {
  test('real scrypt hashes verify, through the real login path', async () => {
    resetRateLimit();
    const real = await transformKv(structuredClone(src), { now: NOW, hash: hashPassword });
    const d = await fresh();
    await writeServerDb(d, real);
    for (const u of src.qa_settings!.users as any[]) {
      if (!u.password) { expect(await login(d, null, u.email, 'anything')).toMatchObject({ ok: false }); continue; }
      expect((await login(d, null, u.email, u.password)).ok).toBe(true);
      expect((await login(d, null, u.email, u.password + 'x')).ok).toBe(false);
    }
    expect(real.report.usersHashed).toBe(5);
    expect(real.report.usersWithoutPassword).toEqual(['nopw@x.test']);
  });
});

describe('export passwords', () => {
  test('cutover users get the old plaintext; later users get a printed temporary one', async () => {
    const d = await fresh();
    await writeServerDb(d, m);
    await d.run("INSERT INTO users (id, email, role, workspace_ids, password_hash, session_version, access_version) VALUES ('new1', 'new@x.test', 'qa_internal', '[]', 'x', 0, 0)");
    const { blobs, tempPasswords } = await exportKv(d, { originalSettings: src.qa_settings, tempPassword: () => 'TEMP-1' });
    const users = blobs.qa_settings.users as any[];
    expect(users.find((u) => u.email === 'ann@x.test').password).toBe('annpw-1');
    expect(users.find((u) => u.email === 'new@x.test').password).toBe('TEMP-1');
    expect(tempPasswords).toEqual({ 'new@x.test': 'TEMP-1', 'nopw@x.test': 'TEMP-1' });
  });
  test('Internal is removed again on export', async () => {
    const { blobs } = await exportKv(db, { originalSettings: src.qa_settings });
    expect((blobs.qa_settings.workspaces as any[]).map((w) => w.id)).toEqual(['ws-a', 'ws-v']);
    expect(blobs.qa_files.find((f) => f.id === 'FILE-OLD')!.workspaceId).toBeUndefined();
    expect((blobs.qa_settings.users as any[]).find((u) => u.email === 'ann@x.test').workspaceIds).toEqual(['ws-a']);
  });
});

describe('migrated data works with the sync server', () => {
  test('a migrated QA user pulls only visible rows; a push of a new bug gets the next code', async () => {
    const d = await fresh();
    await writeServerDb(d, m);
    const ann = { id: String(m.users.find((u) => u.email === 'ann@x.test')!.id), email: 'ann@x.test', role: 'qa_internal', workspaceIds: ['ws-a', 'ws-internal'] };
    const vic = { id: String(m.users.find((u) => u.email === 'vic@v.test')!.id), email: 'vic@v.test', role: 'qa_vendor', workspaceIds: ['ws-v'] };
    const page = async (u: typeof ann) => { const r = await pull(d, u, 0, 0, SCHEMA_VERSION, 2000); if ('reset' in r) throw new Error('reset'); return r.rows; };
    const vicFiles = (await page(vic)).filter((r) => r.tbl === 'files').map((r) => r.row.id).sort();
    expect(vicFiles).toEqual(['FILE-A1', 'FILE-V1']); // own + shared, never FILE-OLD (Internal)
    const h = `${String(NOW + 1000).padStart(15, '0')}-00000-a`;
    const r = await push(d, ann, [{ tbl: 'bugs', row: { id: 'NEW-1', file_id: 'FILE-A1', title: 'n', status_code: 'OPEN', status_hlc: h, hlc: h } }]);
    expect(r.rejected).toEqual([]);
    const code = (await d.get("SELECT code FROM bugs WHERE id = 'NEW-1'")).code;
    expect(code).toMatch(/^BUG-\d{4}$/);
  });
});

describe('robustness', () => {
  test('empty and sparse input does not throw', async () => {
    const e = await transformKv({}, { now: NOW, hash: fastHash });
    expect(e.report.counts.bugs).toBe(0);
    expect(e.tables.bug_status_master.map((r) => r.id)).toEqual(['OPEN', 'IN_PROGRESS', 'RETEST', 'RESOLVED', 'CLOSED', 'REJECTED']);
    const d = await fresh();
    await writeServerDb(d, e);
    expect((await exportKv(d)).blobs.qa_bugs).toEqual([]);
  });
  test('a malformed event entry is skipped with a warning, not fatal', async () => {
    const r = await transformKv({ qa_files: [{ id: 'F', name: 'f', workspaceId: 'w' }], qa_bugs: [{ id: 'B', fileId: 'F', status: 'Open', comments: ['oops', { at: 't', text: 'ok' }] }] }, { now: NOW, hash: fastHash });
    expect(r.tables.bug_events.length).toBe(1);
    expect(r.report.warnings.join()).toMatch(/comment entry 0/);
  });
  test('duplicate and empty emails are skipped with warnings and write one row', async () => {
    const r = await transformKv({ qa_settings: { users: [{ email: 'A@x.test', password: 'p', role: 'admin' }, { email: ' a@X.test ', password: 'q' }, { email: '', password: 'r' }] } }, { now: NOW, hash: fastHash });
    expect(r.report.warnings.join('|')).toMatch(/duplicate email/);
    expect(r.report.warnings.join('|')).toMatch(/empty email/);
    const d = await fresh();
    await writeServerDb(d, r);
    expect((await d.all('SELECT id FROM users')).length).toBe(1);
  });
  test('unknown customFieldDefs keys are reported as dropped', async () => {
    const r = await transformKv({ qa_settings: { customFieldDefs: [{ label: 'L', type: 'text' }] } }, { now: NOW, hash: fastHash });
    expect(r.report.droppedKeys).toContain('custom_field_defs.type');
  });
  test('default temp password is a distinct CSPRNG value of 12+ chars', async () => {
    const d = await fresh();
    await writeServerDb(d, m);
    await d.run("INSERT INTO users (id, email, role, workspace_ids, password_hash, session_version, access_version) VALUES ('new1', 'new@x.test', 'qa_internal', '[]', 'x', 0, 0)");
    const { tempPasswords } = await exportKv(d, { originalSettings: src.qa_settings });
    const vals = Object.values(tempPasswords);
    expect(vals.length).toBeGreaterThan(1);
    expect(new Set(vals).size).toBe(vals.length);
    for (const v of vals) expect(v).toMatch(/^[A-Za-z0-9_-]{16,}$/);
  });
  test('a larger dataset round-trips with no diffs beyond the known ones', async () => {
    const big = legacyKv(7, 400);
    const mm = await transformKv(structuredClone(big), { now: NOW, hash: fastHash });
    const d = await fresh();
    await writeServerDb(d, mm);
    const { blobs } = await exportKv(d, { originalSettings: big.qa_settings });
    const bugDiffs = diffKv({ qa_bugs: big.qa_bugs }, { qa_bugs: blobs.qa_bugs } as KvBlobs, [/\.priority$/, /\.fileId$/]);
    expect(bugDiffs).toEqual([]);
  });
});

describe('blobsFromJson', () => {
  test('accepts the /api/kv body and a mongoexport array', () => {
    expect(blobsFromJson('{"qa_bugs":[{"id":"B"}],"_revs":{"qa_bugs":3}}')).toEqual({ qa_bugs: [{ id: 'B' }] });
    expect(blobsFromJson('[{"_id":"qa_bugs","value":[{"id":"B"}],"rev":3}]')).toEqual({ qa_bugs: [{ id: 'B' }] });
  });
});

describe('review hardening', () => {
  test('a legacy workspace named Internal aborts the migration when files need a home', async () => {
    const blobs = { qa_files: [{ id: 'F', name: 'f' }], qa_settings: { workspaces: [{ id: 'w1', name: ' internal ' }] } };
    await expect(transformKv(blobs, { now: NOW, hash: fastHash })).rejects.toThrow(/already named "Internal"/);
    // no homeless file, no conflict
    const ok = await transformKv({ qa_files: [{ id: 'F', name: 'f', workspaceId: 'w1' }], qa_settings: blobs.qa_settings }, { now: NOW, hash: fastHash });
    expect(ok.report.internalWorkspaceCreated).toBe(false);
  });
  test('skipped users are blocking problems', async () => {
    const r = await transformKv({ qa_settings: { users: [{ email: 'a@x.test', password: 'p' }, { email: 'A@x.test', password: 'q' }, { email: '' }] } }, { now: NOW, hash: fastHash });
    expect(r.report.skippedUsers).toEqual(['A@x.test'.toLowerCase(), '(empty email)']);
    expect(blockingProblems(r.report).length).toBe(2);
    expect(blockingProblems((await transformKv({}, { now: NOW, hash: fastHash })).report)).toEqual([]);
  });
  test('custom field defs export in server_seq order, not id order', async () => {
    const d = await fresh();
    await writeServerDb(d, await transformKv({ qa_settings: { customFieldDefs: [{ label: 'First' }, { label: 'Second' }] } }, { now: NOW, hash: fastHash }));
    // a def created after cutover with an id that sorts first
    await d.run("INSERT INTO custom_field_defs (id, label, hlc, server_seq) VALUES ('aaa', 'Third', 'h', 99)");
    const labels = ((await exportKv(d)).blobs.qa_settings.customFieldDefs as { label: string }[]).map((x) => x.label);
    expect(labels).toEqual(['First', 'Second', 'Third']);
  });
});
