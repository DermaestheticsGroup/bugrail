// Run: node qa-app/test/tcimport.check.js
// Test case import: header aliases + per-row errors with sheet row numbers.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const ctx = {};
vm.createContext(ctx);
vm.runInContext(src.match(/const TC_IMPORT = \{[\s\S]*?\n\};/)[0] + '\nthis.T = TC_IMPORT;', ctx);
const { T } = ctx;
const TYPES = ['Negative', 'Positive'];
const STATUSES = ['Open', 'Passed', 'Failed', 'Blocked', 'Retest'];
const row = (o, n) => Object.defineProperty(o, '__rowNum__', { value: n }); // SheetJS: 0-based, non-enumerable

// Near-miss headers map to the right fields; export-only columns are skipped silently.
assert.strictEqual(T.field('Module *'), 'module');
assert.strictEqual(T.field('Pre-Kondisi'), 'preconditions');
assert.strictEqual(T.field('Test Steps'), 'steps');
assert.strictEqual(T.field('expected_result'), 'expectedResult');
assert.strictEqual(T.field('Skenario'), 'scenario');
assert.strictEqual(T.field('Test Case ID'), '_skip');
assert.strictEqual(T.field('Prioritas'), null);

const out = T.parseSheet('Login', [
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
assert.strictEqual(T.parseSheet('S', [row({ Scenario: 'A', Status: 'Not Run' }, 1)], 'M', TYPES, STATUSES).rows[0].status, 'Open', 'old "Not Run" -> Open');
assert.deepStrictEqual([...out.unknown], ['Prioritas']);
assert.deepStrictEqual([...out.errors], [
  'Login baris 3: Scenario kosong',
  'Login baris 6: Type Test harus Negative/Positive',
  'Login baris 6: Status harus Open/Passed/Failed/Blocked/Retest'
]);

// Same problem on many rows: one line, rows capped at 5.
const many = Array.from({ length: 7 }, (_, n) => row({ Scenario: '', Langkah: 'x' }, n + 1));
assert.deepStrictEqual([...T.parseSheet('Login', many, 'Login', TYPES).errors], ['Login baris 2, 3, 4, 5, 6 (+2): Scenario kosong']);

// Generic sheet without Module column: every row needs a module.
assert.match(T.parseSheet('Sheet1', [row({ Scenario: 'A' }, 1)], '', TYPES).errors[0], /baris 2: Module kosong/);
// No scenario-like column: one sheet-level error instead of per-row noise.
assert.match(T.parseSheet('Data', [row({ Nama: 'A' }, 1)], 'Data', TYPES).errors[0], /^Data: kolom Scenario tidak ada$/);

// Bug Report template is refused, not half-imported as test cases.
assert.deepStrictEqual([...T.parseSheet('Template', [row({ 'Module *': 'Login', 'Scenario': 'A', 'Bug Title *': 'x' }, 1)], '', TYPES).errors], ['Template: ini template Bug Report, bukan Test Case']);

console.log('tcimport.check OK');
