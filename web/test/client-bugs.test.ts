import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { createFile, createTestcase, type Ctx } from '../lib/client/repo';
import { BugFormError, addComment, bugTimeline, changeStatus, deleteBugs, emptyBugForm, saveBug, type BugForm } from '../lib/client/bugs';
import { QA_BLOCK_MESSAGE, boardColumns, bugSortColumn, defaultBugUi, filterBugs, inferPlatform, readExtra, reopenCount, similarBugs, statusMaster, statusName, statusRule, tcPrefill } from '../lib/client/bug-model';
import { DEFAULT_STATUS_MASTER } from '../lib/domain/status';
import { pullAll, pushOutbox, type Transport } from '../lib/sync/client';
import { pull, push } from '../lib/sync/server';
import { USERS, seedUsers } from '../lib/sync/users';
import type { Db, Row } from '../lib/db-types';

let server: Db, local: Db, ctx: Ctx, fid: string;
const t = (u: keyof typeof USERS): Transport => ({ push: (r) => push(server, USERS[u], r), pull: (s, a, v) => pull(server, USERS[u], s, a, v) });
const sync = async (u: keyof typeof USERS = 'alice', db = local) => { await pushOutbox(db, t(u)); await pullAll(db, t(u)); };
const make = async () => { const d = (await connect(':memory:')) as unknown as Db; await applyMigrations(d, 'local'); return d; };
const form = (over: Partial<BugForm> = {}): BugForm => ({ ...emptyBugForm('alice@bugrail.test', 'OPEN'), module: 'Login', title: 'Login fails badly', actual_result: 'it shows a 500', steps: '1. open the page\n2. press login', expected_result: 'user is logged in', severity: 'High', ...over });
const create = async (over: Partial<BugForm> = {}) => saveBug(ctx, { fileId: fid, form: form(over), isQA: false, firstStatus: 'OPEN' });
const row = async (id: unknown) => (await local.get('SELECT * FROM bugs WHERE id = ?', id)) as Row;

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(server, 'server');
  await seedUsers(server);
  local = await make();
  ctx = { db: local, clock: createClock('d1'), email: 'alice@bugrail.test', role: 'qa_internal', memberOf: ['ws-a'] };
  fid = String((await createFile(ctx, 'ws-a', 'F')).id);
});

describe('saveBug', () => {
  test('create validates with the legacy rules and reports every error', async () => {
    const err = await create({ title: 'bad', actual_result: '', module: '', steps: 'x', expected_result: '', severity: '' }).catch((e) => e);
    expect(err).toBeInstanceOf(BugFormError);
    expect(Object.keys(err.errors).sort()).toEqual(['actualResult', 'expectedResult', 'module', 'severity', 'steps', 'title']);
    expect((await create({ attachments: 'not a url' }).catch((e) => e)).errors.attachments).toMatch(/URL/);
  });
  test('create stores columns, steps as list HTML, extras in extra, starts at the first status and gets a server code', async () => {
    const b = await create({ os: 'Android 14', scenario: 'sc', preconditions: 'pre', test_data: 'td', platform: 'Web', browser: 'Chrome', device: 'Pixel' });
    expect(b.status_code).toBe('OPEN');
    expect(String(b.steps)).toContain('<li>');
    expect(readExtra(b)).toMatchObject({ os: 'Android 14', scenario: 'sc', preconditions: 'pre', testData: 'td' });
    expect([b.browser, b.device]).toEqual(['Chrome', '']); // a new bug keeps only what its platform uses
    await sync();
    expect((await row(b.id)).code).toBe('BUG-0001');
  });
  test('an assignee on create writes an assignment event; editing it again writes another only when it changed', async () => {
    const b = await create({ assignee: 'bob@bugrail.test' });
    const edit = (over: Partial<BugForm>) => saveBug(ctx, { fileId: fid, bugId: String(b.id), form: { ...form({ assignee: 'bob@bugrail.test', ...over }) }, isQA: false, firstStatus: 'OPEN' });
    await edit({ title: 'Login fails differently' });
    await edit({ assignee: 'BOB@bugrail.test' }); // same person, different case: no new event
    await edit({ assignee: 'alice@bugrail.test' });
    const ev = (await bugTimeline(ctx, String(b.id))).filter((e) => e.kind === 'assignment');
    expect(ev.map((e) => e.assignee)).toEqual(['bob@bugrail.test', 'alice@bugrail.test']);
  });
  test('editing keeps the old minimum: a legacy bug without module or steps can still be saved', async () => {
    const b = await create();
    const out = await saveBug(ctx, { fileId: fid, bugId: String(b.id), form: form({ module: '', steps: '', expected_result: '', title: 'Still fine title' }), isQA: false, firstStatus: 'OPEN' });
    expect(out.title).toBe('Still fine title');
  });
  test('a status move through the form needs the rule, a note when it needs one, and writes a status event', async () => {
    const b = await create();
    const go = (to: string, change?: { note: string; attachment: string }, isQA = false) => saveBug(ctx, { fileId: fid, bugId: String(b.id), form: form({ status_code: to }), isQA, change, firstStatus: 'OPEN' });
    await go('IN_PROGRESS'); // dev flow: no note
    await expect(go('CLOSED')).rejects.toThrow('A note is required');
    await go('CLOSED', { note: 'verified', attachment: '' });
    const ev = (await bugTimeline(ctx, String(b.id))).filter((e) => e.kind === 'status');
    expect(ev.map((e) => [e.from_status, e.to_status, e.note])).toEqual([['OPEN', 'IN_PROGRESS', ''], ['IN_PROGRESS', 'CLOSED', 'verified']]);
    await expect(go('OPEN', { note: 'n', attachment: '' }, true)).rejects.toThrow(QA_BLOCK_MESSAGE); // QA may only leave RETEST
  });
  test('limited edit changes only status and priority', async () => {
    const b = await create({ priority: 'Low' });
    const out = await saveBug(ctx, { fileId: fid, bugId: String(b.id), form: form({ title: 'HACKED TITLE HERE', priority: 'Urgent', status_code: 'IN_PROGRESS' }), limited: true, isQA: false, firstStatus: 'OPEN' });
    expect([out.title, out.priority, out.status_code]).toEqual(['Login fails badly', 'Urgent', 'IN_PROGRESS']);
  });
  test('editing a deleted bug is refused', async () => {
    const b = await create();
    await deleteBugs(ctx, [String(b.id)]);
    await expect(saveBug(ctx, { fileId: fid, bugId: String(b.id), form: form(), isQA: false, firstStatus: 'OPEN' })).rejects.toThrow('no longer exists');
  });
});

describe('events', () => {
  test('events written in the same millisecond keep their write order', async () => {
    const b = await create();
    const id = String(b.id);
    for (let i = 0; i < 25; i++) await addComment(ctx, id, `c${i}`);
    const texts = (await bugTimeline(ctx, id)).filter((e) => e.kind === 'comment').map((e) => e.text);
    expect(texts).toEqual(Array.from({ length: 25 }, (_, i) => `c${i}`));
  });
});

describe('changeStatus, comments, delete', () => {
  test('bulk move writes one event per moved bug, skips ones already there, and checks the rule for all first', async () => {
    const a = await create({ title: 'First bug here' }), b = await create({ title: 'Second bug here' });
    await changeStatus(ctx, [String(b.id)], 'IN_PROGRESS', null, false);
    expect(await changeStatus(ctx, [String(a.id), String(b.id)], 'IN_PROGRESS', null, false)).toBe(1);
    await expect(changeStatus(ctx, [String(a.id), String(b.id)], 'CLOSED', null, false)).rejects.toThrow('A note is required');
    expect(await changeStatus(ctx, [String(a.id), 'ghost'], 'CLOSED', { note: 'ok', attachment: '' }, false)).toBe(1);
    expect(await local.get("SELECT 1 AS x FROM bugs WHERE id = 'ghost'")).toBeUndefined();
    // a QA-only user: the rule blocks the whole batch before anything is written
    const before = Number((await local.get('SELECT count(*) AS n FROM bug_events')).n);
    await expect(changeStatus(ctx, [String(b.id)], 'RESOLVED', { note: 'n', attachment: '' }, true)).rejects.toThrow(QA_BLOCK_MESSAGE);
    expect(Number((await local.get('SELECT count(*) AS n FROM bug_events')).n)).toBe(before);
  });
  test('the status clock moves only with a status change', async () => {
    const b = await create();
    const h0 = String((await row(b.id)).status_hlc);
    await saveBug(ctx, { fileId: fid, bugId: String(b.id), form: form({ title: 'Renamed but not moved' }), isQA: false, firstStatus: 'OPEN' });
    expect(String((await row(b.id)).status_hlc)).toBe(h0);
    await changeStatus(ctx, [String(b.id)], 'IN_PROGRESS', null, false);
    expect(String((await row(b.id)).status_hlc) > h0).toBe(true);
  });
  test('comments: trimmed, empty ignored, refused on a missing bug', async () => {
    const b = await create();
    expect(await addComment(ctx, String(b.id), '   ')).toBe(false);
    expect(await addComment(ctx, String(b.id), '  hello  ')).toBe(true);
    expect((await bugTimeline(ctx, String(b.id))).filter((e) => e.kind === 'comment').map((e) => e.text)).toEqual(['hello']);
    await expect(addComment(ctx, 'ghost', 'x')).rejects.toThrow('no longer exists');
  });
  test('delete skips missing and already-deleted bugs and reports the real count', async () => {
    const a = await create({ title: 'To be deleted one' });
    expect(await deleteBugs(ctx, [String(a.id), 'ghost'])).toBe(1);
    expect(await deleteBugs(ctx, [String(a.id)])).toBe(0);
    expect(await local.get("SELECT 1 AS x FROM bugs WHERE id = 'ghost'")).toBeUndefined();
  });
});

describe('server agreement', () => {
  test('a pm_ba status move is accepted; a QA-role move out of OPEN is refused by the server and parked', async () => {
    const b = await create();
    await sync('alice');
    const pm = await make();
    await pullAll(pm, t('pm'));
    const pctx: Ctx = { db: pm, clock: createClock('pm'), email: 'pm@bugrail.test', role: 'pm_ba', memberOf: ['ws-a'] };
    await changeStatus(pctx, [String(b.id)], 'IN_PROGRESS', null, false);
    const r = await pushOutbox(pm, t('pm'));
    expect(r!.rejected).toEqual([]);
    expect(String((await server.get('SELECT status_code FROM bugs WHERE id = ?', b.id)).status_code)).toBe('IN_PROGRESS');
    // alice (qa_internal has bugreport_statusQA): the client rule would block her too, so bypass it to prove the server agrees
    await upsertDirect(local, String(b.id), 'CLOSED');
    const r2 = await pushOutbox(local, t('alice'));
    expect(r2!.rejected.map((x) => x.reason)).toContain('status transition not allowed');
  });
});
async function upsertDirect(db: Db, id: string, code: string) {
  const { localWrite } = await import('../lib/sync/client');
  const cur = (await db.get('SELECT * FROM bugs WHERE id = ?', id)) as Row;
  const clock = createClock('z');
  await localWrite(db, 'bugs', { ...cur, status_code: code, status_hlc: clock.now(), hlc: clock.now() });
}

describe('model', () => {
  const rows: Row[] = [
    { id: 'a', code: 'BUG-0010', title: 'Login crash', module: 'Login', severity: 'High', priority: 'Highest', status_code: 'OPEN', tester: 'ann', report_date: '2026-01-02', test_case_id: 'tc1', steps: '<ol><li>go</li></ol>' },
    { id: 'b', code: 'BUG-0002', title: 'Pay fails', module: 'Pay', severity: 'Low', priority: 'Low', status_code: 'CLOSED', tester: 'bob', report_date: '2026-01-03', test_case_id: null, steps: '' },
    { id: 'c', code: null, title: 'Unnumbered', module: 'Pay', severity: 'High', priority: 'Urgent', status_code: 'WEIRD', tester: 'ann', report_date: '2026-01-01', test_case_id: null, steps: '' },
  ];
  const ui = (p: Partial<ReturnType<typeof defaultBugUi>>) => ({ ...defaultBugUi(), ...p });
  const label = (id: unknown) => (id === 'tc1' ? 'LOG-0001' : '');
  test('default sort is newest report date first; search reaches the test case code; Highest filters as Urgent', () => {
    expect(filterBugs(rows, ui({}), label).map((r) => r.id)).toEqual(['b', 'a', 'c']);
    expect(filterBugs(rows, ui({ search: 'log-0001' }), label).map((r) => r.id)).toEqual(['a']);
    expect(filterBugs(rows, ui({ priority: 'Urgent' }), label).map((r) => r.id).sort()).toEqual(['a', 'c']);
  });
  test('filters combine; the id column sorts by visible code, rows without one do not throw', () => {
    expect(filterBugs(rows, ui({ module: 'Pay', tester: 'ann' }), label).map((r) => r.id)).toEqual(['c']);
    expect(filterBugs(rows, ui({ sortKey: 'id', sortDir: 'asc' }), label).map((r) => r.id)).toEqual(['b', 'a', 'c']); // BUG-0002 < BUG-0010 naturally; no code falls back to the id
    expect(bugSortColumn('status')).toBe('status_code');
  });
  test('board follows the master order and gives an unknown status a column instead of dropping the bug', () => {
    const cols = boardColumns(DEFAULT_STATUS_MASTER, rows);
    expect(cols.map((c) => c.code)).toEqual(['OPEN', 'IN_PROGRESS', 'RETEST', 'RESOLVED', 'CLOSED', 'REJECTED', 'WEIRD']);
    expect(cols.find((c) => c.code === 'WEIRD')!.items.map((r) => r.id)).toEqual(['c']);
  });
  test('status master: live rows in order, defaults when empty, names by code', () => {
    expect(statusMaster([])).toBe(DEFAULT_STATUS_MASTER);
    const m = statusMaster([{ id: 'B', name: 'Beta', sort_order: 2 }, { id: 'A', name: 'Alpha', sort_order: 1 }, { id: 'X', name: 'Gone', sort_order: 0, deleted_at: 'x' }]);
    expect(m.map((s) => s.code)).toEqual(['A', 'B']);
    expect(statusName(m, 'B')).toBe('Beta');
    expect(statusName(m, 'ZZ')).toBe('ZZ');
  });
  test('reopen count counts REOPENED and RETEST status events only', () => {
    expect(reopenCount([{ kind: 'status', to_status: 'REOPENED' }, { kind: 'status', to_status: 'RETEST' }, { kind: 'status', to_status: 'CLOSED' }, { kind: 'comment', to_status: 'RETEST' }])).toBe(2);
  });
  test('rule: only moving bugs count, note needed outside the dev flow', () => {
    expect(statusRule([{ status_code: 'OPEN' }], 'OPEN', true)).toEqual({ ok: true, needNote: false });
    expect(statusRule([{ status_code: 'OPEN' }], 'IN_PROGRESS', false)).toEqual({ ok: true, needNote: false });
    expect(statusRule([{ status_code: 'OPEN' }, { status_code: 'RETEST' }], 'CLOSED', false)).toEqual({ ok: true, needNote: true });
    expect(statusRule([{ status_code: 'OPEN' }], 'CLOSED', true).ok).toBe(false);
  });
  test('tcPrefill turns steps into text and keeps only URLs from the evidence', () => {
    const p = tcPrefill({ module: 'M', scenario: 'S', steps: '<ol><li>one</li><li>two</li></ol>', evidence: 'see http://a/x.png and notes https://b/y', actual_result: 'boom' });
    expect(p.steps).toBe('1. one\n2. two');
    expect(p.attachments).toBe('http://a/x.png\nhttps://b/y');
    expect(p.actual_result).toBe('boom');
  });
  test('similar bugs: open ones with a close title, never the bug itself, at most 3', () => {
    const pool: Row[] = [1, 2, 3, 4].map((i) => ({ id: `s${i}`, title: 'Login page crashes on submit', status_code: 'OPEN' })).concat([{ id: 'closed', title: 'Login page crashes on submit', status_code: 'CLOSED' }]);
    expect(similarBugs('login page crashes on submit', pool, 's1', ['CLOSED']).length).toBe(3);
    expect(similarBugs('login page crashes on submit', pool, null, ['CLOSED']).every((b) => b.id !== 'closed')).toBe(true);
    expect(similarBugs('abc', pool, null, [])).toEqual([]);
  });
  test('platform is inferred for bugs saved before it existed; extra tolerates garbage', () => {
    expect(inferPlatform({ browser: 'Chrome' })).toBe('Web');
    expect(inferPlatform({ device: 'Pixel' })).toBe('Mobile App');
    expect(inferPlatform({ platform: 'API', browser: 'x' })).toBe('API');
    expect(readExtra({ extra: '{oops' })).toEqual({});
    expect(readExtra({ extra: '[1]' })).toEqual({});
  });
});

describe('create bug from a test case', () => {
  test('a bug links to its test case and carries the prefill', async () => {
    const tc = await createTestcase(ctx, fid, { module: 'Login', scenario: 'Happy', steps: '<ol><li>open the login page</li><li>press the button</li></ol>', expected_result: 'works fine', actual_result: 'it exploded', status: 'Failed' });
    const p = tcPrefill(tc);
    const b = await create({ test_case_id: String(tc.id), ...p, title: 'Login breaks on happy path', useTcSteps: true, useTcExpected: true });
    expect(b.test_case_id).toBe(tc.id);
    expect(readExtra(b)).toMatchObject({ scenario: 'Happy', useTcSteps: true, useTcExpected: true });
  });
});
