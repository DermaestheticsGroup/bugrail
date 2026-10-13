// Pure Bug Report logic over local rows: the same search, filters, sort and paging as qa-app/js/bugreport.js,
// plus the status master, board grouping, the extra-JSON fields and the test case prefill.
import type { Row } from '../db-types';
import { compareRows } from '../domain/ids';
import { BUG_FORM } from '../domain/forms';
import { DEFAULT_STATUS_MASTER, normPriority, statusTransitionRule, type StatusDef } from '../domain/status';
import { stepsHtmlToText } from '../domain/steps';

const text = (v: unknown) => (typeof v === 'string' ? v : '');
export const bugCodeOf = (r: Row) => text(r.code) || text(r.id);

export const SEVERITIES = ['Critical', 'High', 'Medium', 'Low'];

// Live master rows in sort order, or the defaults when there are none.
export function statusMaster(rows: Row[] | null | undefined): StatusDef[] {
  const live = (rows ?? []).filter((r) => !r.deleted_at && typeof r.id === 'string');
  if (!live.length) return DEFAULT_STATUS_MASTER;
  return live
    .map((r, i) => ({ code: String(r.id), name: text(r.name) || String(r.id), color: text(r.color) || null, order: Number(r.sort_order ?? i + 1) }))
    .sort((a, b) => a.order - b.order);
}
export const statusName = (master: StatusDef[], code: unknown): string => master.find((s) => s.code === code)?.name ?? text(code);

export interface BugUi {
  search: string; module: string; severity: string; priority: string; status: string; tester: string;
  sortKey: string; sortDir: 'asc' | 'desc'; page: number; pageSize: number;
}
export const defaultBugUi = (): BugUi => ({ search: '', module: '', severity: '', priority: '', status: '', tester: '', sortKey: 'reportDate', sortDir: 'desc', page: 1, pageSize: 10 });

// Legacy sort keys are camelCase field names; local rows are snake_case. 'status' sorts by the code column.
const COL: Record<string, string> = { reportDate: 'report_date', testCaseId: 'test_case_id', buildVersion: 'build_version', expectedResult: 'expected_result', actualResult: 'actual_result', status: 'status_code' };
export const bugSortColumn = (key: string) => COL[key] ?? key;

export function filterBugs(rows: Row[], ui: BugUi, tcLabel: (tcId: unknown) => string): Row[] {
  const words = ui.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const hay = (b: Row) => [bugCodeOf(b), b.module, b.title, b.tester, tcLabel(b.test_case_id), b.description, b.steps, b.expected_result, b.actual_result].map(text).join(' ').toLowerCase();
  const out = rows.filter((b) =>
    (!words.length || words.every((w) => hay(b).includes(w)))
    && (!ui.module || b.module === ui.module) && (!ui.severity || b.severity === ui.severity)
    && (!ui.priority || normPriority(text(b.priority)) === ui.priority)
    && (!ui.status || b.status_code === ui.status) && (!ui.tester || b.tester === ui.tester));
  return out.sort((a, b) => compareRows(a, b, bugSortColumn(ui.sortKey), ui.sortDir, bugCodeOf));
}

// Board columns follow the master order; a bug whose status is not in the master still shows, in a column of its own.
export function boardColumns(master: StatusDef[], rows: Row[]): { code: string; name: string; color: string | null; items: Row[] }[] {
  const cols = master.map((s) => ({ ...s, items: rows.filter((b) => b.status_code === s.code) }));
  const known = new Set(master.map((s) => s.code));
  const stray = [...new Set(rows.map((b) => text(b.status_code)).filter((c) => c && !known.has(c)))];
  return [...cols, ...stray.map((code) => ({ code, name: code, color: null, items: rows.filter((b) => b.status_code === code) }))];
}

// Retests and reopens counted from the status events (legacy: activity entries whose `to` is Reopened or Retest).
export const reopenCount = (events: Row[]): number => events.filter((e) => e.kind === 'status' && (e.to_status === 'REOPENED' || e.to_status === 'RETEST')).length;

// A status move needs checking for every bug it would actually change.
export function statusRule(rows: Row[], toCode: string, isQA: boolean): { ok: boolean; needNote: boolean } {
  const rules = rows.filter((b) => b.status_code !== toCode).map((b) => statusTransitionRule(text(b.status_code), toCode, isQA));
  return { ok: rules.every((r) => r.ok), needNote: rules.some((r) => r.needNote) };
}
export const QA_BLOCK_MESSAGE = 'QA hanya bisa memindahkan status dari Retest ke Open, Blocked, Resolved, atau Closed.';

// Fields the bug table has no column for live in `extra`, under the legacy names, exactly as the migration stored them.
export interface BugExtra { os?: string; scenario?: string; preconditions?: string; testData?: string; useTcSteps?: boolean; useTcExpected?: boolean; [k: string]: unknown }
export function readExtra(row: Row | null | undefined): BugExtra {
  try { const v = row?.extra ? JSON.parse(String(row.extra)) : {}; return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}

export interface TcPrefill { module: string; scenario: string; preconditions: string; test_data: string; steps: string; expected_result: string; actual_result: string; attachments: string }
// What a linked test case fills in. Steps arrive as plain text (the form edits text, the save turns it back into the list HTML).
export function tcPrefill(tc: Row): TcPrefill {
  return {
    module: text(tc.module), scenario: text(tc.scenario), preconditions: text(tc.preconditions), test_data: text(tc.test_data),
    steps: stepsHtmlToText(text(tc.steps)), expected_result: text(tc.expected_result), actual_result: text(tc.actual_result),
    // Only URLs carry over from the run's evidence: Attachments rejects non-URL lines.
    attachments: (text(tc.evidence).match(/https?:\/\/[^\s<>"']+/g) ?? []).join('\n'),
  };
}

export function similarBugs(title: string, rows: Row[], excludeId: string | null, closedCodes: string[]): Row[] {
  const asStatus = rows.filter((b) => b.id !== excludeId).map((b) => ({ ...b, title: text(b.title), status: text(b.status_code) }));
  return BUG_FORM.similar(title, asStatus, closedCodes.length ? closedCodes : ['CLOSED']).slice(0, 3);
}

// Bugs saved before Platform existed: infer it from Browser / Device (not written back until saved).
export const inferPlatform = (b: Row): string => text(b.platform) || (b.device && !b.browser ? 'Mobile App' : b.browser ? 'Web' : '');
