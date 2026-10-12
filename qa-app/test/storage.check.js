// Run: node qa-app/test/storage.check.js
// A save that doesn't reach the server must survive a reload and be re-sent,
// instead of being overwritten by the (older) server copy.
const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const path = require('path');

const src = fs.readFileSync(path.join(__dirname, '../js/utils.js'), 'utf8');
const storageSrc = src.match(/const Storage = \{[\s\S]*?\n\};/)[0] + '\n' + src.match(/const KvMerge = \{[\s\S]*?\n\};/)[0];

function makeEnv(server){
  const ls = {};
  const puts = [];
  const ctx = {
    localStorage: { getItem: k => (k in ls ? ls[k] : null), setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } },
    STORAGE_KEYS: { TESTCASES: 'qa_testcases' },
    API_BASE: '/api',
    Auth: { role: () => 'admin', currentWorkspaceId: () => '', can: () => true },
    Toast: { show(){} },
    AbortSignal: { timeout: () => undefined },
    console: { error(){} },
    fetch: async (url, opts = {}) => {
      if (!server.up) throw new Error('ERR_CONNECTION_REFUSED');
      server.revs = server.revs || {};
      const key = url.split('/').pop();
      if (opts.method === 'PUT'){
        const { value, rev } = JSON.parse(opts.body);
        if (server.putStatus === 200 && rev !== (server.revs[key] || 0)) return { ok: false, status: 409, json: async () => ({ stale: true }) };
        if (server.putStatus === 200){ server.data[key] = value; server.revs[key] = (server.revs[key] || 0) + 1; }
        puts.push(key);
        return { ok: server.putStatus === 200, status: server.putStatus, json: async () => ({ rev: server.revs[key] }) };
      }
      const copy = v => JSON.parse(JSON.stringify(v));
      if (key !== 'kv') return { ok: true, status: 200, json: async () => ({ value: copy(server.data[key] ?? null), rev: server.revs[key] || 0 }) };
      return { ok: true, status: 200, json: async () => ({ ...copy(server.data), _revs: { ...server.revs } }) };
    }
  };
  vm.createContext(ctx);
  vm.runInContext(storageSrc + '\nthis.Storage = Storage;', ctx);
  return { S: ctx.Storage, ls, puts, ctx };
}

(async () => {
  // 1) Server down while saving -> kept as unsynced, survives reload, re-sent when server is back
  const server = { up: true, putStatus: 200, data: { qa_testcases: [{ id: 'OLD' }] } };
  let env = makeEnv(server);
  await env.S.hydrate();
  server.up = false;
  await env.S.set('qa_testcases', [{ id: 'OLD' }, { id: 'NEW' }]);
  assert.ok(env.S.hasUnsynced(), 'failed save is marked unsynced');

  server.up = true;
  const reopened = makeEnv(server);
  Object.assign(reopened.ls, env.ls);                 // same browser, new page load
  await reopened.S.hydrate();
  assert.strictEqual(JSON.stringify(reopened.S.get('qa_testcases').map(t => t.id)), '["OLD","NEW"]', 'local unsynced copy wins over older server copy');
  assert.strictEqual(JSON.stringify(server.data.qa_testcases.map(t => t.id)), '["OLD","NEW"]', 're-sent to server on load');
  assert.ok(!reopened.S.hasUnsynced(), 'cleared once the server has it');

  // 2) HTTP error (e.g. 500/403) is a failure too, not a silent success
  server.putStatus = 500;
  await reopened.S.set('qa_testcases', [{ id: 'X' }]);
  assert.ok(reopened.S.hasUnsynced(), 'HTTP 500 keeps the change unsynced');
  server.putStatus = 200;

  // 3) Normal save: nothing left pending
  const ok = makeEnv({ up: true, putStatus: 200, data: {} });
  await ok.S.hydrate();
  await ok.S.set('qa_testcases', [{ id: 'A' }]);
  assert.ok(!ok.S.hasUnsynced());

  // 4) Booted offline (fresh browser, no real data): saves stay local and are NEVER
  //    sent later — this is how a seed qa_settings once replaced the real one.
  const real = { up: false, putStatus: 200, data: { qa_settings: { users: ['a', 'b'], workspaces: ['WS-1'] } } };
  const offline = makeEnv(real);
  await offline.S.hydrate();
  await offline.S.set('qa_settings', { users: ['seed-admin'] });
  real.up = true;
  await offline.S.set('qa_settings', { users: ['seed-admin'], theme: 'dark' }); // server back mid-session: still local only
  assert.deepStrictEqual(offline.puts, [], 'offline-boot session never PUTs');
  const later = makeEnv(real);
  Object.assign(later.ls, offline.ls);
  await later.S.hydrate();
  assert.deepStrictEqual(later.puts, [], 'nothing re-sent on the next online load');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(real.data.qa_settings)), { users: ['a', 'b'], workspaces: ['WS-1'] }, 'real settings untouched');
  assert.deepStrictEqual(JSON.parse(JSON.stringify(later.S.get('qa_settings'))), { users: ['a', 'b'], workspaces: ['WS-1'] }, 'online load shows server data');

  // 5) Two tabs, same old copy: tab A edits row 1, tab B (stale) edits row 2.
  //    B's write is refused (409), merged with A's, re-sent: both edits survive.
  const shared = { up: true, putStatus: 200, data: { qa_testcases: [{ id: '1', status: 'Open' }, { id: '2', status: 'Open' }] } };
  const A = makeEnv(shared), B = makeEnv(shared);
  await A.S.hydrate(); await B.S.hydrate();
  await A.S.set('qa_testcases', [{ id: '1', status: 'Failed' }, { id: '2', status: 'Open' }]);
  let merged = 0; B.S.onMerged = () => merged++;
  await B.S.set('qa_testcases', [{ id: '1', status: 'Open' }, { id: '2', status: 'Passed' }, { id: '3', status: 'Open' }]);
  assert.strictEqual(JSON.stringify(shared.data.qa_testcases.map(t => t.status)), '["Failed","Passed","Open"]', "stale tab keeps the other tab's Failed");
  assert.strictEqual(merged, 1, 'app told to reload the merged data');
  assert.ok(!B.S.hasUnsynced());

  // 6) Deletes merge too: A deletes row 1, stale B adds row 4 -> row 1 stays deleted.
  await A.S.refresh();
  await A.S.set('qa_testcases', shared.data.qa_testcases.filter(t => t.id !== '1'));
  await B.S.set('qa_testcases', [...B.S.get('qa_testcases'), { id: '4', status: 'Open' }]);
  assert.strictEqual(JSON.stringify(shared.data.qa_testcases.map(t => t.id)), '["2","3","4"]');

  // 7) Back-to-back saves from one tab are queued, not refused as stale by each other.
  const q = makeEnv({ up: true, putStatus: 200, data: { qa_testcases: [] } });
  await q.S.hydrate();
  await Promise.all([q.S.set('qa_testcases', [{ id: 'a' }]), q.S.set('qa_testcases', [{ id: 'a' }, { id: 'b' }])]);
  assert.ok(!q.S.hasUnsynced());

  console.log('storage.check.js: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
