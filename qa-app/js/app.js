/* ==========================================================
   app.js — application bootstrap: state, routing, sidebar,
   theme switching, keyboard shortcuts.
   All other js/*.js files attach to the global `App` object
   so this stays a clean, dependency-free multi-file structure
   without a bundler.
   ========================================================== */

const App = {
  state: {
    testcases: [],
    bugs: [],
    files: [],
    activityLog: [],
    settings: { theme: 'light', customFieldDefs: [] },
    currentPage: 'dashboard'
  },

  /* ---- Data load / persist ---- */
  loadAll(){
    this.state.testcases = Storage.get(STORAGE_KEYS.TESTCASES, []);
    this.state.bugs = Storage.get(STORAGE_KEYS.BUGS, []);
    this.state.files = Storage.get(STORAGE_KEYS.FILES, []);
    this.state.activityLog = Storage.get(STORAGE_KEYS.ACTIVITY_LOG, []);
    this.state.settings = Storage.get(STORAGE_KEYS.SETTINGS, { theme: 'light', customFieldDefs: [] });
    this.state.testcases.forEach(t => { if (t.status === 'Not Run') t.status = 'Open'; });
    this.ensureRoles();
    this.ensureRolePermissions();
    if (!this.state.settings.workspaces) this.state.settings.workspaces = [];
    this.ensureDefaultFile();
  },
  /* Merge default permissions into settings so newly-added permission keys
     show up on the matrix, without clobbering an admin's saved overrides. */
  ensureRolePermissions(){
    if (!this.state.settings.rolePermissions) this.state.settings.rolePermissions = {};
    Auth.customRoles().forEach(r => {
      this.state.settings.rolePermissions[r.value] = { ...(Auth.DEFAULT_ROLE_PERMISSIONS[r.value] || {}), ...(this.state.settings.rolePermissions[r.value] || {}) };
    });
  },
  /* First load: seed settings.roles from the legacy hardcoded list so existing
     accounts keep working; from then on roles are managed entirely from the UI. */
  ensureRoles(){
    if (!this.state.settings.roles) this.state.settings.roles = Auth.DEFAULT_ROLES.slice();
  },
  /* Test cases created before file grouping existed (or imported without one)
     fall back into an auto-created "Default" file. */
  ensureDefaultFile(){
    const needsDefault = this.state.testcases.some(t => !t.fileId) || this.state.bugs.some(b => !b.fileId);
    if (!needsDefault) return;
    let def = this.state.files.find(f => f.id === 'FILE-DEFAULT');
    if (!def){
      def = { id: 'FILE-DEFAULT', name: 'Default', createdAt: nowISO() };
      this.state.files.unshift(def);
      this.saveFiles();
    }
    this.state.testcases.forEach(t => { if (!t.fileId) t.fileId = def.id; });
    this.state.bugs.forEach(b => { if (!b.fileId) b.fileId = def.id; });
    this.saveTestcases();
    this.saveBugs();
  },
  /* Test Case and Bug Report share one file list — deleting a file from
     either page removes its test cases AND its bugs, so nothing is left
     orphaned (invisible in the file list but still counted everywhere). */
  deleteFileCascade(fileId){
    this.state.files = this.state.files.filter(f => f.id !== fileId);
    this.state.testcases = this.state.testcases.filter(t => t.fileId !== fileId);
    this.state.bugs = this.state.bugs.filter(b => b.fileId !== fileId);
    this.saveFiles();
    this.saveTestcases();
    this.saveBugs();
  },
  saveTestcases(){ Storage.set(STORAGE_KEYS.TESTCASES, this.state.testcases); this.onDataChanged(); },
  saveBugs(){ const saved = Storage.set(STORAGE_KEYS.BUGS, this.state.bugs); this.onDataChanged(); return saved; },
  saveFiles(){ Storage.set(STORAGE_KEYS.FILES, this.state.files); },
  saveActivityLog(){ Storage.set(STORAGE_KEYS.ACTIVITY_LOG, this.state.activityLog); },
  saveSettings(){ Storage.set(STORAGE_KEYS.SETTINGS, this.state.settings); },

  /* Called after any mutation — keeps sidebar counts & any open
     dashboard/summary views in sync (simple pub/sub substitute). */
  onDataChanged(){
    this.renderSidebarCounts();
    NotificationCenter.renderBadge();
    if (this.state.currentPage === 'dashboard') Dashboard.render();
    if (this.state.currentPage === 'summary') Summary.render();
  },

  /* ---- Routing (simple show/hide, no history API needed offline) ---- */
  /* Every page switch is a browser-history entry, so Back/Forward move between
     BugRail pages instead of leaving the app (and losing an unsaved form). */
  goTo(page, { fromHistory = false, replace = false } = {}){
    if (!fromHistory){
      // The bug detail page keeps its #bug= link in the address bar (reload / share reopens it).
      // Report filters live in the query string (shareable) — only while on the Report page.
      const base = page === 'report' ? location.href.split('#')[0] : ReportModule.urlWith(location.href.split('#')[0], null);
      const url = base + (page === 'bugdetail' ? `#bug=${encodeURIComponent(BugReportModule.ui.detailId)}` : '');
      if (replace || !history.state) history.replaceState({ page }, '', url);
      else if (history.state.page !== page) history.pushState({ page }, '', url);
    }
    this.state.currentPage = page;
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.querySelectorAll('.nav-item, .nav-subitem').forEach(n => n.classList.remove('active'));
    const pageEl = document.getElementById(`page-${page}`);
    const navPage = page === 'bugdetail' ? 'bugreport' : page;
    const navEl = document.querySelector(`.nav-item[data-page="${navPage}"], .nav-subitem[data-page="${navPage}"]`);
    if (pageEl) pageEl.classList.add('active');
    if (navEl){
      navEl.classList.add('active');
      const group = navEl.closest('.nav-group');
      if (group) group.classList.add('open');
    }

    const fabWrap = document.getElementById('fabWrap');
    if (fabWrap){
      fabWrap.classList.remove('open');
      fabWrap.style.display = (page === 'dashboard' || page === 'summary') ? 'flex' : 'none';
    }

    const titles = {
      dashboard: ['Dashboard', 'Ringkasan status pengujian & bug secara realtime'],
      testcase: ['Test Case', 'Kelola skenario pengujian'],
      bugreport: ['Bug Report', 'Laporan bug terintegrasi dengan Test Case'],
      bugdetail: ['Bug Report', 'Detail bug'],
      summary: ['Summary', 'Rekap progres testing & bug'],
      report: ['Report', 'Analisa kesiapan go-live untuk PM & BA'],
      importexport: ['Import & Export', 'Import Test Case, export data, backup & restore'],
      usermanagement: ['User Management', 'Kelola akun login (Admin & User)'],
      rolepermission: ['Role Permission', 'Atur hak akses tiap role'],
      settings: ['Settings', 'Preferensi aplikasi & data'],
      masterstatus: ['Status Bug Report', 'Master data status bug report'],
      activitylog: ['Activity Log', 'Riwayat aktivitas user dari login sampai logout']
    };
    const [t, s] = titles[page] || [page, ''];
    document.getElementById('pageTitle').textContent = t;
    document.getElementById('pageSub').textContent = s;

    // Lazy render per page so tables always reflect the latest data.
    if (page === 'dashboard') Dashboard.render();
    if (page === 'testcase') TestCaseModule.render();
    if (page === 'bugreport') BugReportModule.render();
    if (page === 'bugdetail') BugReportModule.openDetail(BugReportModule.ui.detailId, true);
    if (page === 'summary') Summary.render();
    if (page === 'report') ReportModule.render();
    if (page === 'masterstatus') MasterStatusModule.render();
    if (page === 'activitylog') ActivityLogModule.render();

    document.getElementById('sidebar').classList.remove('open');
    if (!this._refreshing) this.refreshFromServer(page);
  },

  /* Menu change: pull other users' changes, then redraw the page.
     ponytail: one GET /api/kv (all data) per 15s at most; per-key fetch if that grows heavy. */
  async refreshFromServer(page){
    if (Date.now() - (this._lastRefresh || 0) < 15000) return;
    this._lastRefresh = Date.now();
    if (await Storage.refresh()) this.reloadFromStorage();
  },
  /* Storage's cache was replaced/merged with server data: App.state must follow at
     once — saving an old App.state with the new rev would wipe the newer rows. */
  reloadFromStorage(){
    this.loadAll();
    this.renderSidebarCounts();
    this._refreshing = true;
    this.goTo(this.state.currentPage, { fromHistory: true });
    this._refreshing = false;
  },

  /* Live push (server GET /api/events, SSE): another user saved a key -> pull just
     that key and redraw the current page, no reload needed. */
  startLive(){
    if (this._live || Storage.offlineBoot || typeof EventSource !== 'function') return;
    this._live = new EventSource(`${API_BASE}/events`);
    let dropped = false;
    this._live.onerror = () => { dropped = true; }; // the browser reconnects by itself
    this._live.onopen = () => { // back after a drop: catch up on whatever was missed
      if (!dropped) return;
      dropped = false;
      this._lastRefresh = 0;
      this.refreshFromServer();
    };
    this._live.onmessage = e => {
      const { key, rev } = JSON.parse(e.data);
      if (rev !== Storage.revs[key]) this.pullLive(key);
    };
  },
  async pullLive(key){
    await Storage.settle(); // my own save goes first; a clash is handled by its 409 merge
    if (!await Storage.refreshKey(key)) return; // nothing newer (e.g. it was my own save)
    this.loadAll(); // data is current right away; only the redraw may wait
    this.renderSidebarCounts();
    // Activity log / counters change on every action anywhere, but show on no page but the log.
    const shown = key !== 'qa_counters' && (key !== 'qa_activity_log' || this.state.currentPage === 'activitylog');
    if (shown) this.redrawWhenIdle();
  },
  /* Never redraw under someone who is typing (a form, the step editor, inline edit)
     or dragging a card: wait until they're done. The open bug popup's chat is the
     exception — new comments should land while you write yours. */
  isUserBusy(){
    if (document.querySelector('.dragging')) return true;
    if ([...document.querySelectorAll('.modal-overlay.active')].some(m => m.id !== 'bugDetailModalOverlay')) return true;
    const el = document.activeElement;
    // Focus stays on a clicked checkbox/select, so only real text entry counts.
    const typing = el && (el.isContentEditable || el.tagName === 'TEXTAREA'
      || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type)));
    return !!typing && el.id !== 'bugChatInput';
  },
  redrawWhenIdle(){
    clearTimeout(this._redrawTimer);
    if (this.isUserBusy()){ this._redrawTimer = setTimeout(() => this.redrawWhenIdle(), 1000); return; }
    this.reloadFromStorage();
    BugReportModule.refreshOpenDetail();
  },

  /* Hides sidebar entries the current role can't use. Role Permission stays
     admin-only always (managing roles/permissions is a superadmin action). */
  applyNavPermissions(){
    const setVisible = (page, visible) => {
      const el = document.querySelector(`.nav-item[data-page="${page}"], .nav-subitem[data-page="${page}"]`);
      if (el) el.style.display = visible ? '' : 'none';
    };
    setVisible('dashboard', Auth.can('dashboard'));
    setVisible('summary', Auth.can('summary'));
    setVisible('report', Auth.can('report'));
    setVisible('testcase', Auth.can('testcase_read'));
    setVisible('bugreport', Auth.can('bugreport_read'));
    setVisible('masterstatus', Auth.can('master'));
    setVisible('usermanagement', Auth.can('usermanagement'));
    setVisible('rolepermission', Auth.isAdmin());
    setVisible('workspace', Auth.isAdmin());
    setVisible('settings', Auth.can('settings'));
    setVisible('activitylog', Auth.can('activitylog'));
    const masterGroup = document.getElementById('navGroupMaster');
    if (masterGroup) masterGroup.style.display = Auth.can('master') ? '' : 'none';
    const userMgmtGroup = document.getElementById('navGroupUserManagement');
    if (userMgmtGroup) userMgmtGroup.style.display = (Auth.can('usermanagement') || Auth.isAdmin()) ? '' : 'none';
  },

  renderSidebarCounts(){
    const tcOpen = this.state.testcases.length;
    const bugOpen = this.state.bugs.filter(b => b.status !== 'Closed').length;
    const tcCountEl = document.querySelector('[data-count="testcase"]');
    const bugCountEl = document.querySelector('[data-count="bugreport"]');
    if (tcCountEl) tcCountEl.textContent = tcOpen;
    if (bugCountEl) bugCountEl.textContent = bugOpen;
  },

  /* Global search suggestions across Test Case + Bug Report (only what the
     role may read, same visibility rules as each module's list). */
  renderSearchResults(term){
    const el = document.getElementById('globalSearchResults');
    const q = term.toLowerCase();
    if (!q){ el.classList.remove('open'); el.innerHTML = ''; return; }
    const LIMIT = 6;
    const hit = (...fields) => fields.some(f => String(f || '').toLowerCase().includes(q));
    const tcs = Auth.can('testcase_read')
      ? TestCaseModule.all().filter(t => hit(tcCode(t), t.scenario, t.testCase, t.module)) : [];
    const bugs = Auth.can('bugreport_read')
      ? BugReportModule.all().filter(b => hit(bugCode(b), b.title, b.module, b.description)) : [];
    const group = (title, list, type, label) => list.length ? `
      <div class="gs-group">${title} <span>${list.length > LIMIT ? `${LIMIT} dari ${list.length}` : list.length}</span></div>
      ${list.slice(0, LIMIT).map(x => `
        <div class="gs-item" role="option" data-type="${type}" data-id="${escapeHtml(x.id)}">
          <span class="mono">${escapeHtml(type === 'bug' ? bugCode(x) : tcCode(x))}</span>
          <span class="gs-title">${escapeHtml(label(x))}</span>
          <span class="gs-meta">${escapeHtml(x.module || '')} · ${escapeHtml(x.status || '')}</span>
        </div>`).join('')}` : '';
    el.innerHTML = (group('Test Case', tcs, 'tc', t => t.scenario || t.testCase) + group('Bug Report', bugs, 'bug', b => b.title))
      || `<div class="gs-empty">Tidak ada hasil untuk "${escapeHtml(term)}"</div>`;
    el.classList.add('open');
  },

  /* ---- Theme ---- */
  applyTheme(){
    document.documentElement.setAttribute('data-theme', this.state.settings.theme);
    const label = document.getElementById('themeLabel');
    if (label) label.textContent = this.state.settings.theme === 'dark' ? 'Dark Mode' : 'Light Mode';
    const icon = document.getElementById('themeIcon');
    if (icon) icon.textContent = this.state.settings.theme === 'dark' ? '🌙' : '☀️';
  },
  toggleTheme(){
    this.state.settings.theme = this.state.settings.theme === 'dark' ? 'light' : 'dark';
    this.saveSettings();
    this.applyTheme();
  },

  /* ---- Init ---- */
  init(){
    Storage.onMerged = () => this.reloadFromStorage(); // another tab/user saved first, rows merged
    this.startLive();
    this.loadAll();
    this.applyTheme();
    this.renderSidebarCounts();
    NotificationCenter.renderBadge();
    WorkspacePicker.renderSwitcher();
    this.applyNavPermissions();

    const closeSidebar = () => {
      document.getElementById('sidebar').classList.remove('open');
      document.getElementById('sidebarBackdrop').classList.remove('open');
    };
    // Desktop: minimize to an icon rail (remembered per browser). Mobile: slide-in drawer.
    const setCollapsed = on => {
      document.body.classList.toggle('sidebar-collapsed', on);
      try{ localStorage.setItem('qa_sidebar_collapsed', on ? '1' : '0'); }catch(e){}
    };
    let saved = false;
    try{ saved = localStorage.getItem('qa_sidebar_collapsed') === '1'; }catch(e){}
    document.body.classList.toggle('sidebar-collapsed', saved);
    document.querySelectorAll('.nav-item').forEach(item => {
      if (item.classList.contains('nav-group-toggle')){
        item.addEventListener('click', () => {
          // Submenus are hidden in the icon rail, so expand the sidebar to show them.
          if (document.body.classList.contains('sidebar-collapsed')){
            setCollapsed(false);
            item.closest('.nav-group').classList.add('open');
            return;
          }
          item.closest('.nav-group').classList.toggle('open');
        });
        return;
      }
      item.addEventListener('click', () => { this.goTo(item.dataset.page); closeSidebar(); });
    });
    document.querySelectorAll('.nav-subitem').forEach(item => {
      item.addEventListener('click', () => { this.goTo(item.dataset.page); closeSidebar(); });
    });
    document.getElementById('themeToggleBtn').addEventListener('click', () => this.toggleTheme());
    document.querySelectorAll('.nav-item').forEach(item => {
      const label = item.querySelector('.nav-label');
      if (label) item.title = label.textContent.trim();
    });
    document.getElementById('hamburgerBtn').addEventListener('click', () => {
      if (window.innerWidth > 1024) return setCollapsed(!document.body.classList.contains('sidebar-collapsed'));
      document.getElementById('sidebar').classList.toggle('open');
      document.getElementById('sidebarBackdrop').classList.toggle('open');
    });
    document.getElementById('sidebarBackdrop').addEventListener('click', closeSidebar);

    // Generic toolbar dropdowns (Filter / Export buttons) — click toggles, outside click closes.
    document.querySelectorAll('.dropdown > button').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        const dd = btn.closest('.dropdown');
        document.querySelectorAll('.dropdown.open').forEach(o => { if (o !== dd) o.classList.remove('open'); });
        dd.classList.toggle('open');
      });
    });
    document.querySelectorAll('.dropdown .dropdown-item').forEach(item => {
      item.addEventListener('click', () => item.closest('.dropdown').classList.remove('open'));
    });
    document.addEventListener('click', e => {
      document.querySelectorAll('.dropdown.open').forEach(dd => { if (!dd.contains(e.target)) dd.classList.remove('open'); });
    });

    // Global realtime search (topbar) — routes to whichever module owns the current page.
    const globalSearch = document.getElementById('globalSearch');
    // Typing only shows the suggestion list — nothing navigates or filters until
    // the user picks: click / arrow + Enter opens that item; Enter with nothing
    // highlighted filters the table on the Test Case / Bug Report page.
    const applyTableFilter = term => {
      if (this.state.currentPage === 'testcase') TestCaseModule.setSearch(term);
      if (this.state.currentPage === 'bugreport') BugReportModule.setSearch(term);
    };
    globalSearch.addEventListener('input', debounce(e => {
      const term = e.target.value.trim();
      if (!term) applyTableFilter(''); // clearing the box resets the table filter
      this.renderSearchResults(term);
    }, 200));
    const resultsEl = document.getElementById('globalSearchResults');
    globalSearch.addEventListener('keydown', e => {
      const items = [...resultsEl.querySelectorAll('.gs-item')];
      const cur = items.findIndex(i => i.classList.contains('active'));
      if (e.key === 'Enter' && cur < 0){
        e.preventDefault();
        applyTableFilter(globalSearch.value.trim());
        resultsEl.classList.remove('open');
        return;
      }
      if (!items.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp'){
        e.preventDefault();
        const next = e.key === 'ArrowDown' ? Math.min(cur + 1, items.length - 1) : Math.max(cur - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === next));
        items[next].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter'){
        e.preventDefault();
        items[cur].click();
      } else if (e.key === 'Escape'){
        resultsEl.classList.remove('open');
      }
    });
    globalSearch.addEventListener('focus', () => this.renderSearchResults(globalSearch.value.trim()));
    resultsEl.addEventListener('click', e => {
      const item = e.target.closest('.gs-item');
      if (!item) return;
      resultsEl.classList.remove('open');
      if (item.dataset.type === 'tc') TestCaseModule.openDetail(item.dataset.id);
      else BugReportModule.openDetail(item.dataset.id);
    });
    document.addEventListener('click', e => { if (!e.target.closest('.topbar-search')) resultsEl.classList.remove('open'); });

    // Keyboard shortcuts: N = new item on current page, Ctrl/Cmd+S = manual "save" toast (data is autosaved).
    document.addEventListener('keydown', e => {
      const typing = ['INPUT','TEXTAREA','SELECT'].includes(document.activeElement.tagName);
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's'){
        e.preventDefault();
        Toast.show('Semua perubahan tersimpan otomatis di Local Storage.', 'success');
      }
      if (!typing && e.key.toLowerCase() === 'n'){
        if (this.state.currentPage === 'testcase'){
          if (TestCaseModule.ui.activeFileId) TestCaseModule.openForm();
          else Toast.show('Buka atau buat file dulu sebelum menambah test case.', 'info');
        }
        if (this.state.currentPage === 'bugreport') BugReportModule.openForm();
      }
      if (!typing && e.key === '/'){
        e.preventDefault();
        globalSearch.focus();
      }
    });

    // A shared Report link (?rptModule=…&rptRound=…) opens straight on the Report page.
    const start = ReportModule.hasUrlFilter() && this.canAccessPage('report') ? 'report' : this.firstAllowedPage();
    this.goTo(start, { replace: true });
    window.addEventListener('hashchange', () => this.openDeepLink());
    window.addEventListener('popstate', e => {
      const page = e.state && e.state.page;
      if (!page || !this.canAccessPage(page)) return;
      document.querySelectorAll('.modal-overlay.active').forEach(m => m.classList.remove('active'));
      this.goTo(page, { fromHistory: true });
    });
  },

  /* Pages gated purely by Auth.can(); rolepermission/workspace (admin-only)
     and importexport (no gate) are checked separately in canAccessPage(). */
  PAGE_PERMISSIONS: {
    dashboard: 'dashboard', summary: 'summary', report: 'report', testcase: 'testcase_read',
    bugreport: 'bugreport_read', bugdetail: 'bugreport_read', masterstatus: 'master', usermanagement: 'usermanagement', settings: 'settings',
    activitylog: 'activitylog'
  },
  canAccessPage(page){
    if (page === 'rolepermission' || page === 'workspace') return Auth.isAdmin();
    if (page === 'importexport') return true;
    const perm = this.PAGE_PERMISSIONS[page];
    return perm ? Auth.can(perm) : false;
  },
  /* Active workspace switched in-app (workspace.js): drop anything that belonged
     to the previous workspace — open file, search, filters, selections — then
     recompute every workspace-scoped view. */
  onWorkspaceChanged(){
    [TestCaseModule, BugReportModule].forEach(m => {
      m.ui.activeFileId = null; m.ui.search = ''; m.ui.page = 1; m.ui.selected.clear();
    });
    Summary.filters.fileId = '';
    ReportModule.filters = { fileId: '', module: '' }; // modules/rounds belong to the old workspace
    ReportModule.open = null;
    const gs = document.getElementById('globalSearch');
    if (gs) gs.value = '';
    this.renderSidebarCounts();
    NotificationCenter.renderBadge();
    WorkspacePicker.renderSwitcher();
    this.goTo(this.state.currentPage || this.firstAllowedPage());
  },

  /* ---- Shared bug links: <app url>#bug=<internal id> ---- */
  bugLink(bug){
    const base = location.href.split('#')[0];
    return `${base}#bug=${encodeURIComponent(bug.id)}`;
  },
  deepLinkBugId(){
    const m = location.hash.match(/^#bug=(.+)$/);
    return m ? decodeURIComponent(m[1]) : null;
  },
  /* Opens the bug from the URL hash (after login + workspace resolution, or
     when a link is pasted into an already-open tab). Switches to the bug's
     workspace when needed. Returns true if a link was handled. */
  openDeepLink(){
    const id = this.deepLinkBugId();
    if (!id) return false;
    // Back/Forward onto the detail page also fires hashchange — it's already showing.
    if (this.state.currentPage === 'bugdetail' && BugReportModule.ui.detailId === id) return true;
    history.replaceState(history.state, '', location.href.split('#')[0]); // goTo('bugdetail') puts it back
    const bug = this.state.bugs.find(b => b.id === id);
    if (!bug){ Toast.show('Bug dari link tidak ditemukan atau sudah dihapus.', 'error'); return true; }
    const file = this.state.files.find(f => f.id === bug.fileId);
    const target = Auth.can('bugreport_read')
      ? WorkspaceCalc.workspaceForFile(file, WorkspacePicker.myWorkspaceIds(), Auth.isAdmin(), WorkspacePicker.activeRaw())
      : null;
    if (target === null){ Toast.show('Anda tidak punya akses ke bug ini.', 'error'); return true; }
    if (target && target !== WorkspacePicker.activeRaw()){
      WorkspacePicker.setActive(target);
      this.onWorkspaceChanged();
    }
    this.goTo('bugreport');
    if (bug.fileId) BugReportModule.openFile(bug.fileId); // Back from the detail page lands on its file
    BugReportModule.ui.detailId = bug.id;
    this.goTo('bugdetail');
    return true;
  },

  /* ⓘ on a file card (Test Case & Bug Report): who made it, when, and what's in it. */
  showFileDetail(fileId){
    const file = this.state.files.find(f => f.id === fileId);
    if (!file) return;
    const tcCount = this.state.testcases.filter(t => t.fileId === fileId).length;
    const bugCount = this.state.bugs.filter(b => b.fileId === fileId).length;
    const ws = id => (Auth.findWorkspace(id) || { name: id || '-' }).name;
    const shared = (file.sharedWith || []).map(ws).join(', ');
    const row = (label, value) => `<div class="file-detail-row"><span>${label}</span><b>${value}</b></div>`;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay confirm-modal status-change-modal active';
    overlay.innerHTML = `
      <div class="modal">
        <h2 style="margin:0 0 14px; font-size:17px;">📁 ${escapeHtml(file.name)}</h2>
        ${row('Dibuat oleh', escapeHtml(file.createdBy || '(tidak tercatat)'))}
        ${row('Dibuat pada', file.createdAt ? formatDateTime(file.createdAt) : '-')}
        ${row('Workspace', escapeHtml(ws(file.workspaceId)))}
        ${shared ? row('Dibagikan ke', escapeHtml(shared)) : ''}
        ${row('Jumlah test case', tcCount)}
        ${row('Jumlah bug', bugCount)}
        <div class="modal-footer"><button class="btn primary" id="fileDetailClose">Tutup</button></div>
      </div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#fileDetailClose').onclick = () => overlay.remove();
    bindBackdropClose(overlay, () => overlay.remove());
  },
  firstAllowedPage(){
    const order = ['dashboard','summary','testcase','bugreport'];
    return order.find(p => this.canAccessPage(p)) || 'dashboard';
  }
};

/* App.init() is triggered by Auth once a role (Admin/User) is chosen — see auth.js. */
