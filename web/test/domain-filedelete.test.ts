import { test } from 'bun:test';
import assert from 'node:assert';
import { deleteFileCascade } from '../lib/domain/files';

test('deleting a file removes its test cases and its bugs (no orphans)', () => {
  const state = {
    files: [{ id: 'F1' }, { id: 'F2' }],
    testcases: [{ id: 'T1', fileId: 'F1' }, { id: 'T2', fileId: 'F2' }],
    bugs: [{ id: 'B1', fileId: 'F1' }, { id: 'B2', fileId: 'F2' }, { id: 'B3', fileId: 'F1' }],
  };
  const out = deleteFileCascade(state, 'F1');
  assert.strictEqual(JSON.stringify(out.files.map(f => f.id)), '["F2"]');
  assert.strictEqual(JSON.stringify(out.testcases.map(t => t.id)), '["T2"]');
  assert.strictEqual(JSON.stringify(out.bugs.map(b => b.id)), '["B2"]', 'bugs in the deleted file are removed too');
  assert.strictEqual(state.files.length, 2, 'input is not mutated');
});
