import { describe, expect, test } from 'bun:test';
import {
  actionGroupOf, bugCountsByFile, buildAnalysis, dashStats, defaultActivityUi, emptyRange, filterActivity, filterBugRange, filterTcs, formatDuration, moduleBars, toDomain, unreadCount,
} from '../lib/client/analytics';
import { NotifCalc } from '../lib/domain/notifications';
import { ReportCalc } from '../lib/domain/report';
import { computeBugResolutionStats } from '../lib/domain/status';

const files = [{ id: 'f1', name: 'Round 1', created_at: '2026-01-01' }, { id: 'f2', name: 'Round 2', created_at: '2026-02-01' }];
const tc = (id: string, module: string, status: string, extra: Record<string, unknown> = {}) => ({ id, code: id, file_id: 'f1', module, status, created_by: 'qa@x.test', execution_date: '2026-03-10', ...extra });
const bug = (id: string, o: Record<string, unknown> = {}) => ({ id, code: id, file_id: 'f1', title: `t-${id}`, module: 'Login', severity: 'Low', priority: 'Low', status_code: 'OPEN', tester: 'qa@x.test', assignee: '', report_date: '2026-03-01T00:00:00.000Z', ...o });
const ev = (id: string, bug_id: string, kind: string, o: Record<string, unknown>) => ({ id, bug_id, kind, at: '2026-03-02T00:00:00.000Z', email: 'dev@x.test', ...o });

describe('toDomain', () => {
  test('maps snake_case rows and groups status and assignment events per bug in time order', () => {
    const d = toDomain(files, [tc('t1', 'Login', 'Passed')], [bug('b1')], [
      ev('e2', 'b1', 'status', { at: '2026-03-04T00:00:00.000Z', from_status: 'RESOLVED', to_status: 'CLOSED', note: 'ok' }),
      ev('e1', 'b1', 'status', { at: '2026-03-03T00:00:00.000Z', from_status: 'OPEN', to_status: 'RESOLVED' }),
      ev('e3', 'b1', 'assignment', { assignee: 'dev@x.test', email: 'qa@x.test' }),
      ev('e4', 'b1', 'comment', {}),
    ]);
    expect(d.tcs[0]).toMatchObject({ fileId: 'f1', status: 'Passed', createdBy: 'qa@x.test', executionDate: '2026-03-10' });
    expect(d.bugs[0].status).toBe('OPEN');
    expect(d.bugs[0].activity.map((a: { to: string }) => a.to)).toEqual(['RESOLVED', 'CLOSED']);
    expect(d.bugs[0].assignments).toEqual([{ at: '2026-03-02T00:00:00.000Z', by: 'qa@x.test', to: 'dev@x.test' }]);
  });
});

describe('dashboard numbers', () => {
  const d = toDomain(files, [tc('t1', 'Login', 'Passed'), tc('t2', 'Login', 'Failed'), tc('t3', 'Cart', 'Open'), tc('t4', 'Cart', 'Blocked'), tc('t5', 'Cart', 'Retest')],
    [bug('b1', { severity: 'Critical', priority: 'Highest' }), bug('b2', { severity: 'High', priority: 'High' }), bug('b3', { priority: 'Critical' })], []);
  test('counts statuses, severities, and folds Highest and Critical priority into Urgent', () => {
    const s = dashStats(d.tcs, d.bugs);
    expect(s).toMatchObject({ totalModule: 2, totalTC: 5, passed: 1, failed: 1, notrun: 1, blocked: 1, retest: 1, totalBug: 3, critical: 1, high: 1, low: 1, urgent: 2, prioHigh: 1 });
  });
  test('the empty case is all zeros, not NaN', () => {
    expect(dashStats([], [])).toMatchObject({ totalTC: 0, totalBug: 0, totalModule: 0 });
  });
  test('module bars group Passed, Failed and everything else', () => {
    expect(moduleBars(d.tcs)).toEqual([{ module: 'Login', passed: 1, failed: 1, other: 0 }, { module: 'Cart', passed: 0, failed: 0, other: 3 }]);
  });
  test('module bars stop at 8 modules', () => {
    const many = Array.from({ length: 12 }, (_, i) => ({ module: `m${i}`, status: 'Passed' }));
    expect(moduleBars(many)).toHaveLength(8);
  });
});

describe('summary filters', () => {
  const d = toDomain(files, [tc('t1', 'Login', 'Passed'), tc('t2', 'Cart', 'Passed', { execution_date: '2026-04-01' }), tc('t3', 'Cart', 'Open', { execution_date: '' }), tc('t4', 'X', 'Open', { file_id: 'f2' })],
    [bug('b1'), bug('b2', { module: 'Cart', tester: 'o@x.test', report_date: '2026-04-05T00:00:00.000Z' }), bug('b3', { file_id: 'f2' })], []);
  test('module, file and date range narrow test cases; an undated row is never excluded by the range', () => {
    expect(filterTcs(d.tcs, { ...emptyRange(), module: 'Cart' }).map((t) => t.id)).toEqual(['t2', 't3']);
    expect(filterTcs(d.tcs, { ...emptyRange(), dateFrom: '2026-03-20' }).map((t) => t.id)).toEqual(['t2', 't3']);
    expect(filterTcs(d.tcs, { ...emptyRange(), fileId: 'f2' }).map((t) => t.id)).toEqual(['t4']);
  });
  test('bugs filter by tester and report day', () => {
    expect(filterBugRange(d.bugs, { ...emptyRange(), tester: 'o@x.test' }).map((b) => b.id)).toEqual(['b2']);
    expect(filterBugRange(d.bugs, { ...emptyRange(), dateTo: '2026-03-31' }).map((b) => b.id)).toEqual(['b1', 'b3']);
  });
  test('bug per file ignores the file filter itself and names unknown files', () => {
    const rows = bugCountsByFile([...d.bugs, { id: 'x', fileId: '' }], d.files, { ...emptyRange(), fileId: 'f2' });
    expect(rows).toEqual([{ name: 'Round 1', count: 2 }, { name: 'Round 2', count: 1 }, { name: 'Tanpa File', count: 1 }]);
  });
});

describe('analysis text', () => {
  test('an empty range says so and still recommends something', () => {
    const a = buildAnalysis([], [], { resolvedCount: 0, avgHours: 0 });
    expect(a.findings).toContain('Belum ada test case pada rentang filter ini.');
    expect(a.recommendations).toHaveLength(1);
  });
  test('low pass rate, blocked cases, critical bugs and chronic retests each produce their line', () => {
    const d = toDomain(files, [tc('t1', 'Login', 'Failed'), tc('t2', 'Login', 'Blocked'), tc('t3', 'Login', 'Passed')],
      [bug('b1', { severity: 'Critical', status_code: 'REOPENED' })], [1, 2, 3].map((i) => ev(`e${i}`, 'b1', 'status', { at: `2026-03-0${i}T00:00:00.000Z`, from_status: 'RESOLVED', to_status: 'RETEST' })));
    const a = buildAnalysis(d.tcs, d.bugs, computeBugResolutionStats(d.bugs));
    expect(a.passRate).toBe(33);
    expect(a.findings.join('\n')).toContain('Pass rate rendah');
    expect(a.findings.join('\n')).toContain('Bug retest kronis');
    expect(a.recommendations.join('\n')).toContain('Prioritaskan 1 bug Critical');
    expect(a.recommendations.join('\n')).toContain('Blocked');
  });
  test('resolution time over 3 days adds the capacity recommendation', () => {
    const b = toDomain(files, [], [bug('b1', { status_code: 'CLOSED' })], [ev('e1', 'b1', 'status', { at: '2026-03-10T00:00:00.000Z', from_status: 'RESOLVED', to_status: 'CLOSED' })]).bugs;
    const a = buildAnalysis([], b, computeBugResolutionStats(b));
    expect(a.recommendations.join('\n')).toContain('lebih dari 3 hari');
  });
  test('formatDuration', () => {
    expect([formatDuration(0), formatDuration(0.5), formatDuration(5), formatDuration(72)]).toEqual(['—', '30 menit', '5 jam', '3 hari']);
  });
});

describe('report over local rows', () => {
  test('GO needs every test run and passed with no open Critical or High; one open Critical makes it NO_GO', () => {
    const tcs = [tc('t1', 'Login', 'Passed'), tc('t2', 'Login', 'Passed')];
    const clean = toDomain(files, tcs, [bug('b1', { status_code: 'CLOSED', severity: 'Critical' })], []);
    expect(ReportCalc.goLive(clean.tcs, clean.bugs).verdict).toBe('GO');
    const dirty = toDomain(files, tcs, [bug('b1', { severity: 'Critical' })], []);
    const g = ReportCalc.goLive(dirty.tcs, dirty.bugs);
    expect(g.verdict).toBe('NO_GO');
    expect(g.reason).toContain('1 bug Critical terbuka');
  });
  test('REJECTED counts as done, RESOLVED does not (QA has not verified it)', () => {
    const d = toDomain(files, [tc('t1', 'Login', 'Passed')], [bug('b1', { status_code: 'REJECTED', severity: 'High' }), bug('b2', { status_code: 'RESOLVED', severity: 'High' })], []);
    expect(ReportCalc.evaluate(d.tcs, d.bugs).openHigh.map((b) => b.id)).toEqual(['b2']);
  });
});

describe('notifications over local rows', () => {
  const d = toDomain(files, [tc('t1', 'Login', 'Open'), tc('t2', 'Login', 'Open', { file_id: 'f2' }), tc('t3', 'Login', 'Open', { created_by: 'other@x.test' })],
    [bug('b1', { tester: 'qa@x.test', assignee: 'dev@x.test' })],
    [ev('a1', 'b1', 'assignment', { at: '2026-03-01T00:00:10.000Z', assignee: 'dev@x.test', email: 'qa@x.test' }),
      ev('s1', 'b1', 'status', { at: '2026-03-05T00:00:00.000Z', from_status: 'OPEN', to_status: 'RESOLVED', email: 'dev@x.test' }),
      ev('s2', 'b1', 'status', { at: '2026-03-06T00:00:00.000Z', from_status: 'RESOLVED', to_status: 'CLOSED', email: 'qa@x.test' })]);
  test('the tester hears about the developer fix but not about their own close', () => {
    const n = NotifCalc.build({ bugs: d.bugs, testcases: d.tcs, me: 'qa@x.test' });
    expect(n.events).toHaveLength(1);
    expect(n.events[0].text).toContain('OPEN → RESOLVED (diperbaiki) oleh dev@x.test');
  });
  test('the assignee is told of a new assignment, a new bug within a minute of its report date reads as new', () => {
    const n = NotifCalc.build({ bugs: d.bugs, testcases: [], me: 'dev@x.test' });
    expect(n.events.find((e) => e.text.includes('Bug baru'))).toBeDefined();
  });
  test('reminders are one line per file the user created with Open cases', () => {
    const n = NotifCalc.build({ bugs: [], testcases: d.tcs, me: 'qa@x.test' });
    expect(n.reminders).toEqual([{ fileId: 'f1', count: 1 }, { fileId: 'f2', count: 1 }]);
    expect(NotifCalc.build({ bugs: d.bugs, testcases: d.tcs, me: 'qa@x.test', canBug: false, canTc: false })).toEqual({ events: [], reminders: [] });
  });
  test('unread counts events newer than the last time the panel was opened; never opened means all unread', () => {
    const ev3 = [{ at: '2026-03-01' }, { at: '2026-03-05' }, { at: '2026-03-09' }];
    expect(unreadCount(ev3, '2026-03-05')).toBe(1);
    expect(unreadCount(ev3, '')).toBe(3);
    // same instant in different notations is not unread
    expect(unreadCount([{ at: '2026-03-05T00:00:00.000Z' }], '2026-03-05T07:00:00+07:00')).toBe(0);
    expect(unreadCount([{ at: 'garbage' }], '2026-03-05')).toBe(1);
  });
});

describe('activity log', () => {
  const rows = [
    { id: 'l1', ts: '2026-03-01T10:00:00Z', actor_email: 'a@x.test', actor_role: 'admin', workspace_id: 'w1', action: 'login', label: 'Login' },
    { id: 'l2', ts: '2026-03-02T10:00:00Z', actor_email: 'b@x.test', actor_role: 'qa_internal', workspace_id: '', action: 'bugreport_create', label: 'Bug BUG-0001 dibuat' },
    { id: 'l3', ts: '2026-03-03T10:00:00Z', actor_email: 'b@x.test', actor_role: 'qa_internal', workspace_id: 'w1', action: 'tc_file_create', label: 'File Round 1' },
  ];
  const wsName = (id: unknown) => (id === 'w1' ? 'Alpha' : '(Semua / Shared)');
  test('groups actions like the legacy dropdown', () => {
    expect(['login', 'testcase_update', 'bugreport_x', 'tc_file_create', 'bug_file_delete', 'role_update', 'zzz'].map(actionGroupOf)).toEqual(['auth', 'testcase', 'bugreport', 'file', 'file', 'usermanagement', 'other']);
  });
  test('newest first; user, group and every search word (including the workspace name) must match', () => {
    const ui = defaultActivityUi();
    expect(filterActivity(rows, ui, wsName).map((r) => r.id)).toEqual(['l3', 'l2', 'l1']);
    expect(filterActivity(rows, { ...ui, user: 'b@x.test' }, wsName).map((r) => r.id)).toEqual(['l3', 'l2']);
    expect(filterActivity(rows, { ...ui, group: 'file' }, wsName).map((r) => r.id)).toEqual(['l3']);
    expect(filterActivity(rows, { ...ui, search: 'alpha round' }, wsName).map((r) => r.id)).toEqual(['l3']);
    expect(filterActivity(rows, { ...ui, search: 'alpha nope' }, wsName)).toEqual([]);
  });
});
