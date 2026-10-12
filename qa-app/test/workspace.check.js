// Run: node qa-app/test/workspace.check.js
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const ctx = {};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/workspace.js'), 'utf8') + '\nthis.W = WorkspaceCalc;', ctx);
const W = ctx.W;
const json = v => JSON.stringify(v);

// Legacy single workspaceId and new workspaceIds both work
assert.strictEqual(json(W.userWorkspaceIds({ workspaceId: 'A' })), '["A"]');
assert.strictEqual(json(W.userWorkspaceIds({ workspaceIds: ['A', 'B'] })), '["A","B"]');
assert.strictEqual(json(W.userWorkspaceIds({})), '[]');

// Auto-enter: none -> '' (shared only), one -> it, many -> picker unless "remember"
assert.strictEqual(W.autoEnter([], {}), '');
assert.strictEqual(W.autoEnter(['A'], {}), 'A');
assert.strictEqual(W.autoEnter(['A', 'B'], { autoOpen: false, last: 'B' }), null);
assert.strictEqual(W.autoEnter(['A', 'B'], { autoOpen: true, last: 'B' }), 'B');
assert.strictEqual(W.autoEnter(['A', 'B'], { remember: true, last: 'B' }), null, 'old default-on remember no longer skips the picker');
assert.strictEqual(W.autoEnter(['A', 'B'], { autoOpen: true, last: 'GONE' }), null, 'removed workspace -> picker');

assert.strictEqual(W.initials('New ERP'), 'NE');
assert.strictEqual(W.initials('Saffmedic'), 'SA');

// Cards: stats only from files owned by that workspace; newest visit = "Terakhir"
const cards = W.cards({
  workspaces: [{ id: 'A', name: 'New ERP' }, { id: 'B', name: 'Saffmedic' }, { id: 'C', name: 'Not mine' }],
  ids: ['A', 'B'],
  files: [{ id: 'F1', workspaceId: 'A', name: 'Old', createdAt: '2026-01-01' }, { id: 'F2', workspaceId: 'A', name: 'New', createdAt: '2026-02-01' }, { id: 'F3', workspaceId: 'C' }],
  testcases: [{ fileId: 'F1' }, { fileId: 'F2' }, { fileId: 'F3' }],
  bugs: [{ fileId: 'F1', status: 'Open' }, { fileId: 'F2', status: 'Closed' }, { fileId: 'F3', status: 'Open' }],
  visits: { A: '2026-03-01T00:00:00Z', B: '2026-03-05T00:00:00Z', C: '2026-04-01T00:00:00Z' }
});
assert.strictEqual(json(cards.map(c => [c.id, c.files, c.testcases, c.openBugs])), '[["A",2,2,1],["B",0,0,0]]');
assert.strictEqual(cards[0].latestFile.name, 'New');
assert.strictEqual(json(cards.map(c => c.isLast)), '[false,true]', 'C is not the user\'s, so B is last');

assert.strictEqual(W.timeAgo(new Date(Date.now() - 2 * 36e5).toISOString()), '2 jam lalu');

// Admin's "Semua workspace" card aggregates everything
const allCard = W.cards({ workspaces: [{ id: 'A', name: 'New ERP' }], ids: [W.ALL, 'A'],
  files: [{ id: 'F1', workspaceId: 'A' }, { id: 'F9', workspaceId: 'Z' }], testcases: [{ fileId: 'F1' }, { fileId: 'F9' }], bugs: [{ fileId: 'F9', status: 'Open' }] });
assert.strictEqual(json(allCard.map(c => [c.id, c.initials, c.files, c.testcases, c.openBugs])), `[["${W.ALL}","ALL",2,2,1],["A","NE",1,1,0]]`);
assert.strictEqual(W.autoEnter([W.ALL], {}), W.ALL, 'admin with no workspaces goes straight to all');

// Auth: admin is filtered by the active workspace unless on "Semua workspace"
const mem = () => ({ d: {}, getItem(k){ return this.d[k] ?? null; }, setItem(k, v){ this.d[k] = v; } });
const actx = { sessionStorage: mem(), localStorage: mem(),
  document: { addEventListener(){} }, WorkspaceCalc: W };
vm.createContext(actx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../js/auth.js'), 'utf8') + '\nthis.Auth = Auth;', actx);
const A = actx.Auth, ss = actx.sessionStorage;
const files = [{ id: 'F1', workspaceId: 'A' }, { id: 'F2', workspaceId: 'B' }, { id: 'F3' }];
ss.setItem(A.ROLE_KEY, 'admin'); ss.setItem(A.WORKSPACE_KEY, W.ALL);
assert.strictEqual(A.currentWorkspaceId(), null);
assert.strictEqual(A.visibleFiles(files).length, 3, 'admin on all sees every file');
ss.setItem(A.WORKSPACE_KEY, 'A');
assert.strictEqual(json(A.visibleFiles(files).map(f => f.id)), '["F1","F3"]', 'admin on A: A + shared only');
ss.setItem(A.ROLE_KEY, 'qa_internal'); ss.setItem(A.WORKSPACE_KEY, W.ALL);
assert.strictEqual(json(A.visibleFiles(files).map(f => f.id)), '["F3"]', 'non-admin can never use ALL');

// Shared bug link: which workspace to open (null = no access)
const fA = { workspaceId: 'A' }, fShared = {}, fToB = { workspaceId: 'A', sharedWith: ['B'] };
assert.strictEqual(W.workspaceForFile(fA, ['A', 'B'], false, 'B'), 'A', 'switch to the bug workspace');
assert.strictEqual(W.workspaceForFile(fA, ['A', 'B'], false, 'A'), 'A', 'already there');
assert.strictEqual(W.workspaceForFile(fA, ['B'], false, 'B'), null, 'no access to A');
assert.strictEqual(W.workspaceForFile(fToB, ['B'], false, 'B'), 'B', 'file shared into my workspace');
assert.strictEqual(W.workspaceForFile(fShared, ['B'], false, 'B'), 'B', 'legacy shared file visible anywhere');
assert.strictEqual(W.workspaceForFile(fShared, [], false, ''), '', 'workspace-less user, shared file');
assert.strictEqual(W.workspaceForFile(fA, [W.ALL, 'A'], true, W.ALL), W.ALL, 'admin on all stays on all');
assert.strictEqual(W.workspaceForFile(fA, [W.ALL, 'A', 'B'], true, 'B'), 'A', 'admin switches to the bug workspace');
assert.strictEqual(W.workspaceForFile(null, ['A'], false, 'A'), null, 'file deleted');

console.log('workspace.check.js: all checks passed');
