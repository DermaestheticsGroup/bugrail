// Import and export of test cases and bugs (Excel/CSV through SheetJS), plus the JSON backup of the local database.
// Columns, headers and the import rules follow qa-app/js/{testcase,bugreport,import,export}.js; row mapping is pure so it is unit tested.
import * as XLSX from 'xlsx';
import type { Db, Row } from '../db-types';
import { TC_IMPORT } from '../domain/forms';
import { stepsHtmlToText, textToStepsHtml } from '../domain/steps';
import { TABLES, type SyncedTable } from '../../db/tables';
import { createTestcase, logActivity, upsertRow, type Ctx } from './repo';
import { TC_STATUSES, TC_TYPES } from './testcase-model';
import { bugCodeOf } from './bug-model';

const text = (v: unknown) => (v === null || v === undefined ? '' : String(v));

export interface Col { key: string; label: string; width?: number; list?: string[] }

export const TC_COLUMNS: Col[] = [
  { key: 'code', label: 'Test Case ID', width: 14 }, { key: 'module', label: 'Module', width: 16 }, { key: 'role_user', label: 'Role User', width: 14 },
  { key: 'scenario', label: 'Scenario', width: 30 }, { key: 'test_case', label: 'Test Case', width: 30 }, { key: 'preconditions', label: 'Pre Kondisi', width: 24 },
  { key: 'steps', label: 'Test Step', width: 30 }, { key: 'test_data', label: 'Test Data', width: 24 }, { key: 'type_test', label: 'Type Test', width: 12, list: TC_TYPES },
  { key: 'expected_result', label: 'Expected Result', width: 26 }, { key: 'actual_result', label: 'Actual Result', width: 26 }, { key: 'status', label: 'Status', width: 12, list: TC_STATUSES },
  { key: 'evidence', label: 'Evidence', width: 26 }, { key: 'execution_date', label: 'Execution Date', width: 14 },
];

export const BUG_COLUMNS: Col[] = [
  { key: 'code', label: 'Bug ID' }, { key: 'test_case', label: 'Test Case ID' }, { key: 'module', label: 'Module' }, { key: 'scenario', label: 'Scenario' },
  { key: 'title', label: 'Bug Title' }, { key: 'preconditions', label: 'Pre-condition' }, { key: 'test_data', label: 'Test Data' },
  { key: 'description', label: 'Impact / Catatan Tambahan' }, { key: 'expected_result', label: 'Expected Result' }, { key: 'actual_result', label: 'Actual Result' },
  { key: 'severity', label: 'Severity' }, { key: 'priority', label: 'Priority' }, { key: 'status', label: 'Status' }, { key: 'tester', label: 'Tester' },
  { key: 'date', label: 'Date' }, { key: 'environment', label: 'Environment' }, { key: 'platform', label: 'Platform' }, { key: 'browser', label: 'Browser' },
  { key: 'os', label: 'OS' }, { key: 'device', label: 'Device' }, { key: 'attachments', label: 'Attachment' }, { key: 'build_version', label: 'Build Version' },
];

// Legacy arrayToCSV: every cell quoted, quotes doubled, CRLF between lines.
export function arrayToCSV(rows: Record<string, unknown>[], cols: Col[]): string {
  const line = (cells: string[]) => cells.map((v) => `"${v.replace(/"/g, '""')}"`).join(',');
  return [cols.map((c) => c.label).join(','), ...rows.map((r) => line(cols.map((c) => text(r[c.key]))))].join('\r\n');
}

const extra = (r: Row): Record<string, unknown> => { try { return r.extra ? JSON.parse(String(r.extra)) : {}; } catch { return {}; } };

// Rows ready for a sheet: steps as plain text, custom fields as extra columns, numbering restarting per call.
export function tcExportRows(tcs: Row[], fieldLabels: string[]): Record<string, unknown>[] {
  return tcs.map((t, i) => {
    let custom: Record<string, unknown> = {};
    try { custom = t.custom_fields ? JSON.parse(String(t.custom_fields)) : {}; } catch { /* a bad blob exports as empty */ }
    return { no: i + 1, ...t, ...Object.fromEntries(fieldLabels.map((l) => [l, custom[l] ?? ''])), steps: stepsHtmlToText(text(t.steps)) };
  });
}
export const tcExportColumns = (fieldLabels: string[]): Col[] => [{ key: 'no', label: 'No' }, ...TC_COLUMNS, ...fieldLabels.map((l) => ({ key: l, label: l }))];

export function bugExportRows(bugs: Row[], tcLabel: (id: unknown) => string, statusLabel: (code: unknown) => string): Record<string, unknown>[] {
  return bugs.map((b) => {
    const x = extra(b);
    return { ...b, ...x, code: bugCodeOf(b), test_case: tcLabel(b.test_case_id), status: statusLabel(b.status_code), date: text(b.report_date).slice(0, 10) };
  });
}

const safeSheetName = (name: string, used: Set<string>): string => {
  let base = (name.replace(/[\\/?*[\]:]/g, ' ').trim() || 'Sheet').slice(0, 31), n = 2, out = base;
  while (used.has(out.toLowerCase())) { const suffix = `_${n++}`; out = base.slice(0, 31 - suffix.length) + suffix; }
  used.add(out.toLowerCase());
  return out;
};

// One sheet per module, as the legacy export did.
export function tcWorkbook(rows: Record<string, unknown>[], cols: Col[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const byModule = new Map<string, Record<string, unknown>[]>();
  rows.forEach((r) => { const k = text(r.module) || 'Tanpa Module'; byModule.set(k, [...(byModule.get(k) ?? []), r]); });
  byModule.forEach((list, name) => {
    const aoa = [cols.map((c) => c.label), ...list.map((r, i) => cols.map((c) => (c.key === 'no' ? i + 1 : text(r[c.key]))))];
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = cols.map((c) => ({ wch: c.width ?? 12 }));
    XLSX.utils.book_append_sheet(wb, ws, safeSheetName(name, used));
  });
  if (!byModule.size) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([cols.map((c) => c.label)]), 'Test Cases');
  return wb;
}

export function bugWorkbook(rows: Record<string, unknown>[]): XLSX.WorkBook {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([BUG_COLUMNS.map((c) => c.label), ...rows.map((r) => BUG_COLUMNS.map((c) => text(r[c.key])))]), 'Bug Reports');
  return wb;
}

// The import template: a header row (Module and Scenario marked *) and one sample row.
export function templateWorkbook(): XLSX.WorkBook {
  const cols = TC_COLUMNS.filter((c) => c.key !== 'code').map((c) => (['module', 'scenario'].includes(c.key) ? { ...c, label: `${c.label} *` } : c));
  const sample: Record<string, string> = {
    module: 'Login', role_user: 'Customer', scenario: 'Login dengan kredensial valid', test_case: 'Verifikasi login sukses dengan email & password valid', preconditions: 'User terdaftar',
    steps: '1. Buka app\n2. Input email/password\n3. Klik Login', test_data: 'email: user@test.com / password: Test1234', type_test: 'Positive', expected_result: 'User masuk ke Dashboard',
  };
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet([cols.map((c) => c.label), cols.map((c) => sample[c.key] ?? '')]);
  ws['!cols'] = cols.map((c) => ({ wch: c.width ?? 12 }));
  XLSX.utils.book_append_sheet(wb, ws, 'Template');
  return wb;
}

export const workbookBytes = (wb: XLSX.WorkBook): Uint8Array<ArrayBuffer> => new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer);

export interface ParsedImport { rows: Record<string, string>[]; errors: string[]; sheetsUsed: number; unknown: string[] }

// Reads every sheet (the export writes one per module). A row with no Module takes the sheet name, unless it is a generic one.
export function parseImport(data: ArrayBuffer | Uint8Array): ParsedImport {
  const wb = XLSX.read(data, { type: 'array' });
  const sheets = wb.SheetNames.map((name) => {
    const sheetModule = /^(sheet\s*\d*|template)$/i.test(name.trim()) ? '' : name.trim();
    return TC_IMPORT.parseSheet(name, XLSX.utils.sheet_to_json(wb.Sheets[name], { defval: '', blankrows: false }) as Record<string, unknown>[], sheetModule, TC_TYPES, TC_STATUSES);
  });
  return { rows: sheets.flatMap((s) => s.rows), errors: sheets.flatMap((s) => s.errors), sheetsUsed: sheets.filter((s) => s.rows.length).length, unknown: [...new Set(sheets.flatMap((s) => s.unknown))] };
}

// Nothing is written unless the whole file is valid (legacy). New rows get no code: the server numbers them on push, in file order per module.
export async function importTestcases(ctx: Ctx, fileId: string, parsed: ParsedImport): Promise<number> {
  if (parsed.errors.length) throw new Error(parsed.errors.slice(0, 8).join('\n'));
  if (!parsed.rows.length) throw new Error('Tidak ada test case di file.');
  const ws = ((await ctx.db.get('SELECT workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined)?.workspace_id as string | null ?? null;
  for (const r of parsed.rows) {
    await createTestcase(ctx, fileId, {
      module: r.module, role_user: r.roleUser || '', scenario: r.scenario, test_case: r.testCase || '', preconditions: r.preconditions || '',
      steps: textToStepsHtml(r.steps || ''), test_data: r.testData || '', expected_result: r.expectedResult || '', actual_result: r.actualResult || '',
      evidence: r.evidence || '', status: r.status || 'Open', type_test: r.typeTest || 'Positive', execution_date: '',
    });
  }
  await logActivity(ctx, ws, 'testcase_create', `${parsed.rows.length} test case di-import dari ${parsed.sheetsUsed} sheet`);
  return parsed.rows.length;
}

// JSON backup of this device's copy of the synced tables. Restore upserts by id with fresh clocks, so it merges into what is there.
export const BACKUP_TABLES: SyncedTable[] = ['files', 'file_shares', 'testcases', 'bugs', 'bug_events', 'bug_status_master', 'custom_field_defs'];
export interface Backup { app: 'bugrail'; version: 1; exportedAt: string; tables: Record<string, Row[]> }

export async function makeBackup(db: Db): Promise<Backup> {
  const tables: Record<string, Row[]> = {};
  for (const t of BACKUP_TABLES) tables[t] = (await db.all(`SELECT * FROM ${t} WHERE ${TABLES[t].kind === 'insert-only' ? '1' : 'deleted_at IS NULL'}`)) as Row[];
  return { app: 'bugrail', version: 1, exportedAt: new Date().toISOString(), tables };
}

// Local-only columns (sync cursor, clocks) are dropped: restored rows are new local writes and the server numbers and orders them.
const LOCAL_COLS = new Set(['server_seq', 'hlc', 'status_hlc', 'updated_by', 'deleted_at']);
export function parseBackup(raw: string): Backup {
  let data: Backup;
  try { data = JSON.parse(raw); } catch { throw new Error('File bukan JSON yang valid.'); }
  if (!data || data.app !== 'bugrail' || data.version !== 1 || typeof data.tables !== 'object') throw new Error('File bukan backup BugRail.');
  return data;
}
export async function restoreBackup(ctx: Ctx, b: Backup): Promise<number> {
  let n = 0;
  for (const t of BACKUP_TABLES) {
    for (const row of b.tables[t] ?? []) {
      if (typeof row.id !== 'string') continue;
      const patch: Row = {};
      for (const [k, v] of Object.entries(row)) if (!LOCAL_COLS.has(k) && k !== 'id') patch[k] = v;
      // A restored bug or test case keeps its code only through the server; clearing it makes the next push number it.
      if (t === 'bugs' || t === 'testcases') delete patch.code;
      await upsertRow(ctx, t, row.id, patch);
      n++;
    }
  }
  return n;
}
