import { test } from 'bun:test';
import assert from 'node:assert';
import { WorkspaceCalc } from '../lib/domain/workspace';

test('WorkspaceCalc: ids, auto-enter, cards, shared-link routing', () => {
  const json = (v: unknown) => JSON.stringify(v);

  // Legacy single workspaceId and new workspaceIds both work
  assert.strictEqual(json(WorkspaceCalc.userWorkspaceIds({ workspaceId: 'A' })), '["A"]');
  assert.strictEqual(json(WorkspaceCalc.userWorkspaceIds({ workspaceIds: ['A', 'B'] })), '["A","B"]');
  assert.strictEqual(json(WorkspaceCalc.userWorkspaceIds({})), '[]');

  // Auto-enter: none -> '' (shared only), one -> it, many -> picker unless "remember"
  assert.strictEqual(WorkspaceCalc.autoEnter([], {}), '');
  assert.strictEqual(WorkspaceCalc.autoEnter(['A'], {}), 'A');
  assert.strictEqual(WorkspaceCalc.autoEnter(['A', 'B'], { autoOpen: false, last: 'B' }), null);
  assert.strictEqual(WorkspaceCalc.autoEnter(['A', 'B'], { autoOpen: true, last: 'B' }), 'B');
  assert.strictEqual(WorkspaceCalc.autoEnter(['A', 'B'], { remember: true, last: 'B' }), null, 'old default-on remember no longer skips the picker');
  assert.strictEqual(WorkspaceCalc.autoEnter(['A', 'B'], { autoOpen: true, last: 'GONE' }), null, 'removed workspace -> picker');

  assert.strictEqual(WorkspaceCalc.initials('New ERP'), 'NE');
  assert.strictEqual(WorkspaceCalc.initials('Saffmedic'), 'SA');

  // Cards: stats only from files owned by that workspace; newest visit = "Terakhir"
  const cards = WorkspaceCalc.cards({
    workspaces: [{ id: 'A', name: 'New ERP' }, { id: 'B', name: 'Saffmedic' }, { id: 'C', name: 'Not mine' }],
    ids: ['A', 'B'],
    files: [{ id: 'F1', workspaceId: 'A', name: 'Old', createdAt: '2026-01-01' }, { id: 'F2', workspaceId: 'A', name: 'New', createdAt: '2026-02-01' }, { id: 'F3', workspaceId: 'C' }],
    testcases: [{ fileId: 'F1' }, { fileId: 'F2' }, { fileId: 'F3' }],
    bugs: [{ fileId: 'F1', status: 'OPEN' }, { fileId: 'F2', status: 'CLOSED' }, { fileId: 'F3', status: 'OPEN' }],
    visits: { A: '2026-03-01T00:00:00Z', B: '2026-03-05T00:00:00Z', C: '2026-04-01T00:00:00Z' }
  });
  assert.strictEqual(json(cards.map(c => [c.id, c.files, c.testcases, c.openBugs])), '[["A",2,2,1],["B",0,0,0]]');
  assert.strictEqual(cards[0].latestFile!.name, 'New');
  assert.strictEqual(json(cards.map(c => c.isLast)), '[false,true]', 'C is not the user\'s, so B is last');

  assert.strictEqual(WorkspaceCalc.timeAgo(new Date(Date.now() - 2 * 36e5).toISOString()), '2 jam lalu');

  // Admin's "Semua workspace" card aggregates everything
  const allCard = WorkspaceCalc.cards({ workspaces: [{ id: 'A', name: 'New ERP' }], ids: [WorkspaceCalc.ALL, 'A'],
    files: [{ id: 'F1', workspaceId: 'A' }, { id: 'F9', workspaceId: 'Z' }], testcases: [{ fileId: 'F1' }, { fileId: 'F9' }], bugs: [{ fileId: 'F9', status: 'OPEN' }] });
  assert.strictEqual(json(allCard.map(c => [c.id, c.initials, c.files, c.testcases, c.openBugs])), `[["${WorkspaceCalc.ALL}","ALL",2,2,1],["A","NE",1,1,0]]`);
  assert.strictEqual(WorkspaceCalc.autoEnter([WorkspaceCalc.ALL], {}), WorkspaceCalc.ALL, 'admin with no workspaces goes straight to all');

  // Shared bug link: which workspace to open (null = no access)
  const fA = { workspaceId: 'A' }, fShared = {}, fToB = { workspaceId: 'A', sharedWith: ['B'] };
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fA, ['A', 'B'], false, 'B'), 'A', 'switch to the bug workspace');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fA, ['A', 'B'], false, 'A'), 'A', 'already there');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fA, ['B'], false, 'B'), null, 'no access to A');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fToB, ['B'], false, 'B'), 'B', 'file shared into my workspace');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fShared, ['B'], false, 'B'), 'B', 'legacy shared file visible anywhere');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fShared, [], false, ''), '', 'workspace-less user, shared file');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fA, [WorkspaceCalc.ALL, 'A'], true, WorkspaceCalc.ALL), WorkspaceCalc.ALL, 'admin on all stays on all');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(fA, [WorkspaceCalc.ALL, 'A', 'B'], true, 'B'), 'A', 'admin switches to the bug workspace');
  assert.strictEqual(WorkspaceCalc.workspaceForFile(null, ['A'], false, 'A'), null, 'file deleted');

});
