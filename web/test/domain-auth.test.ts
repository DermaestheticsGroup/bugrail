import { test } from 'bun:test';
import assert from 'node:assert';
import { can, canShareFile, visibleFiles, seesAllWorkspaces, currentWorkspaceId, normalizeRole, normalizeEmail, isValidEmail, DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, DEFAULT_ROLES } from '../lib/domain/auth';
import { WorkspaceCalc } from '../lib/domain/workspace';

const W = WorkspaceCalc;
const json = (v: unknown) => JSON.stringify(v);

test('visibleFiles: admin filtered by active workspace unless on Semua workspace', () => {
  const files = [{ id: 'F1', workspaceId: 'A' }, { id: 'F2', workspaceId: 'B' }, { id: 'F3' }];
  assert.strictEqual(currentWorkspaceId({ role: 'admin', workspaceId: W.ALL }), null);
  assert.strictEqual(visibleFiles(files, { role: 'admin', workspaceId: W.ALL }).length, 3, 'admin on all sees every file');
  assert.strictEqual(json(visibleFiles(files, { role: 'admin', workspaceId: 'A' }).map(f => f.id)), '["F1","F3"]', 'admin on A: A + shared only');
  assert.strictEqual(json(visibleFiles(files, { role: 'qa_internal', workspaceId: W.ALL }).map(f => f.id)), '["F3"]', 'non-admin can never use ALL');
  assert.strictEqual(json(visibleFiles([{ id: 'F4', workspaceId: 'A', sharedWith: ['B'] }], { role: 'qa_vendor', workspaceId: 'B' }).map(f => f.id)), '["F4"]', 'shared into my workspace');
  assert.strictEqual(seesAllWorkspaces({ role: 'admin' }), true, 'admin with no workspace chosen');
  assert.strictEqual(seesAllWorkspaces({ role: 'pm_ba' }), false);
});

test('can: admin always, seed matrix, saved matrix overrides, unknown role/key false', () => {
  assert.strictEqual(can({ role: 'admin' }, 'anything'), true);
  assert.strictEqual(can({ role: 'qa_internal' }, 'testcase_create'), true);
  assert.strictEqual(can({ role: 'qa_internal' }, 'usermanagement'), false);
  assert.strictEqual(can({ role: 'pm_ba' }, 'report'), true);
  assert.strictEqual(can({ role: 'pm_ba' }, 'bugreport_create'), false);
  assert.strictEqual(can({ role: 'qa_internal' }, 'no_such_key'), false, 'unknown permission key');
  assert.strictEqual(can({ role: 'ghost' }, 'dashboard'), false, 'unknown role');
  assert.strictEqual(can({}, 'dashboard'), false, 'no session');
  assert.strictEqual(can({ role: 'user' }, 'testcase_read'), true, 'legacy "user" role reads as user_umum');
  assert.strictEqual(normalizeRole('user'), 'user_umum');
  const saved = { pm_ba: { usermanagement: true } };
  assert.strictEqual(can({ role: 'pm_ba' }, 'usermanagement', saved), true, 'saved row grants');
  assert.strictEqual(can({ role: 'pm_ba' }, 'report', saved), false, 'saved row replaces the seed row');
  assert.strictEqual(can({ role: 'qa_vendor' }, 'testcase_read', saved), true, 'role without a saved row keeps the seed');
});

test('permission seeds only reference known keys; roles unique', () => {
  const known = new Set(PERMISSION_KEYS.map(k => k.key));
  for (const [role, map] of Object.entries(DEFAULT_ROLE_PERMISSIONS)) {
    for (const k of Object.keys(map)) assert.ok(known.has(k), `${role}.${k}`);
  }
  assert.strictEqual(new Set(DEFAULT_ROLES.map(r => r.value)).size, DEFAULT_ROLES.length);
  assert.ok(DEFAULT_ROLES.every(r => r.value in DEFAULT_ROLE_PERMISSIONS));
});

test('canShareFile: owner workspace or admin, with testcase_fileShare', () => {
  assert.strictEqual(canShareFile({ workspaceId: 'A' }, { role: 'qa_internal', workspaceId: 'A' }), true);
  assert.strictEqual(canShareFile({ workspaceId: 'A' }, { role: 'qa_internal', workspaceId: 'B' }), false, 'not the owner');
  assert.strictEqual(canShareFile({}, { role: 'qa_internal', workspaceId: 'A' }), false, 'shared/legacy file has no owner');
  assert.strictEqual(canShareFile({ workspaceId: 'A' }, { role: 'qa_vendor', workspaceId: 'A' }), false, 'no testcase_fileShare');
  assert.strictEqual(canShareFile({ workspaceId: 'A' }, { role: 'admin', workspaceId: 'B' }), true);
});

test('email helpers', () => {
  assert.strictEqual(normalizeEmail('  QA@X.com '), 'qa@x.com');
  assert.strictEqual(normalizeEmail(null), '');
  assert.strictEqual(isValidEmail('a@b.co'), true);
  assert.strictEqual(isValidEmail('a@b'), false);
  assert.strictEqual(isValidEmail(' '), false);
  assert.strictEqual(isValidEmail(undefined), false);
});
