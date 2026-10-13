import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { createBug, createFile, createTestcase, type Ctx } from '../lib/client/repo';
import { bulkTestcaseDelete, bulkTestcaseStatus, countInFile, deleteFileCascade, duplicateTestcase, executeTestcase, fileShares, renameFile, saveTestcase, setFileShares, todayISO } from '../lib/client/files-testcase';
import { defaultTcUi, filterTestcases, paginate, sortColumn, uniqueValues } from '../lib/client/testcase-model';
import { pullAll, pushOutbox, type Transport } from '../lib/sync/client';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import type { Db, Row } from '../lib/db-types';

let server: Db, local: Db, ctx: Ctx;
const t = (u: keyof typeof USERS): Transport => ({ push: (r) => push(server, USERS[u], r), pull: (s, a, v) => pull(server, USERS[u], s, a, v) });
const sync = async (u: keyof typeof USERS = 'alice') => { await pushOutbox(local, t(u)); await pullAll(local, t(u)); };
const make = async () => { const d = (await connect(':memory:')) as unknown as Db; await applyMigrations(d, 'local'); return d; };

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(server, 'server');
  await seedUsers(server);
  local = await make();
  ctx = { db: local, clock: createClock('d1'), email: 'alice@bugrail.test', role: 'qa_internal', memberOf: ['ws-a'] };
});

describe('files', () => {
  test('rename changes the name, logs it, and is a no-op when unchanged', async () => {
    const f = await createFile(ctx, 'ws-a', 'Old');
    await renameFile(ctx, String(f.id), '  New  ');
    expect((await local.get('SELECT name FROM files WHERE id = ?', f.id)).name).toBe('New');
    const before = Number((await local.get('SELECT count(*) AS n FROM outbox')).n);
    await renameFile(ctx, String(f.id), 'New');
    expect(Number((await local.get('SELECT count(*) AS n FROM outbox')).n)).toBe(before);
    expect((await local.all("SELECT label FROM activity_log WHERE action = 'tc_file_rename'")).length).toBe(1);
    await expect(renameFile(ctx, String(f.id), '  ')).rejects.toThrow('Name is required');
  });

  test('sharing: add, revive the same row after removal, ignore the owner workspace, tombstone on remove', async () => {
    const f = await createFile(ctx, 'ws-a', 'F');
    const id = String(f.id);
    expect(await setFileShares(ctx, id, ['ws-v', 'ws-a'])).toEqual({ added: 1, removed: 0 });
    expect(await fileShares(ctx, id)).toEqual(['ws-v']);
    expect(await setFileShares(ctx, id, [])).toEqual({ added: 0, removed: 1 });
    expect(await fileShares(ctx, id)).toEqual([]);
    expect(await setFileShares(ctx, id, ['ws-v'])).toEqual({ added: 1, removed: 0 });
    expect((await local.all('SELECT id FROM file_shares')).map((r) => r.id)).toEqual([`${id}:ws-v`]); // one row, revived
    expect(await setFileShares(ctx, id, ['ws-v'])).toEqual({ added: 0, removed: 0 });
  });

  test('a share reaches the vendor and its removal takes the file away again', async () => {
    const f = await createFile(ctx, 'ws-a', 'Shared');
    await createTestcase(ctx, String(f.id), { module: 'Login', scenario: 's' });
    await setFileShares(ctx, String(f.id), ['ws-v']);
    await sync('alice');
    const vendor = await make();
    const vctx = { ...ctx, db: vendor };
    void vctx;
    await pullAll(vendor, t('vendor'));
    expect((await vendor.all('SELECT id FROM files')).map((r) => r.id)).toEqual([f.id]);
    expect(Number((await vendor.get('SELECT count(*) AS n FROM testcases')).n)).toBe(1);
    await setFileShares(ctx, String(f.id), []);
    await sync('alice');
    await pullAll(vendor, t('vendor'));
    expect(await vendor.all('SELECT id FROM files')).toEqual([]);
    expect(Number((await vendor.get('SELECT count(*) AS n FROM testcases')).n)).toBe(0);
  });

  test('cascade delete tombstones the file, its test cases and its bugs, and reports the counts', async () => {
    const f = await createFile(ctx, 'ws-a', 'Doomed');
    const other = await createFile(ctx, 'ws-a', 'Safe');
    await createTestcase(ctx, String(f.id), { module: 'M', scenario: 'a' });
    await createTestcase(ctx, String(f.id), { module: 'M', scenario: 'b' });
    await createBug(ctx, String(f.id), { title: 'x' });
    const keep = await createTestcase(ctx, String(other.id), { module: 'M', scenario: 'keep' });
    expect(await countInFile(ctx, String(f.id))).toEqual({ testcases: 2, bugs: 1 });
    expect(await deleteFileCascade(ctx, String(f.id))).toEqual({ testcases: 2, bugs: 1 });
    expect(await countInFile(ctx, String(f.id))).toEqual({ testcases: 0, bugs: 0 });
    expect((await local.get('SELECT deleted_at FROM files WHERE id = ?', f.id)).deleted_at).toBeTruthy();
    expect((await local.get('SELECT deleted_at FROM testcases WHERE id = ?', keep.id)).deleted_at).toBeNull();
    await sync();
    expect(Number((await server.get('SELECT count(*) AS n FROM testcases WHERE deleted_at IS NOT NULL')).n)).toBe(2);
  });
});

describe('test cases', () => {
  let fid: string;
  beforeEach(async () => { fid = String((await createFile(ctx, 'ws-a', 'F')).id); });

  test('save validates, creates Open, and stores custom fields as JSON', async () => {
    await expect(saveTestcase(ctx, fid, { module: ' ', scenario: 's' })).rejects.toThrow('Module is required');
    await expect(saveTestcase(ctx, fid, { module: 'M', scenario: '' })).rejects.toThrow('Scenario is required');
    const r = await saveTestcase(ctx, fid, { module: 'Login', scenario: 'Happy', custom_fields: { Sprint: '12' } });
    expect(r.status).toBe('Open');
    expect(JSON.parse(String(r.custom_fields))).toEqual({ Sprint: '12' });
  });

  test('editing changes only the given fields and never the status', async () => {
    const r = await saveTestcase(ctx, fid, { module: 'Login', scenario: 'Happy' });
    await executeTestcase(ctx, String(r.id), { status: 'Passed', actual_result: 'ok', evidence: '' });
    await saveTestcase(ctx, fid, { module: 'Login', scenario: 'Renamed' }, String(r.id));
    const row = await local.get('SELECT * FROM testcases WHERE id = ?', r.id);
    expect(row.scenario).toBe('Renamed');
    expect(row.status).toBe('Passed');
    expect(row.actual_result).toBe('ok');
  });

  test('execute records the result, stamps today, advances the status clock, logs only a real status change', async () => {
    const r = await saveTestcase(ctx, fid, { module: 'M', scenario: 's' });
    const before = await local.get('SELECT status_hlc FROM testcases WHERE id = ?', r.id);
    await executeTestcase(ctx, String(r.id), { status: 'Failed', actual_result: ' boom ', evidence: ' http://x ' });
    const row = await local.get('SELECT * FROM testcases WHERE id = ?', r.id);
    expect([row.status, row.actual_result, row.evidence, row.execution_date]).toEqual(['Failed', 'boom', 'http://x', todayISO()]);
    expect(String(row.status_hlc) > String(before.status_hlc)).toBe(true);
    await executeTestcase(ctx, String(r.id), { status: 'Failed', actual_result: 'again', evidence: '' });
    expect((await local.all("SELECT label FROM activity_log WHERE label LIKE '%(Run)%'")).length).toBe(1);
    await expect(executeTestcase(ctx, 'nope', { status: 'Open', actual_result: '', evidence: '' })).rejects.toThrow('No such test case');
  });

  test('duplicate copies the content, resets the result, and the server numbers it', async () => {
    const r = await saveTestcase(ctx, fid, { module: 'Login', scenario: 'Happy', steps: '<ol><li>go</li></ol>' });
    await executeTestcase(ctx, String(r.id), { status: 'Passed', actual_result: 'ok', evidence: 'e' });
    await sync();
    const orig = await local.get('SELECT code FROM testcases WHERE id = ?', r.id);
    expect(orig.code).toBe('LOG-0001');
    const d = await duplicateTestcase(ctx, String(r.id));
    expect(d.code).toBeNull();
    expect([d.status, d.actual_result, d.evidence, d.execution_date]).toEqual(['Open', '', '', '']);
    expect([d.scenario, d.steps]).toEqual(['Happy', '<ol><li>go</li></ol>']);
    await sync();
    expect((await local.get('SELECT code FROM testcases WHERE id = ?', d.id)).code).toBe('LOG-0002');
  });

  test('bulk status skips rows already in that status; bulk delete tombstones', async () => {
    const a = await saveTestcase(ctx, fid, { module: 'M', scenario: 'a' });
    const b = await saveTestcase(ctx, fid, { module: 'M', scenario: 'b' });
    await executeTestcase(ctx, String(b.id), { status: 'Passed', actual_result: '', evidence: '' });
    expect(await bulkTestcaseStatus(ctx, [String(a.id), String(b.id)], 'Passed')).toBe(1);
    expect(await bulkTestcaseDelete(ctx, [String(a.id), String(b.id)])).toBe(2);
    expect((await local.all('SELECT id FROM testcases WHERE deleted_at IS NULL')).length).toBe(0);
  });

  test('a vendor editing a shared file logs activity under its own workspace, and the server accepts it', async () => {
    const f = await createFile(ctx, 'ws-a', 'Shared');
    await setFileShares(ctx, String(f.id), ['ws-v']);
    const tc = await saveTestcase(ctx, String(f.id), { module: 'M', scenario: 's' });
    await sync('alice');
    const vendorLocal = await make();
    const vctx: Ctx = { db: vendorLocal, clock: createClock('v'), email: 'qa@vendor.test', role: 'qa_vendor', memberOf: ['ws-v'] };
    await pullAll(vendorLocal, t('vendor'));
    await saveTestcase(vctx, String(f.id), { module: 'M', scenario: 'edited by vendor' }, String(tc.id));
    const r = await pushOutbox(vendorLocal, t('vendor'));
    expect(r!.rejected).toEqual([]);
    expect((await server.get("SELECT workspace_id FROM activity_log WHERE actor_email = 'qa@vendor.test'")).workspace_id).toBe('ws-v');
  });

  test('a qa_vendor cannot delete a test case: the server parks the rejection', async () => {
    const vendorLocal = await make();
    const vctx: Ctx = { db: vendorLocal, clock: createClock('v'), email: 'qa@vendor.test', role: 'qa_vendor' };
    await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fv', name: 'fv', workspace_id: 'ws-v', hlc: '000000000000001-00000-s' } }]);
    await pullAll(vendorLocal, t('vendor'));
    const r = await saveTestcase(vctx, 'fv', { module: 'M', scenario: 's' });
    await pushOutbox(vendorLocal, t('vendor'));
    await bulkTestcaseDelete(vctx, [String(r.id)]);
    await pushOutbox(vendorLocal, t('vendor'));
    const parked = await vendorLocal.all('SELECT tbl, reason FROM rejected');
    expect(parked).toEqual([{ tbl: 'testcases', reason: 'not allowed: testcase_delete' }]);
  });
});

describe('list model', () => {
  const rows: Row[] = [
    { id: 'a', code: 'LOG-0010', module: 'Login', scenario: 'Reset password', type_test: 'Positive', status: 'Open', steps: '<ol><li>Open the <b>mail</b></li></ol>' },
    { id: 'b', code: 'LOG-0002', module: 'Login', scenario: 'Bad password', type_test: 'Negative', status: 'Failed', steps: '' },
    { id: 'c', code: 'PAY-0001', module: 'Pay', scenario: 'Refund', type_test: 'Positive', status: 'Passed', steps: '' },
    { id: 'd', code: null, module: 'Pay', scenario: 'Unnumbered yet', type_test: 'Positive', status: 'Open', steps: '' },
  ];
  const ui = (p: Partial<ReturnType<typeof defaultTcUi>>) => ({ ...defaultTcUi(), ...p });
  test('search is every-word, case-insensitive, and reaches inside step HTML', () => {
    expect(filterTestcases(rows, ui({ search: 'PASSWORD login' })).map((r) => r.id)).toEqual(['b', 'a']);
    expect(filterTestcases(rows, ui({ search: 'mail' })).map((r) => r.id)).toEqual(['a']);
    expect(filterTestcases(rows, ui({ search: '<b>' })).length).toBe(0); // tags are not searchable text
  });
  test('filters combine', () => {
    expect(filterTestcases(rows, ui({ module: 'Pay', status: 'Open' })).map((r) => r.id)).toEqual(['d']);
    expect(filterTestcases(rows, ui({ typeTest: 'Negative' })).map((r) => r.id)).toEqual(['b']);
  });
  test('the id column sorts by the visible code, naturally; rows without a code fall back to the id and do not throw', () => {
    expect(filterTestcases(rows, ui({})).map((r) => r.id)).toEqual(['d', 'b', 'a', 'c']);
    expect(filterTestcases(rows, ui({ sortDir: 'desc' })).map((r) => r.id)).toEqual(['c', 'a', 'b', 'd']);
    expect(filterTestcases(rows, ui({ sortKey: 'typeTest' })).map((r) => r.type_test)).toEqual(['Negative', 'Positive', 'Positive', 'Positive']);
  });
  test('paging clamps out-of-range pages and always has one page', () => {
    expect(paginate([], 5, 10)).toEqual({ items: [], page: 1, pages: 1 });
    expect(paginate([1, 2, 3, 4, 5], 9, 2)).toEqual({ items: [5], page: 3, pages: 3 });
    expect(paginate([1, 2, 3], 0, 2).page).toBe(1);
  });
  test('helpers', () => {
    expect(uniqueValues(rows, 'module')).toEqual(['Login', 'Pay']);
    expect(sortColumn('testCase')).toBe('test_case');
    expect(sortColumn('module')).toBe('module');
  });
});
