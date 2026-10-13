import { test } from 'bun:test';
import assert from 'node:assert';
import { TC_IMPORT } from '../lib/domain/forms';


test('test case import aliases and row errors', () => {
  const TYPES = ['Negative', 'Positive'];
  const STATUSES = ['Open', 'Passed', 'Failed', 'Blocked', 'Retest'];
  const row = (o: Record<string, string>, n: number) => Object.defineProperty(o, '__rowNum__', { value: n }); // SheetJS: 0-based, non-enumerable

  // Near-miss headers map to the right fields; export-only columns are skipped silently.
  assert.strictEqual(TC_IMPORT.field('Module *'), 'module');
  assert.strictEqual(TC_IMPORT.field('Pre-Kondisi'), 'preconditions');
  assert.strictEqual(TC_IMPORT.field('Test Steps'), 'steps');
  assert.strictEqual(TC_IMPORT.field('expected_result'), 'expectedResult');
  assert.strictEqual(TC_IMPORT.field('Skenario'), 'scenario');
  assert.strictEqual(TC_IMPORT.field('Test Case ID'), '_skip');
  assert.strictEqual(TC_IMPORT.field('Prioritas'), null);

  const out = TC_IMPORT.parseSheet('Login', [
    row({ 'Skenario': 'Login valid', 'Langkah': '1. Buka', 'Expected': 'Masuk', 'Tipe': 'negative', 'Prioritas': 'High', 'Status': 'failed', 'Actual Result': 'Error 500' }, 1),
    row({ 'Skenario': '', 'Langkah': 'x', 'Expected': '', 'Tipe': '', 'Prioritas': '', 'Status': '', 'Actual Result': '' }, 2),
    row({ 'Skenario': 'B', 'Langkah': '', 'Expected': '', 'Tipe': 'Smoke', 'Prioritas': '', 'Status': 'Done', 'Actual Result': '' }, 5)
  ], 'Login', TYPES, STATUSES);
  assert.strictEqual(out.rows.length, 1);
  assert.strictEqual(out.rows[0].module, 'Login', 'module falls back to sheet name');
  assert.strictEqual(out.rows[0].steps, '1. Buka');
  assert.strictEqual(out.rows[0].typeTest, 'Negative', 'type test case-insensitive');
  assert.strictEqual(out.rows[0].status, 'Failed', 'status imported, case-insensitive');
  assert.strictEqual(out.rows[0].actualResult, 'Error 500', 'actual result imported');
  assert.strictEqual(TC_IMPORT.parseSheet('S', [row({ Scenario: 'A', Status: 'Not Run' }, 1)], 'M', TYPES, STATUSES).rows[0].status, 'Open', 'old "Not Run" -> Open');
  assert.deepStrictEqual([...out.unknown], ['Prioritas']);
  assert.deepStrictEqual([...out.errors], [
    'Login baris 3: Scenario kosong',
    'Login baris 6: Type Test harus Negative/Positive',
    'Login baris 6: Status harus Open/Passed/Failed/Blocked/Retest'
  ]);

  // Same problem on many rows: one line, rows capped at 5.
  const many = Array.from({ length: 7 }, (_, n) => row({ Scenario: '', Langkah: 'x' }, n + 1));
  assert.deepStrictEqual([...TC_IMPORT.parseSheet('Login', many, 'Login', TYPES).errors], ['Login baris 2, 3, 4, 5, 6 (+2): Scenario kosong']);

  // Generic sheet without Module column: every row needs a module.
  assert.match(TC_IMPORT.parseSheet('Sheet1', [row({ Scenario: 'A' }, 1)], '', TYPES).errors[0], /baris 2: Module kosong/);
  // No scenario-like column: one sheet-level error instead of per-row noise.
  assert.match(TC_IMPORT.parseSheet('Data', [row({ Nama: 'A' }, 1)], 'Data', TYPES).errors[0], /^Data: kolom Scenario tidak ada$/);

  // Bug Report template is refused, not half-imported as test cases.
  assert.deepStrictEqual([...TC_IMPORT.parseSheet('Template', [row({ 'Module *': 'Login', 'Scenario': 'A', 'Bug Title *': 'x' }, 1)], '', TYPES).errors], ['Template: ini template Bug Report, bukan Test Case']);

});
