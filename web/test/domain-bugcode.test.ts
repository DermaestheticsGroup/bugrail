import { test } from 'bun:test';
import assert from 'node:assert';
import { IdGen, bugCode, compareRows } from '../lib/domain/ids';


test('bug display codes, per-scope numbering, natural sort', () => {
  // Next number = highest number still present in that workspace + 1 (no stored counter),
  // so deleting test cases / bugs frees their numbers instead of leaving the counter high.
  assert.strictEqual(IdGen.nextInScope('BUG', []), 'BUG-0001', 'empty workspace starts at 0001');
  assert.strictEqual(IdGen.nextInScope('BUG', ['BUG-0001', 'BUG-0002']), 'BUG-0003');
  assert.strictEqual(IdGen.nextInScope('BUG', ['BUG-0001']), 'BUG-0002', 'after deleting BUG-0002, it is reused');

  const a = IdGen.uid('BUG'), b = IdGen.uid('BUG');
  assert.notStrictEqual(a, b, 'internal ids are unique');
  assert.strictEqual(bugCode({ id: a, code: 'BUG-0001' }), 'BUG-0001');
  assert.strictEqual(bugCode({ id: 'BUG-0009' }), 'BUG-0009', 'legacy bugs without code show their id');

  // Test cases: per module prefix; other prefixes and legacy/odd ids are ignored
  assert.strictEqual(IdGen.nextInScope('LOG', ['LOG-0001', 'LOG-0003', 'PAY-0009', 'ERP-1', 'x']), 'LOG-0004', 'gap in the middle stays (no renumbering)');
  assert.strictEqual(IdGen.nextInScope('PAY', ['LOG-0001']), 'PAY-0001');
  assert.strictEqual(IdGen.nextInScope('LOG', []), 'LOG-0001', 'all deleted -> back to 0001');

  // Sorting by the "id" column uses the shown number, naturally (not the random internal key)
  const rows = [{ id: 'TC-z', code: 'LOG-0010' }, { id: 'TC-a', code: 'LOG-0002' }, { id: 'TC-m', code: 'LOG-0001' }];
  const code = (r: { id: string; code?: string }) => r.code || r.id;
  assert.strictEqual(JSON.stringify(rows.slice().sort((a, b) => compareRows(a, b, 'id', 'asc', code)).map(code)), '["LOG-0001","LOG-0002","LOG-0010"]');
  assert.strictEqual(JSON.stringify(rows.slice().sort((a, b) => compareRows(a, b, 'id', 'desc', code)).map(code)), '["LOG-0010","LOG-0002","LOG-0001"]');

});
