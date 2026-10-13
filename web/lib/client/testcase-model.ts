// Pure list logic for the Test Case screen: the same search, filters, sort and paging as qa-app/js/testcase.js, over local rows.
import type { Row } from '../db-types';
import { compareRows } from '../domain/ids';
import { stepsHtmlToText } from '../domain/steps';

export interface TcUi {
  search: string; module: string; typeTest: string; status: string;
  sortKey: string; sortDir: 'asc' | 'desc'; page: number; pageSize: number;
}
export const defaultTcUi = (): TcUi => ({ search: '', module: '', typeTest: '', status: '', sortKey: 'id', sortDir: 'asc', page: 1, pageSize: 10 });

// Legacy sort keys are camelCase field names; local rows are snake_case columns. 'id' sorts by the visible code.
const COL: Record<string, string> = { testCase: 'test_case', typeTest: 'type_test', roleUser: 'role_user', expectedResult: 'expected_result', actualResult: 'actual_result', executionDate: 'execution_date' };
export const sortColumn = (key: string) => COL[key] ?? key;

const text = (v: unknown) => (typeof v === 'string' ? v : '');
export const tcCodeOf = (r: Row) => text(r.code) || text(r.id);

function haystack(r: Row): string {
  return [tcCodeOf(r), r.module, r.role_user, r.scenario, r.test_case, r.preconditions, stepsHtmlToText(text(r.steps)), r.test_data, r.expected_result, r.type_test, r.status].map(text).join(' ').toLowerCase();
}

export function filterTestcases(rows: Row[], ui: TcUi): Row[] {
  const words = ui.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  const out = rows.filter((r) =>
    (!words.length || words.every((w) => haystack(r).includes(w)))
    && (!ui.module || r.module === ui.module) && (!ui.typeTest || r.type_test === ui.typeTest) && (!ui.status || r.status === ui.status));
  if (ui.sortKey) out.sort((a, b) => compareRows(a, b, sortColumn(ui.sortKey), ui.sortDir, tcCodeOf));
  return out;
}

export function paginate<T>(rows: T[], page: number, size: number): { items: T[]; page: number; pages: number } {
  const pages = Math.max(1, Math.ceil(rows.length / size));
  const p = Math.min(Math.max(1, page), pages);
  return { items: rows.slice((p - 1) * size, p * size), page: p, pages };
}

export const uniqueValues = (rows: Row[], col: string): string[] => [...new Set(rows.map((r) => text(r[col])).filter(Boolean))].sort();

export const TC_STATUSES = ['Open', 'Passed', 'Failed', 'Blocked', 'Retest'];
export const TC_TYPES = ['Positive', 'Negative'];
