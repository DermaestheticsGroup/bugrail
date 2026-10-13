import { test } from 'bun:test';
import assert from 'node:assert';
import { statusTransitionRule } from '../lib/domain/status';


test('status transition rules', () => {
  // Dev flow: no note
  assert.deepStrictEqual({ ...statusTransitionRule('OPEN', 'IN_PROGRESS', false) }, { ok: true, needNote: false });
  assert.deepStrictEqual({ ...statusTransitionRule('IN_PROGRESS', 'RETEST', false) }, { ok: true, needNote: false });
  assert.deepStrictEqual({ ...statusTransitionRule('RETEST', 'OPEN', false) }, { ok: true, needNote: false });
  // Outside the dev flow: note required
  assert.deepStrictEqual({ ...statusTransitionRule('RETEST', 'CLOSED', false) }, { ok: true, needNote: true });
  assert.deepStrictEqual({ ...statusTransitionRule('OPEN', 'REJECTED', false) }, { ok: true, needNote: true });

  // QA: only from Retest to Open/Blocked/Resolved/Closed, always with a note
  ['OPEN', 'BLOCKED', 'RESOLVED', 'CLOSED'].forEach(to =>
    assert.deepStrictEqual({ ...statusTransitionRule('RETEST', to, true) }, { ok: true, needNote: true }, to));
  assert.strictEqual(statusTransitionRule('RETEST', 'IN_PROGRESS', true).ok, false);
  assert.strictEqual(statusTransitionRule('RETEST', 'REJECTED', true).ok, false);
  assert.strictEqual(statusTransitionRule('OPEN', 'IN_PROGRESS', true).ok, false);
  assert.strictEqual(statusTransitionRule('CLOSED', 'OPEN', true).ok, false);

});
