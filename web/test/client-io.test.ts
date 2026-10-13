import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import * as XLSX from 'xlsx';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { createFile, type Ctx } from '../lib/client/repo';
import { arrayToCSV, bugExportRows, importTestcases, makeBackup, parseBackup, parseImport, restoreBackup, tcExportColumns, tcExportRows, tcWorkbook, templateWorkbook, workbookBytes, BUG_COLUMNS } from '../lib/client/io';
import type { Db, Row } from '../lib/db-types';

let db: Db, ctx: Ctx, fid: string;
const make = async () => { const d = (await connect(':memory:')) as unknown as Db; await applyMigrations(d, 'local'); return d; };
const book = (sheets: Record<string, string[][]>) => {
  const wb = XLSX.utils.book_new();
  for (const [n, aoa] of Object.entries(sheets)) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), n);
  return workbookBytes(wb);
};

beforeEach(async () => {
  db = await make();
  ctx = { db, clock: createClock('d1'), email: 'alice@bugrail.test', role: 'qa_internal', memberOf: ['ws-a'] };
  fid = String((await createFile(ctx, 'ws-a', 'F')).id);
});

describe('csv', () => {
  test('quotes every cell, doubles quotes, CRLF between lines, nulls become empty', () => {
    expect(arrayToCSV([{ a: 'x"y', b: null }], [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }])).toBe('A,B\r\n"x""y",""');
  });
});

describe('csv formulas', () => {
  test('cells and headers that start like a formula are neutralised; plain text is untouched', () => {
    const cols = [{ key: 'a', label: '=H' }, { key: 'b', label: 'b' }, { key: 'c', label: 'c' }];
    expect(arrayToCSV([{ a: '=SUM(A1)', b: '+1', c: 'ok' }], cols)).toBe("'=H,b,c\r\n\"'=SUM(A1)\",\"'+1\",\"ok\"");
  });
});

describe('import', () => {
  const header = ['Module *', 'Scenario *', 'Test Step', 'Type Test', 'Status'];
  test('reads every sheet; an empty Module takes the sheet name unless it is generic; ids ignored; rows get fresh Open cases without a code', async () => {
    const parsed = parseImport(book({
      Login: [['Test Case ID', 'Scenario', 'Test Step', 'Type Test'], ['TC-9', 'Wrong password', '1. open\n2. press', 'negative']],
      Sheet1: [header, ['Cart', 'Add item', '', 'Positive', 'not run']],
    }));
    expect(parsed.errors).toEqual([]);
    expect(parsed.sheetsUsed).toBe(2);
    expect(parsed.rows.map((r) => [r.module, r.scenario, r.typeTest, r.status ?? ''])).toEqual([['Login', 'Wrong password', 'Negative', ''], ['Cart', 'Add item', 'Positive', 'Open']]);
    expect(await importTestcases(ctx, fid, parsed)).toBe(2);
    const rows = (await db.all('SELECT * FROM testcases ORDER BY rowid')) as Row[];
    expect(rows.map((r) => [r.module, r.status, r.code, r.created_by])).toEqual([['Login', 'Open', null, 'alice@bugrail.test'], ['Cart', 'Open', null, 'alice@bugrail.test']]);
    expect(String(rows[0].steps)).toContain('<li>');
    expect((await db.all("SELECT * FROM activity_log WHERE action = 'testcase_create'")).length).toBe(1);
  });
  test('one bad row blocks the whole file: nothing is written and the message names the sheet and row', async () => {
    const parsed = parseImport(book({ Login: [header, ['Login', 'ok one', '', 'Positive', ''], ['Login', '', '', 'Sideways', '']] }));
    expect(parsed.errors.join('\n')).toContain('Login baris 3');
    expect(await importTestcases(ctx, fid, parsed).catch((e) => e.message)).toContain('Login baris 3');
    expect(await db.all('SELECT * FROM testcases')).toHaveLength(0);
  });
  test('a failure mid-import soft-deletes the rows already written', async () => {
    const parsed = parseImport(book({ Login: [header, ['Login', 'one', '', 'Positive', ''], ['Login', 'two', '', 'Positive', ''], ['Login', 'three', '', 'Positive', '']] }));
    let calls = 0;
    ctx.writeBlock = () => (++calls >= 4 ? 'blocked' : null); // stays blocked through the undo
    expect(await importTestcases(ctx, fid, parsed).catch((e) => e.message)).toBe('blocked');
    ctx.writeBlock = undefined;
    expect(await db.all('SELECT * FROM testcases WHERE deleted_at IS NULL')).toHaveLength(0);
  });
  test('a Bug Report template is refused outright and a file with no rows is reported', async () => {
    expect(parseImport(book({ Bugs: [['Module', 'Scenario', 'Bug Title *'], ['a', 'b', 'c']] })).errors[0]).toContain('template Bug Report');
    expect(await importTestcases(ctx, fid, parseImport(book({ Sheet1: [header] }))).catch((e) => e.message)).toBe('Tidak ada test case di file.');
  });
  test('the downloadable template parses back as one valid row', () => {
    const p = parseImport(workbookBytes(templateWorkbook()));
    expect(p.errors).toEqual([]);
    expect(p.rows).toHaveLength(1);
    expect(p.rows[0].module).toBe('Login');
  });
  test('garbage that is not a spreadsheet does not crash the parser with a partial result', () => {
    expect(() => parseImport(new Uint8Array([1, 2, 3, 4]))).not.toThrow();
  });
});

describe('export', () => {
  test('test case rows: plain-text steps, custom fields as columns, one sheet per module with its own numbering, safe sheet names', () => {
    const tcs: Row[] = [
      { id: 'a', code: 'LOG-0001', module: 'Login', scenario: 's1', steps: '<ol><li>one</li><li>two</li></ol>', custom_fields: '{"Region":"ID"}', status: 'Open', type_test: 'Positive' },
      { id: 'b', code: 'LOG-0002', module: 'Login', scenario: 's2', steps: '', status: 'Open', type_test: 'Positive' },
      { id: 'c', code: 'PAY-0001', module: 'Pay/ments?', scenario: 's3', steps: '', status: 'Passed', type_test: 'Positive' },
    ];
    const rows = tcExportRows(tcs, ['Region']);
    expect(rows[0].steps).toBe('1. one\n2. two');
    expect(rows[0].Region).toBe('ID');
    const wb = tcWorkbook(rows, tcExportColumns(['Region']));
    expect(wb.SheetNames).toEqual(['Login', 'Pay ments']);
    const login = XLSX.utils.sheet_to_json(wb.Sheets.Login, { header: 1 }) as unknown[][];
    expect(login[0]).toContain('Region');
    expect(login.map((r) => r[0])).toEqual(['No', 1, 2]);
  });
  test('sheet names are deduplicated and cut to 31 characters', () => {
    const long = 'x'.repeat(40);
    const wb = tcWorkbook([{ module: long }, { module: `${long}!` }].map((r, i) => ({ ...r, scenario: `s${i}` })), tcExportColumns([]));
    expect(wb.SheetNames.every((n) => n.length <= 31)).toBe(true);
    expect(new Set(wb.SheetNames.map((n) => n.toLowerCase())).size).toBe(wb.SheetNames.length);
  });
  test('bug rows show the code, the test case label, the status name, the day, and the extra fields', () => {
    const rows = bugExportRows([{ id: 'b1', code: 'BUG-0001', test_case_id: 'tc1', status_code: 'IN_PROGRESS', report_date: '2026-03-05T10:00:00Z', extra: '{"os":"macOS"}', title: 'T' }], (id) => (id === 'tc1' ? 'LOG-0001' : ''), (c) => (c === 'IN_PROGRESS' ? 'In Progress' : String(c)));
    expect(rows[0]).toMatchObject({ code: 'BUG-0001', test_case: 'LOG-0001', status: 'In Progress', date: '2026-03-05', os: 'macOS' });
    expect(arrayToCSV(rows, BUG_COLUMNS).split('\r\n')[1]).toContain('"BUG-0001","LOG-0001"');
  });
});

describe('backup', () => {
  test('round trip: a backup restored into an empty device recreates files, test cases and bugs without codes; a bad file is refused', async () => {
    await db.run("INSERT INTO testcases (id, code, file_id, module, scenario, status) VALUES ('t1', 'LOG-0001', ?, 'Login', 's', 'Open')", fid);
    await db.run("INSERT INTO bugs (id, code, file_id, title, status_code) VALUES ('b1', 'BUG-0001', ?, 'T', 'OPEN')", fid);
    const text = JSON.stringify(await makeBackup(db));
    const fresh = await make();
    const c2: Ctx = { db: fresh, clock: createClock('d2'), email: 'bob@bugrail.test', role: 'qa_internal' };
    expect(await restoreBackup(c2, parseBackup(text))).toBe(3);
    const bug = (await fresh.get("SELECT * FROM bugs WHERE id = 'b1'")) as Row;
    expect([bug.title, bug.code, bug.updated_by]).toEqual(['T', null, 'bob@bugrail.test']);
    expect(await fresh.all('SELECT * FROM outbox')).toHaveLength(3);
    expect(() => parseBackup('{"app":"other"}')).toThrow('bukan backup BugRail');
    expect(() => parseBackup('nope')).toThrow('bukan JSON');
  });
  test('restoring over existing rows keeps their server code', async () => {
    await db.run("INSERT INTO bugs (id, code, file_id, title, status_code, hlc, status_hlc) VALUES ('b1', 'BUG-0001', ?, 'old', 'OPEN', '0', '0')", fid);
    const b = await makeBackup(db);
    b.tables.bugs[0].title = 'new';
    await restoreBackup(ctx, b);
    const bug = (await db.get("SELECT * FROM bugs WHERE id = 'b1'")) as Row;
    expect([bug.title, bug.code]).toEqual(['new', 'BUG-0001']);
  });
  test('tombstoned rows are not exported', async () => {
    await db.run("INSERT INTO bugs (id, file_id, title, deleted_at) VALUES ('gone', ?, 'x', '2026-01-01')", fid);
    expect((await makeBackup(db)).tables.bugs).toHaveLength(0);
  });
});
