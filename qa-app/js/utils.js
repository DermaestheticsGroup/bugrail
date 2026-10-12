/* ==========================================================
   utils.js — shared helpers used across all modules.
   Kept framework-free and dependency-free so it can be reused
   if this app is ever wired up to a real backend later:
   just swap the Storage.* implementations for API calls.
   ========================================================== */

const STORAGE_KEYS = {
  TESTCASES: 'qa_testcases',
  BUGS: 'qa_bugs',
  FILES: 'qa_files', // Test Case grouping ("file"/folder)
  SETTINGS: 'qa_settings',
  COUNTERS: 'qa_counters',
  TRASH: 'qa_trash', // holds last deleted item(s) for Undo
  ACTIVITY_LOG: 'qa_activity_log' // audit trail: login/logout + CRUD, capped at 1000 entries
};

/* ---------- MySQL-backed storage (via server/), with a localStorage
   fallback so the app still works (e.g. for an offline demo/presentation)
   when the API server is off ----------
   Data lives in the `kv_store` table on the API in server/, one JSON blob
   per key — same shape this app used to keep in localStorage.
   `hydrate()` loads every key once into `cache` on app boot (awaited
   before Auth.init() runs — see auth.js): tries the API first, and if
   that fails, falls back to whatever's in localStorage (last known-good
   data — e.g. dummy data made in an earlier offline session). After
   hydrate, get()/set() stay perfectly synchronous against `cache` (so the
   rest of the app never has to become async). set() always writes
   localStorage immediately (so data survives a reload even with the
   server off) and fires the same write to MySQL in the background
   best-effort. */
// The server serves this frontend too, so the API is same-origin ("/api") on
// localhost, a LAN IP, or the deployed VM. Only index.html opened straight from
// disk (file://) needs an absolute URL — the local server.
const API_BASE = location.protocol === 'file:' ? 'http://localhost:3001/api' : '/api';

const Storage = {
  cache: {},
  serverOnline: true,
  inflight: 0,  // PUTs not answered yet
  seq: {},      // per-key write counter, so an older reply can't clear a newer pending write
  /* True when hydrate() fell back to localStorage. That data may be stale or a
     fresh seed (new browser/origin), so this session never writes to the server —
     re-sending it later once wiped the real qa_settings (users, workspaces, roles). */
  offlineBoot: false,
  /* Keys whose latest local change hasn't been confirmed by the server (server
     down, network cut, tab closed mid-request) during an online session. Kept in
     localStorage so it survives a reload; hydrate() re-sends them instead of
     letting the older server copy overwrite them. "_v2": markers left by the old
     offline-boot behaviour are ignored instead of re-sent. */
  UNSYNCED_KEY: 'qa_unsynced_v2',
  unsynced(){
    try{ return JSON.parse(localStorage.getItem(this.UNSYNCED_KEY)) || []; }catch(e){ return []; }
  },
  markUnsynced(key, on){
    const keys = new Set(this.unsynced());
    if (on) keys.add(key); else keys.delete(key);
    try{ localStorage.setItem(this.UNSYNCED_KEY, JSON.stringify([...keys])); }catch(e){}
  },
  hasUnsynced(){ return this.inflight > 0 || this.unsynced().length > 0; },
  // Resolves once every PUT in flight has been answered (or after maxMs).
  async settle(maxMs = 5000){
    const end = Date.now() + maxMs;
    while (this.inflight > 0 && Date.now() < end) await new Promise(r => setTimeout(r, 100));
  },
  leaving: false, // set by an intentional reload (logout) — skip the "unsaved changes" prompt

  /* Optimistic lock (see PUT /api/kv in server/app.js): rev = server version of
     each key as last read/written; base = JSON of that same server copy, the
     common ancestor for a 3-way merge when the server refuses a stale write. */
  revs: {},
  base: {},
  chain: {},    // per-key promise chain: one PUT per key at a time (each carries the rev the previous one got)
  onMerged: null, // set by App: called after a key was merged with newer server data

  // Takes the server's data (+ _revs) as the new synced state.
  adopt(data){
    this.revs = data._revs || {};
    delete data._revs;
    this.cache = data;
    this.base = {};
    Object.keys(data).forEach(k => { this.base[k] = JSON.stringify(data[k]); });
  },

  async hydrate(){
    let data;
    try{
      // Generous: the server's first MongoDB Atlas connect (DNS + TLS) can take several seconds.
      const res = await fetch(`${API_BASE}/kv`, { signal: AbortSignal.timeout(20000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      data = await res.json();
      this.serverOnline = true;
    }catch(e){
      console.error('Storage.hydrate: API unreachable, falling back to localStorage', e);
      this.serverOnline = false;
      this.offlineBoot = true;
      this.cache = {};
      Object.values(STORAGE_KEYS).forEach(key => {
        try{
          const raw = localStorage.getItem(key);
          if (raw) this.cache[key] = JSON.parse(raw);
        }catch(err){ console.error('Storage.hydrate: bad localStorage value', key, err); }
      });
      Toast.show('Server database tidak terhubung — memakai data lokal (offline). Perubahan TIDAK dikirim ke server; muat ulang saat server kembali.', 'error');
      return;
    }
    this.adopt(data);
    const pending = this.unsynced();
    if (!pending.length) return;
    pending.forEach(key => {
      try{
        const raw = localStorage.getItem(key);
        // Unknown ancestor (saved in an earlier session): keep everything the server
        // has and lay this browser's added/edited rows on top. Never re-send the old
        // copy whole — that is exactly how other people's changes got wiped.
        if (raw) this.cache[key] = KvMerge.merge(undefined, JSON.parse(raw), this.cache[key]) ?? this.cache[key];
      }catch(err){ console.error('Storage.hydrate: bad unsynced value', key, err); }
    });
    const sent = (await Promise.all(pending.map(key => this.push(key)))).filter(Boolean).length;
    if (sent) Toast.show(`${sent} perubahan yang belum tersimpan sudah dikirim ke server.`, 'success');
  },

  /* Re-read every key from the server (another user / tab may have changed it).
     Skipped while a local change is still unsynced, so it can't be overwritten. */
  async refresh(){
    if (this.offlineBoot || this.hasUnsynced()) return false;
    try{
      const res = await fetch(`${API_BASE}/kv`, { signal: AbortSignal.timeout(10000) });
      if (!res.ok) return false;
      const data = await res.json();
      if (this.hasUnsynced()) return false; // a save started while we were waiting
      this.adopt(data);
      return true;
    }catch(e){ return false; }
  },

  get(key, fallback){
    const value = this.cache[key];
    return value === undefined || value === null ? fallback : value;
  },

  set(key, value){
    this.cache[key] = value;
    try{ localStorage.setItem(key, JSON.stringify(value)); }catch(e){ console.error('Storage.set: localStorage write failed', key, e); }
    if (this.offlineBoot) return Promise.resolve(false); // local only — see offlineBoot
    this.markUnsynced(key, true);
    return this.push(key);
  },

  /* PUT the cached value; resolves true once the server confirmed it (2xx).
     Queued per key, so each PUT is based on the rev the previous one returned. */
  push(key){
    const mySeq = this.seq[key] = (this.seq[key] || 0) + 1;
    this.inflight++;
    const run = () => this.sendWithMerge(key, mySeq);
    const p = (this.chain[key] || Promise.resolve()).then(run, run);
    this.chain[key] = p;
    return p.finally(() => { this.inflight--; });
  },

  async sendWithMerge(key, mySeq){
    for (let attempt = 0; attempt < 3; attempt++){
      let res, sent;
      try{
        sent = JSON.stringify(this.cache[key]);
        res = await fetch(`${API_BASE}/kv/${key}`, {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            'x-role': Auth.role() || '',
            'x-workspace': Auth.currentWorkspaceId() || '',
            'x-can-share': Auth.can('testcase_fileShare') ? '1' : '0'
          },
          body: `{"value":${sent},"rev":${this.revs[key] || 0}}`
        });
      }catch(e){
        if (this.serverOnline) Toast.show('Server tidak terhubung — perubahan disimpan di browser dan dikirim ulang saat aplikasi dibuka lagi.', 'error');
        this.serverOnline = false;
        console.error('Storage.push: server sync failed, kept as unsynced', key, e);
        return false;
      }
      this.serverOnline = true;
      const body = await res.json().catch(() => ({}));
      if (res.ok){
        this.revs[key] = body.rev;
        this.base[key] = sent;
        if (this.seq[key] === mySeq) this.markUnsynced(key, false);
        return true;
      }
      if (res.status === 409 && body.stale && attempt < 2 && await this.mergeFromServer(key)) continue;
      if (res.status >= 400 && res.status < 500){
        // Rejected (no permission / stale and unmergeable) — retrying as-is won't help.
        if (this.seq[key] === mySeq) this.markUnsynced(key, false);
        Toast.show(`Gagal menyimpan: ${body.error || `ditolak server (HTTP ${res.status})`}`, 'error');
        return false;
      }
      console.error('Storage.push: server error, kept as unsynced', key, res.status);
      Toast.show('Server error — perubahan disimpan di browser dan dikirim ulang saat aplikasi dibuka lagi.', 'error');
      return false;
    }
    return false;
  },

  // Someone saved this key first: fold their version into ours, then the caller re-sends.
  async mergeFromServer(key){
    try{
      const res = await fetch(`${API_BASE}/kv/${key}`);
      if (!res.ok) return false;
      const { value, rev } = await res.json();
      const base = this.base[key] === undefined ? undefined : JSON.parse(this.base[key]);
      const merged = KvMerge.merge(base, this.cache[key], value);
      if (merged === null) return false;
      this.cache[key] = merged;
      this.revs[key] = rev;
      this.base[key] = JSON.stringify(value);
      try{ localStorage.setItem(key, JSON.stringify(merged)); }catch(e){}
      if (this.onMerged) this.onMerged(key);
      return true;
    }catch(e){ return false; }
  }
};

/* 3-way merge for a whole-value KV write. base = common ancestor (undefined when
   unknown), mine = this tab's value, theirs = the newer server value.
   - Arrays of {id}: per row. A row only I changed takes mine, otherwise theirs;
     my new rows are appended; a row deleted on one side stays deleted unless the
     other side edited it. Same row edited on both sides: mine.
   - Plain objects (settings): per top-level key, same rule.
   Returns null when the values can't be merged (other shapes). */
const KvMerge = {
  merge(base, mine, theirs){
    if (theirs === undefined || theirs === null) return mine;
    if (Array.isArray(mine) && Array.isArray(theirs)) return this.rows(Array.isArray(base) ? base : [], mine, theirs);
    const isObj = v => v && typeof v === 'object' && !Array.isArray(v);
    if (isObj(mine) && isObj(theirs)){
      const b = isObj(base) ? base : {};
      const out = { ...theirs };
      Object.keys(mine).forEach(k => {
        if (JSON.stringify(mine[k]) !== JSON.stringify(b[k]) || !(k in theirs)) out[k] = mine[k];
      });
      return out;
    }
    return null;
  },
  rows(base, mine, theirs){
    if (![...mine, ...theirs].every(r => r && r.id != null)) return null;
    const B = new Map(base.map(r => [r.id, JSON.stringify(r)]));
    const M = new Map(mine.map(r => [r.id, r]));
    const T = new Set(theirs.map(r => r.id));
    const out = [];
    theirs.forEach(t => {
      const m = M.get(t.id);
      if (!m){
        // Not in mine: I deleted it (dropped unless they edited it since), or it's their new row.
        if (B.has(t.id) && B.get(t.id) === JSON.stringify(t)) return;
        out.push(t);
        return;
      }
      out.push(B.get(t.id) !== JSON.stringify(m) ? m : t);
    });
    // My new rows. A row they deleted stays deleted unless I edited it.
    mine.forEach(m => { if (!T.has(m.id) && (!B.has(m.id) || B.get(m.id) !== JSON.stringify(m))) out.push(m); });
    return out;
  }
};

// Leaving (Back / close tab) while a save hasn't reached the server: let the browser ask first.
if (typeof window !== 'undefined') window.addEventListener('beforeunload', e => {
  if (Storage.leaving || !Storage.hasUnsynced()) return;
  e.preventDefault();
  e.returnValue = '';
});


/* ---------- Auto-increment ID generator (TC-0001 / BUG-0001) ---------- */
/* "Tampilkan 10/25/50/100" next to a list's pagination. The module needs
   ui.page / ui.pageSize and a render() — same shape Test Case, Bug Report
   and Activity Log already use. */
function bindPageSize(selectId, module){
  const el = document.getElementById(selectId);
  if (!el) return;
  el.value = String(module.ui.pageSize);
  el.addEventListener('change', () => {
    module.ui.pageSize = Number(el.value);
    module.ui.page = 1;
    module.render();
  });
}

/* Bugs carry two ids: `id` = internal unique key (lookups, delete, selection —
   never shown) and `code` = the BUG-0001 number people see, counted per
   workspace, so two workspaces may both have BUG-0001 without colliding. */
function bugCode(b){ return (b && (b.code || b.id)) || ''; }
/* Bug report form options + rules (ISO/IEC/IEEE 29119-3 / ISTQB defect report).
   Pure — see qa-app/test/bugform.check.js. */
const BUG_FORM = {
  PLATFORMS: ['Web', 'Mobile App', 'Desktop', 'API'],
  ENVIRONMENTS: ['Local', 'Development', 'Staging', 'UAT', 'Production'],
  PRIORITIES: ['Urgent', 'High', 'Medium', 'Low'],
  // Browser only matters on Web, Device only on Mobile App.
  conditionalFields(platform){ return { browser: platform === 'Web', device: platform === 'Mobile App' }; },
  /* d: form values as plain text. full = create (every required field);
     edit keeps the old minimum so legacy bugs can still be saved.
     Returns { fieldName: message } — empty when valid. */
  errors(d, full = true){
    const e = {};
    const len = v => String(v || '').trim().length;
    const title = len(d.title);
    if (title < 5 || title > 150) e.title = 'Bug Title wajib diisi, 5–150 karakter.';
    if (len(d.actualResult) < 5) e.actualResult = 'Actual Result wajib diisi, minimal 5 karakter.';
    if (len(d.description) > 2000) e.description = 'Maksimal 2000 karakter.';
    const bad = String(d.attachments || '').split('\n').map(s => s.trim()).filter(Boolean).find(l => {
      try{ return !/^https?:$/.test(new URL(l).protocol); }catch(err){ return true; }
    });
    if (bad) e.attachments = `Bukan URL http/https yang valid: ${bad.slice(0, 80)}`;
    if (!full) return e;
    if (!len(d.module)) e.module = 'Module wajib diisi.';
    if (len(d.steps) < 10) e.steps = 'Steps to Reproduce wajib diisi, minimal 10 karakter.';
    if (len(d.expectedResult) < 5) e.expectedResult = 'Expected Result wajib diisi, minimal 5 karakter.';
    if (!len(d.severity)) e.severity = 'Pilih Severity.';
    // Environment section (environment, build, platform, OS, browser, device) is optional.
    return e;
  },
  /* Open bugs whose title looks like `title`: word overlap ≥ 60% of the shorter
     title (words of 3+ letters), or one title contains the other. */
  similar(title, bugs, closedStatuses = ['Closed']){
    const words = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length >= 3));
    const norm = s => String(s || '').trim().toLowerCase();
    const t = norm(title), tw = words(title);
    if (t.length < 5) return [];
    return bugs.filter(b => !closedStatuses.includes(b.status)).filter(b => {
      const o = norm(b.title);
      if (!o) return false;
      if (o.includes(t) || t.includes(o)) return true;
      const ow = words(b.title), min = Math.min(tw.size, ow.size);
      return min > 0 && [...tw].filter(w => ow.has(w)).length / min >= 0.6;
    });
  }
};
// Legacy priority values (form used "Critical", dashboard "Highest") read as the current top level.
/* Test case import. Headers are compared lowercase, letters/digits only, so
   "Pre-Kondisi", "pre kondisi *" and "PreKondisi" all match an alias. */
const TC_IMPORT = {
  ALIASES: {
    module: ['module', 'modul', 'fitur', 'feature', 'menu'],
    roleUser: ['roleuser', 'role', 'userrole', 'aktor', 'actor'],
    scenario: ['scenario', 'skenario', 'testscenario', 'scenarioname', 'judul', 'title'],
    testCase: ['testcase', 'testcasename', 'testcasedescription', 'deskripsi', 'description', 'kasusuji'],
    preconditions: ['prekondisi', 'precondition', 'preconditions', 'prasyarat', 'kondisiawal'],
    steps: ['teststep', 'teststeps', 'step', 'steps', 'langkah', 'langkahlangkah', 'langkahpengujian'],
    testData: ['testdata', 'data', 'datauji'],
    expectedResult: ['expectedresult', 'expectedresults', 'expected', 'hasilyangdiharapkan', 'hasildiharapkan', 'ekspektasi'],
    typeTest: ['typetest', 'testtype', 'type', 'tipe', 'tipetest', 'jenistest'],
    evidence: ['evidence', 'bukti'],
    status: ['status', 'statustest', 'statuseksekusi'],
    actualResult: ['actualresult', 'actual', 'hasilaktual'],
    // Known columns that are never imported (ids are renumbered, date set on Run).
    _skip: ['testcaseid', 'id', 'no', 'executiondate']
  },
  field(header){
    const n = String(header).toLowerCase().replace(/[^a-z0-9]/g, '');
    return Object.keys(this.ALIASES).find(k => this.ALIASES[k].includes(n)) || null;
  },
  /* rawRows: XLSX sheet_to_json(..., { defval: '' }) output. Returns
     { rows: [test case fields], errors: ['Sheet "x" baris n: ...'], unknown: [header] }. */
  parseSheet(sheetName, rawRows, sheetModule, typeTests, statuses = []){
    const headers = rawRows.length ? Object.keys(rawRows[0]) : [];
    const map = {}, unknown = [], errors = [], rows = [];
    headers.forEach(h => {
      const f = this.field(h);
      if (!f){ if (!/^__EMPTY/.test(h)) unknown.push(h); }
      else if (f !== '_skip' && !map[f]) map[f] = h;
    });
    if (!rawRows.length) return { rows, errors, unknown };
    // Bug Report template (has "Bug Title *") shares Module / Scenario columns — refuse it outright.
    if (headers.some(h => /^bugtitle$/.test(String(h).toLowerCase().replace(/[^a-z0-9]/g, '')))){
      errors.push(`${sheetName}: ini template Bug Report, bukan Test Case`);
      return { rows, errors, unknown };
    }
    if (!map.scenario){
      errors.push(`${sheetName}: kolom Scenario tidak ada`);
      return { rows, errors, unknown };
    }
    const byProblem = {}; // problem -> sheet rows, so one line per problem
    rawRows.forEach((raw, i) => {
      if (!Object.values(raw).some(v => String(v).trim())) return; // blank row
      const tc = {};
      Object.keys(map).forEach(k => { tc[k] = String(raw[map[k]] ?? '').trim(); });
      tc.module = tc.module || sheetModule;
      const problems = [];
      if (!tc.module) problems.push('Module kosong');
      if (!tc.scenario) problems.push('Scenario kosong');
      if (tc.typeTest){
        const t = typeTests.find(x => x.toLowerCase() === tc.typeTest.toLowerCase());
        if (t) tc.typeTest = t; else problems.push(`Type Test harus ${typeTests.join('/')}`);
      }
      if (tc.status){
        const v = tc.status.toLowerCase() === 'not run' ? 'open' : tc.status.toLowerCase(); // old exports
        const st = statuses.find(x => x.toLowerCase() === v);
        if (st) tc.status = st; else problems.push(`Status harus ${statuses.join('/')}`);
      }
      // __rowNum__ is SheetJS's 0-based sheet row (survives skipped blank rows).
      problems.forEach(p => (byProblem[p] = byProblem[p] || []).push((raw.__rowNum__ ?? i + 1) + 1));
      if (!problems.length) rows.push(tc);
    });
    Object.entries(byProblem).forEach(([p, nums]) => {
      errors.push(`${sheetName} baris ${nums.slice(0, 5).join(', ')}${nums.length > 5 ? ` (+${nums.length - 5})` : ''}: ${p}`);
    });
    return { rows, errors, unknown };
  }
};

function normPriority(p){ return p === 'Highest' || p === 'Critical' ? 'Urgent' : p; }

/* Bug status rules, by status code (Master Status). Dev flow Open / In Progress /
   Retest moves freely without a note. QA (permission bugreport_statusQA) may only
   take a bug out of Retest — to Open/Blocked/Resolved/Closed — always with a note.
   Any other move needs a note. Returns { ok, needNote }. */
function statusTransitionRule(from, to, isQA){
  const DEV_FLOW = ['OPEN', 'IN_PROGRESS', 'RETEST'], QA_TARGETS = ['OPEN', 'BLOCKED', 'RESOLVED', 'CLOSED'];
  if (isQA) return { ok: from === 'RETEST' && QA_TARGETS.includes(to), needNote: true };
  return { ok: true, needNote: !(DEV_FLOW.includes(from) && DEV_FLOW.includes(to)) };
}
// Same split for test cases: `id` = internal key, `code` = LOG-0001 shown, numbered per workspace + module prefix.
/* List sorting: the "id" column sorts by the number people see (not the random
   internal key), and numbers compare naturally so LOG-0002 < LOG-0010. */
function compareRows(a, b, sortKey, sortDir, codeOf){
  const val = r => (sortKey === 'id' ? codeOf(r) : r[sortKey]) ?? '';
  const cmp = String(val(a)).localeCompare(String(val(b)), 'id', { numeric: true, sensitivity: 'base' });
  return sortDir === 'asc' ? cmp : -cmp;
}
function tcCode(t){ return (t && (t.code || t.id)) || ''; }
// Workspace a file belongs to — the scope for per-workspace numbering (null = shared file).
function fileWorkspace(fileId){ const f = (App.state.files || []).find(x => x.id === fileId); return (f && f.workspaceId) || null; }

const IdGen = {
  /* Next display number in a workspace = highest number still in use there + 1.
     Computed from live data (no stored counter), so deleting test cases / bugs
     frees their numbers: delete all -> back to 0001. Gaps in the middle stay
     (nothing is renumbered — people refer to these numbers). */
  nextInScope(prefix, codesInScope){
    const re = new RegExp(`^${prefix}-(\\d+)$`);
    const max = (codesInScope || []).reduce((m, c) => {
      const hit = String(c).match(re);
      return hit ? Math.max(m, parseInt(hit[1], 10)) : m;
    }, 0);
    return `${prefix}-${String(max + 1).padStart(4, '0')}`;
  },
  uid(prefix){ return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`; },
  next(prefix){
    const counters = Storage.get(STORAGE_KEYS.COUNTERS, {});
    const current = (counters[prefix] || 0) + 1;
    counters[prefix] = current;
    Storage.set(STORAGE_KEYS.COUNTERS, counters);
    return `${prefix}-${String(current).padStart(4, '0')}`;
  },
  // Keeps counters in sync with imported data so new IDs never collide.
  syncFromExisting(prefix, existingIds){
    const counters = Storage.get(STORAGE_KEYS.COUNTERS, {});
    let max = counters[prefix] || 0;
    existingIds.forEach(id => {
      const m = String(id).match(new RegExp(`^${prefix}-(\\d+)$`));
      if (m) max = Math.max(max, parseInt(m[1], 10));
    });
    counters[prefix] = max;
    Storage.set(STORAGE_KEYS.COUNTERS, counters);
  },
  // Test Case IDs use a per-module prefix (e.g. LOG-0001), so sync each
  // distinct prefix found in existing IDs instead of one fixed prefix.
  syncAllFromExisting(existingIds){
    const byPrefix = {};
    existingIds.forEach(id => {
      const m = String(id).match(/^([A-Z]+)-(\d+)$/);
      if (!m) return;
      (byPrefix[m[1]] ||= []).push(id);
    });
    Object.keys(byPrefix).forEach(prefix => this.syncFromExisting(prefix, byPrefix[prefix]));
  }
};

/* Abbreviates a Module name into a 3-letter Test Case ID prefix.
   "Login" -> "LOG", "User Management" -> initials "UM" + extra letters -> "UMS". */
function moduleAbbrev(module){
  const words = String(module || '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return 'TC';
  const initials = words.map(w => w[0].toUpperCase());
  if (initials.length >= 3) return initials.slice(0, 3).join('');
  const extra = words.flatMap(w => w.slice(1).toUpperCase().split(''));
  return initials.concat(extra).slice(0, 3).join('').padEnd(3, 'X');
}

/* ---------- Toast notifications ---------- */
const Toast = {
  container(){
    let el = document.getElementById('toastStack');
    if(!el){
      el = document.createElement('div');
      el.id = 'toastStack';
      el.className = 'toast-stack';
      document.body.appendChild(el);
    }
    return el;
  },
  show(message, type = 'info', opts = {}){
    const stack = this.container();
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    const icon = { success:'✓', error:'⚠', info:'ℹ' }[type] || 'ℹ';
    toast.innerHTML = `<span>${icon}</span><span>${escapeHtml(message)}</span>`;
    if(opts.undo){
      const undoBtn = document.createElement('span');
      undoBtn.className = 'undo';
      undoBtn.textContent = 'UNDO';
      undoBtn.onclick = () => { opts.undo(); toast.remove(); };
      toast.appendChild(undoBtn);
    }
    stack.appendChild(toast);
    setTimeout(() => {
      toast.style.transition = 'opacity .25s';
      toast.style.opacity = '0';
      setTimeout(() => toast.remove(), 250);
    }, opts.duration || 4000);
  }
};

/* Close a dialog on backdrop click — but only when the click actually
   started AND ended on the backdrop. A plain `click` listener alone closes
   the modal if the user drags to select text inside it and the drag ends
   up releasing the mouse outside (over the backdrop), silently discarding
   whatever they'd typed. */
function bindBackdropClose(overlay, onClose){
  let downOnBackdrop = false;
  overlay.addEventListener('mousedown', e => { downOnBackdrop = e.target === overlay; });
  overlay.addEventListener('click', e => { if (downOnBackdrop && e.target === overlay) onClose(); });
}

// Read-only notice with a bullet list (e.g. import errors). Closes via ✕ or backdrop.
function listDialog(title, items, message = ''){
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay confirm-modal active';
  overlay.innerHTML = `
    <div class="modal">
      <button class="close-x" style="float:right;">✕</button>
      <div class="icon-warn">!</div>
      <h2 style="margin:0 0 6px;">${escapeHtml(title)}</h2>
      <ul class="confirm-list">${items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>
      ${message ? `<p class="text-dim" style="font-size:13px;">${escapeHtml(message)}</p>` : ''}
    </div>`;
  document.body.appendChild(overlay);
  overlay.querySelector('.close-x').onclick = () => overlay.remove();
  bindBackdropClose(overlay, () => overlay.remove());
}

/* ---------- Confirm dialog (returns a Promise<boolean>) ---------- */
function confirmDialog(title, message, confirmLabel = 'Hapus'){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal active';
    overlay.innerHTML = `
      <div class="modal">
        <div class="icon-warn">!</div>
        <h2 style="margin:0 0 6px;">${escapeHtml(title)}</h2>
        <p class="text-dim" style="font-size:13px;">${escapeHtml(message)}</p>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelConfirm">Batal</button>
          <button class="btn danger" id="okConfirm">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#cancelConfirm').onclick = () => { overlay.remove(); resolve(false); };
    overlay.querySelector('#okConfirm').onclick = () => { overlay.remove(); resolve(true); };
    bindBackdropClose(overlay, () => { overlay.remove(); resolve(false); });
  });
}

/* ---------- Prompt dialog (returns a Promise<string|null>) ----------
   Optional `validate(value)` returns an error string to block closing and
   show it inline under the input, or falsy to accept. */
function promptDialog(title, placeholder = '', defaultValue = '', confirmLabel = 'Simpan', validate = null){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal active';
    overlay.innerHTML = `
      <div class="modal">
        <h2 style="margin:0 0 14px;">${escapeHtml(title)}</h2>
        <div class="field">
          <input type="text" id="promptDialogInput" placeholder="${escapeHtml(placeholder)}" value="${escapeHtml(defaultValue)}">
          <p class="combobox-error" id="promptDialogError" style="display:none;"></p>
        </div>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelPrompt">Batal</button>
          <button class="btn primary" id="okPrompt">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const input = overlay.querySelector('#promptDialogInput');
    const errorEl = overlay.querySelector('#promptDialogError');
    input.focus(); input.select();
    const close = (value) => { overlay.remove(); resolve(value); };
    const showError = (msg) => {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
      input.classList.add('input-invalid');
    };
    const submit = () => {
      const value = input.value.trim() || null;
      if (value && validate){
        const err = validate(value);
        if (err){ showError(err); return; }
      }
      close(value);
    };
    input.addEventListener('input', () => { errorEl.style.display = 'none'; input.classList.remove('input-invalid'); });
    overlay.querySelector('#cancelPrompt').onclick = () => close(null);
    overlay.querySelector('#okPrompt').onclick = submit;
    input.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); submit(); } });
    bindBackdropClose(overlay, () => close(null));
  });
}

/* ---------- New-file dialog for Admin (name + target workspace) ----------
   workspaces: [{ id, name }]. Returns Promise<{name, workspaceId}|null>. */
function fileCreateDialog(workspaces){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal active';
    overlay.innerHTML = `
      <div class="modal" style="text-align:left;">
        <h2 style="margin:0 0 14px;">File Baru</h2>
        <div class="field">
          <label>Nama File</label>
          <input type="text" id="fileCreateName" placeholder="misal: Sprint 12">
          <p class="combobox-error" id="fileCreateError" style="display:none;"></p>
        </div>
        <div class="field">
          <label>Workspace</label>
          <select id="fileCreateWorkspace">
            <option value="">(Semua / Shared)</option>
            ${workspaces.map(w => `<option value="${escapeHtml(w.id)}">${escapeHtml(w.name)}</option>`).join('')}
          </select>
        </div>
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelFileCreate">Batal</button>
          <button class="btn primary" id="okFileCreate">Buat File</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector('#fileCreateName');
    const wsSelect = overlay.querySelector('#fileCreateWorkspace');
    const errorEl = overlay.querySelector('#fileCreateError');
    nameInput.focus();
    const close = (value) => { overlay.remove(); resolve(value); };
    const submit = () => {
      const name = nameInput.value.trim();
      if (!name){ errorEl.textContent = 'Nama file wajib diisi.'; errorEl.style.display = 'block'; nameInput.classList.add('input-invalid'); return; }
      close({ name, workspaceId: wsSelect.value || null });
    };
    nameInput.addEventListener('input', () => { errorEl.style.display = 'none'; nameInput.classList.remove('input-invalid'); });
    nameInput.addEventListener('keydown', e => { if (e.key === 'Enter'){ e.preventDefault(); submit(); } });
    overlay.querySelector('#cancelFileCreate').onclick = () => close(null);
    overlay.querySelector('#okFileCreate').onclick = submit;
    bindBackdropClose(overlay, () => close(null));
  });
}

/* ---------- File edit dialog: rename + share in one modal ----------
   Returns Promise<{name, sharedWith}|null>. The sharing section is only
   rendered when `canShare` is true — otherwise sharedWith passes through
   unchanged (rename-only, e.g. a workspace member editing their own file
   without share permission, or a legacy/shared file with no single owner). */
function fileEditDialog(file, canShare, workspaces){
  return new Promise(resolve => {
    const shared = new Set(file.sharedWith || []);
    const others = canShare ? workspaces.filter(w => w.id !== file.workspaceId) : [];
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal active';
    overlay.innerHTML = `
      <div class="modal" style="text-align:left; max-width:380px;">
        <h2 style="margin:0 0 14px;">Edit File</h2>
        <div class="field">
          <label>Nama File</label>
          <input type="text" id="fileEditName" value="${escapeHtml(file.name)}">
          <p class="combobox-error" id="fileEditError" style="display:none;"></p>
        </div>
        ${canShare ? `
        <div class="field" style="margin-bottom:0;">
          <label>Share ke Workspace</label>
          <div class="checklist-dialog-list" style="margin-bottom:0;">
            ${others.length ? others.map(w => `
              <label class="checklist-dialog-item">
                <input type="checkbox" class="checkbox" data-share-id="${escapeHtml(w.id)}" ${shared.has(w.id) ? 'checked' : ''}>
                <span>${escapeHtml(w.name)}</span>
              </label>`).join('') : `<p class="text-faint" style="font-size:13px; padding:8px 0; margin:0;">Belum ada workspace lain.</p>`}
          </div>
        </div>` : ''}
        <div class="modal-footer" style="justify-content:center;">
          <button class="btn" id="cancelFileEdit">Batal</button>
          <button class="btn primary" id="okFileEdit">Simpan</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const nameInput = overlay.querySelector('#fileEditName');
    const errorEl = overlay.querySelector('#fileEditError');
    nameInput.focus(); nameInput.select();
    const close = (value) => { overlay.remove(); resolve(value); };
    nameInput.addEventListener('input', () => { errorEl.style.display = 'none'; nameInput.classList.remove('input-invalid'); });
    overlay.querySelector('#cancelFileEdit').onclick = () => close(null);
    overlay.querySelector('#okFileEdit').onclick = () => {
      const name = nameInput.value.trim();
      if (!name){ errorEl.textContent = 'Nama file wajib diisi.'; errorEl.style.display = 'block'; nameInput.classList.add('input-invalid'); return; }
      const sharedWith = canShare
        ? [...overlay.querySelectorAll('[data-share-id]:checked')].map(el => el.dataset.shareId)
        : (file.sharedWith || []);
      close({ name, sharedWith });
    };
    bindBackdropClose(overlay, () => close(null));
  });
}

/* ---------- Checklist dialog (returns a Promise<string[]|null>) ----------
   options: [{ id, label, checked }] */
function checklistDialog(title, options, confirmLabel = 'Simpan'){
  return new Promise(resolve => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay checklist-modal active';
    overlay.innerHTML = `
      <div class="modal">
        <h2 style="margin:0 0 14px;">${escapeHtml(title)}</h2>
        <div class="checklist-dialog-list">
          ${options.length ? options.map(o => `
            <label class="checklist-dialog-item">
              <input type="checkbox" class="checkbox" data-share-id="${escapeHtml(o.id)}" ${o.checked ? 'checked' : ''}>
              <span>${escapeHtml(o.label)}</span>
            </label>`).join('') : `<p class="text-faint" style="font-size:13px; padding:8px 0;">Belum ada workspace lain.</p>`}
        </div>
        <div class="modal-footer">
          <button class="btn" id="cancelChecklist">Batal</button>
          <button class="btn primary" id="okChecklist">${escapeHtml(confirmLabel)}</button>
        </div>
      </div>`;
    document.body.appendChild(overlay);
    const close = (value) => { overlay.remove(); resolve(value); };
    overlay.querySelector('#cancelChecklist').onclick = () => close(null);
    overlay.querySelector('#okChecklist').onclick = () => {
      const ids = [...overlay.querySelectorAll('[data-share-id]:checked')].map(el => el.dataset.shareId);
      close(ids);
    };
    bindBackdropClose(overlay, () => close(null));
  });
}

/* ---------- Small helpers ---------- */
function escapeHtml(str){
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

/* Escape then turn http(s) URLs into clickable links (opens in a new tab). */
function linkify(str){
  return escapeHtml(str).replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
}

/* Dev team quality metric: how fast bugs go from reported (Open) to Closed,
   based on the status-change activity log recorded in bugreport.js. Only
   bugs currently Closed with a logged "-> Closed" transition count — bugs
   without activity (imported/seeded data) can't be measured and are skipped. */
function computeBugResolutionStats(bugs){
  const durations = [];
  (bugs || []).forEach(b => {
    if (b.status !== 'Closed' || !b.reportDate) return;
    const closedEntries = (b.activity || []).filter(a => a.to === 'Closed');
    if (!closedEntries.length) return;
    const ms = new Date(closedEntries[closedEntries.length - 1].at) - new Date(b.reportDate);
    if (ms > 0) durations.push(ms);
  });
  const avgHours = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length) / 3600000 : 0;
  return { resolvedCount: durations.length, avgHours };
}

function formatDuration(hours){
  if (!hours) return '-';
  if (hours < 24) return `${hours.toFixed(1)} jam`;
  return `${(hours / 24).toFixed(1)} hari`;
}

/* Turns a plain-text "Test Step" cell from an imported Excel/CSV file into the
   HTML the Steps rich-text editor (Quill) expects. If most lines already start
   with a number ("1.", "2)", ...), it becomes a real <ol> so imported steps
   show up numbered without the user having to reformat them by hand. */
function textToStepsHtml(raw){
  const text = String(raw ?? '').trim();
  if (!text) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) return text; // already HTML (e.g. re-imported export)
  const lines = text.split(/\r\n|\r|\n/).map(l => l.trim()).filter(Boolean);
  if (!lines.length) return '';
  const numberedRe = /^\d+[.\)]\s*/;
  const numberedCount = lines.filter(l => numberedRe.test(l)).length;
  if (numberedCount >= Math.ceil(lines.length * 0.6)){
    return '<ol>' + lines.map(l => `<li>${escapeHtml(l.replace(numberedRe, ''))}</li>`).join('') + '</ol>';
  }
  return lines.map(l => `<p>${escapeHtml(l)}</p>`).join('');
}

/* Steps HTML is shown as HTML, and textToStepsHtml passes text that already looks
   like HTML straight through — so render it through an allowlist: only list /
   paragraph / basic formatting tags survive, and every attribute except Quill's
   list/indent markers is dropped (no on*=, href=javascript:, style...). Anything
   else keeps just its text. */
function safeStepsHtml(html){
  const ALLOWED = new Set(['P', 'OL', 'UL', 'LI', 'BR', 'B', 'STRONG', 'I', 'EM', 'U']);
  const KEEP_ATTRS = new Set(['class', 'data-list']);
  const tpl = document.createElement('template');
  tpl.innerHTML = String(html || '');
  const clean = node => [...node.childNodes].forEach(child => {
    if (child.nodeType === 3) return;
    if (child.nodeType !== 1 || ['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'TEMPLATE'].includes(child.tagName)){ child.remove(); return; }
    clean(child);
    if (!ALLOWED.has(child.tagName)){ child.replaceWith(...child.childNodes); return; }
    [...child.attributes].forEach(a => { if (!KEEP_ATTRS.has(a.name)) child.removeAttribute(a.name); });
  });
  clean(tpl.content);
  return tpl.innerHTML;
}

function stripHtml(html){
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return d.textContent || '';
}

/* Reverse of textToStepsHtml — for export. Plain stripHtml() drops <ol>/<ul>
   numbering (textContent has no idea it was a list), so a numbered Steps
   field would export blank of numbers. Walk top-level <li>/<p>/<br> blocks
   and re-number them as plain text lines instead. */
function stepsHtmlToText(html){
  if (!html) return '';
  const d = document.createElement('div');
  d.innerHTML = html;
  const lists = d.querySelectorAll('ol, ul');
  lists.forEach(list => {
    const ordered = list.tagName === 'OL';
    [...list.children].forEach((li, i) => {
      li.textContent = `${ordered ? `${i + 1}. ` : '- '}${li.textContent}`;
    });
  });
  [...d.querySelectorAll('p, li, br')].forEach(el => el.after(document.createTextNode('\n')));
  return (d.textContent || '').replace(/\n{2,}/g, '\n').trim();
}

/* Heuristic ID/EN detection via common stopword counting — good enough to
   pick a translate direction without a paid language-detection API. */
const ID_STOPWORDS = ['yang','dan','atau','tidak','untuk','dengan','adalah','ini','itu','pada','akan','dari','ke','di','sudah','belum','harus','bisa','dapat','maka'];
const EN_STOPWORDS = ['the','and','or','not','for','with','is','are','this','that','on','will','from','to','in','already','must','can','should','then'];
function detectLang(text){
  const words = String(text || '').toLowerCase().split(/\W+/).filter(Boolean);
  let idScore = 0, enScore = 0;
  words.forEach(w => { if (ID_STOPWORDS.includes(w)) idScore++; if (EN_STOPWORDS.includes(w)) enScore++; });
  return enScore > idScore ? 'en' : 'id';
}

/* Row action kebab menu: wraps a list of `<button data-...>` action items
   (rendered exactly as before) behind a single "⋮" toggle so dense action
   columns (Bug Report, Master Status, User Management, Role Permission,
   Workspace) don't show every action inline. */
function actionMenu(itemsHtml){
  return `<div class="action-menu">
    <button type="button" class="action-menu-btn" title="Aksi">⋮</button>
    <div class="action-menu-list">${itemsHtml}</div>
  </div>`;
}

function positionActionMenu(menu){
  const btn = menu.querySelector('.action-menu-btn');
  const list = menu.querySelector('.action-menu-list');
  const r = btn.getBoundingClientRect();
  list.style.top = `${r.bottom + 4}px`;
  list.style.left = 'auto';
  list.style.right = `${window.innerWidth - r.right}px`;
  const listRect = list.getBoundingClientRect();
  if (listRect.bottom > window.innerHeight){
    list.style.top = `${r.top - listRect.height - 4}px`;
  }
}

document.addEventListener('click', e => {
  const btn = e.target.closest('.action-menu-btn');
  document.querySelectorAll('.action-menu.open').forEach(m => {
    if (!btn || m !== btn.closest('.action-menu')) m.classList.remove('open');
  });
  if (btn){
    const menu = btn.closest('.action-menu');
    const wasOpen = menu.classList.contains('open');
    menu.classList.toggle('open');
    if (!wasOpen) positionActionMenu(menu);
  } else if (e.target.closest('.action-menu-list')) {
    document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
  }
});
window.addEventListener('scroll', () => {
  document.querySelectorAll('.action-menu.open').forEach(m => m.classList.remove('open'));
}, true);

async function translateText(text, langpair){
  const trimmed = String(text || '').trim();
  if (!trimmed) return '';
  const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(trimmed)}&langpair=${langpair}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error('Translate API error');
  const data = await res.json();
  return data?.responseData?.translatedText || trimmed;
}

function debounce(fn, wait = 250){
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), wait); };
}

function formatDate(iso){
  if(!iso) return '-';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleDateString('id-ID', { day:'2-digit', month:'short', year:'numeric' });
}

function formatDateTime(iso){
  if(!iso) return '-';
  const d = new Date(iso);
  if(isNaN(d)) return iso;
  return d.toLocaleString('id-ID', { day:'2-digit', month:'short', year:'numeric', hour:'2-digit', minute:'2-digit' });
}

function todayISO(){ return new Date().toISOString().slice(0,10); }

function nowISO(){ return new Date().toISOString(); }

function downloadBlob(content, filename, mime){
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

/* Convert an array of objects to CSV text (handles quoting/commas). */
function arrayToCSV(rows, columns){
  const header = columns.map(c => c.label).join(',');
  const lines = rows.map(row => columns.map(c => {
    let v = row[c.key];
    if (v === null || v === undefined) v = '';
    v = String(v).replace(/"/g,'""');
    return `"${v}"`;
  }).join(','));
  return [header, ...lines].join('\r\n');
}

/* Simple highlight for realtime search matches (used in a couple tables). */
function highlight(text, term){
  if(!term) return escapeHtml(text ?? '');
  const t = escapeHtml(String(text ?? ''));
  const safeTerm = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return t.replace(new RegExp(safeTerm, 'ig'), m => `<mark>${m}</mark>`);
}
