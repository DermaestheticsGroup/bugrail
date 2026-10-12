/* ==========================================================
   auth.js — per-account email+password login gate.
   Client-side only: no real security, just an access gate to
   stop accidental destructive actions (e.g. delete file/folder).
   Accounts persist in localStorage (settings.users). Session
   role/email live in sessionStorage (per tab). The latest login is also kept in
   localStorage with a session id: a new tab starts from it, and on every load a
   tab stays logged in only while that id is still current (Logout anywhere ends it).
   ========================================================== */

const Auth = {
  ROLE_KEY: 'qa_role',
  SESSION_SEED_KEY: 'qa_session_seed',
  SID_KEY: 'qa_sid',
  EMAIL_KEY: 'qa_email',
  WORKSPACE_KEY: 'qa_workspace',
  DEFAULT_USERS: [
    { email: 'admin@bugrail.local', password: 'sama', role: 'admin' }
  ],

  /* Seed roles — after first load these live in settings.roles and are
     fully editable (add/edit/delete) from the Role Permission page.
     'admin' is not stored here: it's a fixed, undeletable role (see isAdmin/can). */
  DEFAULT_ROLES: [
    { value: 'pm_ba', label: 'PM & BA' },
    { value: 'qa_internal', label: 'QA Internal' },
    { value: 'qa_vendor', label: 'QA Vendor' },
    { value: 'user_umum', label: 'User Umum' }
  ],

  /* All roles including the fixed Admin, for dropdowns etc. */
  get ROLES(){
    const custom = (App.state.settings && App.state.settings.roles) || this.DEFAULT_ROLES;
    return [{ value: 'admin', label: 'Admin', builtin: true }, ...custom];
  },
  customRoles(){ return (App.state.settings.roles && App.state.settings.roles.slice()) || this.DEFAULT_ROLES.slice(); },

  /* Checklist rows shown on the Role Permission matrix page (usermanagement.js). */
  PERMISSION_KEYS: [
    { key: 'dashboard', label: 'Dashboard (lihat)' },
    { key: 'summary', label: 'Summary (lihat)' },
    { key: 'report', label: 'Report Go-Live (lihat & export)' },
    { key: 'testcase_create', label: 'Test Case — Tambah' },
    { key: 'testcase_read', label: 'Test Case — Lihat' },
    { key: 'testcase_update', label: 'Test Case — Edit' },
    { key: 'testcase_delete', label: 'Test Case — Hapus' },
    { key: 'testcase_fileShare', label: 'Test Case — Share File antar Workspace' },
    { key: 'activitylog', label: 'Activity Log (lihat)' },
    { key: 'bugreport_fileCreate', label: 'Bug Report — Buat File' },
    { key: 'bugreport_create', label: 'Bug Report — Tambah' },
    { key: 'bugreport_read', label: 'Bug Report — Lihat' },
    { key: 'bugreport_update', label: 'Bug Report — Edit (semua field)' },
    { key: 'bugreport_updateStatusPriority', label: 'Bug Report — Edit Status/Priority saja' },
    { key: 'bugreport_delete', label: 'Bug Report — Hapus' },
    { key: 'bugreport_board', label: 'Bug Report — Board (drag & drop)' },
    { key: 'bugreport_statusQA', label: 'Bug Report — Status QA (hanya dari Retest ke Open/Blocked/Resolved/Closed, wajib keterangan)' },
    { key: 'master', label: 'Master — Status Bug Report' },
    { key: 'usermanagement', label: 'User Management — Daftar User' },
    { key: 'settings', label: 'Settings' }
  ],

  /* Seed permissions per role — adjustable anytime from Role Permission page,
     stored in settings.rolePermissions. Admin is always full-access and never
     goes through this matrix (see can(), hardcoded to avoid self-lockout). */
  DEFAULT_ROLE_PERMISSIONS: {
    pm_ba: { dashboard: true, summary: true, report: true, bugreport_read: true, bugreport_updateStatusPriority: true },
    qa_internal: { testcase_create: true, testcase_read: true, testcase_update: true, testcase_fileShare: true, bugreport_fileCreate: true, bugreport_create: true, bugreport_read: true, bugreport_update: true, bugreport_statusQA: true },
    qa_vendor: { testcase_create: true, testcase_read: true, testcase_update: true, bugreport_read: true, bugreport_update: true, bugreport_board: true, bugreport_statusQA: true },
    user_umum: { testcase_read: true, bugreport_read: true }
  },

  /* ---- Session ---- */
  role(){
    const r = sessionStorage.getItem(this.ROLE_KEY);
    return r === 'user' ? 'user_umum' : r; // legacy role value from before the permission matrix
  },
  isAdmin(){ return this.role() === 'admin'; },
  currentEmail(){ return sessionStorage.getItem(this.EMAIL_KEY); },
  // Active workspace id, or null for none / admin's "Semua workspace" (see workspace.js).
  currentWorkspaceId(){
    const v = sessionStorage.getItem(this.WORKSPACE_KEY);
    return v && v !== WorkspaceCalc.ALL ? v : null;
  },
  /* True when nothing should be filtered by workspace: admin on "Semua workspace"
     (or an admin with no workspace chosen). Single source for every data view. */
  seesAllWorkspaces(){ return this.isAdmin() && !this.currentWorkspaceId(); },

  /* ---- Workspace CRUD (settings.workspaces) — separates files per team/department.
     A file with no workspaceId (legacy data, or created by a workspace-less admin)
     stays visible to everyone, so nothing existing gets locked out. ---- */
  workspaces(){ return App.state.settings.workspaces || []; },
  findWorkspace(id){ return this.workspaces().find(w => w.id === id) || null; },

  addWorkspace(name){
    if (!name || !name.trim()) return { ok: false, error: 'Nama workspace wajib diisi.' };
    const id = 'WS-' + Date.now();
    App.state.settings.workspaces = this.workspaces();
    App.state.settings.workspaces.push({ id, name: name.trim() });
    App.saveSettings();
    return { ok: true, id };
  },

  updateWorkspace(id, name){
    const ws = this.findWorkspace(id);
    if (!ws) return { ok: false, error: 'Workspace tidak ditemukan.' };
    if (!name || !name.trim()) return { ok: false, error: 'Nama workspace wajib diisi.' };
    ws.name = name.trim();
    App.saveSettings();
    return { ok: true };
  },

  /* Files with no workspaceId are shared/visible to everyone (legacy data,
     or created by a workspace-less admin). A file can also be explicitly
     shared with other workspaces via `sharedWith` (array of workspace ids),
     set through shareFile() — gated by the testcase_fileShare permission.
     Admin sees every file on "Semua workspace", otherwise the active one's. */
  visibleFiles(allFiles){
    if (this.seesAllWorkspaces()) return allFiles;
    const ws = this.currentWorkspaceId();
    return allFiles.filter(f => !f.workspaceId || f.workspaceId === ws || (f.sharedWith || []).includes(ws));
  },

  /* Share/unshare a file with other workspaces. Only the owning workspace
     (or admin) may change sharing, and only with testcase_fileShare permission. */
  canShareFile(file){
    if (this.isAdmin()) return this.can('testcase_fileShare');
    if (!file.workspaceId) return false; // shared/legacy files have no single owner
    return file.workspaceId === this.currentWorkspaceId() && this.can('testcase_fileShare');
  },

  deleteWorkspace(id){
    const inUse = (App.state.settings.users || []).some(u => WorkspaceCalc.userWorkspaceIds(u).includes(id));
    if (inUse) return { ok: false, error: 'Workspace masih dipakai user, pindahkan user tersebut dulu.' };
    App.state.settings.workspaces = this.workspaces().filter(w => w.id !== id);
    App.saveSettings();
    return { ok: true };
  },

  /* ---- Role CRUD (settings.roles) ---- */
  normalizeRoleCode(code){ return String(code || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, ''); },

  findRole(value){ return this.customRoles().find(r => r.value === value) || null; },

  addRole(label, code){
    const value = this.normalizeRoleCode(code);
    if (!label || !label.trim()) return { ok: false, error: 'Nama role wajib diisi.' };
    if (!value) return { ok: false, error: 'Kode role wajib diisi.' };
    if (value === 'admin' || this.findRole(value)) return { ok: false, error: 'Kode role sudah dipakai.' };
    App.state.settings.roles = this.customRoles();
    App.state.settings.roles.push({ value, label: label.trim() });
    App.state.settings.rolePermissions = App.state.settings.rolePermissions || {};
    App.state.settings.rolePermissions[value] = {};
    App.saveSettings();
    return { ok: true, value };
  },

  updateRole(value, label){
    const role = this.findRole(value);
    if (!role) return { ok: false, error: 'Role tidak ditemukan.' };
    if (!label || !label.trim()) return { ok: false, error: 'Nama role wajib diisi.' };
    role.label = label.trim();
    App.saveSettings();
    return { ok: true };
  },

  deleteRole(value){
    if (value === 'admin') return { ok: false, error: 'Role Admin tidak bisa dihapus.' };
    const inUse = (App.state.settings.users || []).some(u => u.role === value);
    if (inUse) return { ok: false, error: 'Role masih dipakai user, pindahkan user tersebut dulu.' };
    App.state.settings.roles = this.customRoles().filter(r => r.value !== value);
    if (App.state.settings.rolePermissions) delete App.state.settings.rolePermissions[value];
    App.saveSettings();
    return { ok: true };
  },

  /* ---- Permission matrix ---- */
  can(permKey){
    if (this.isAdmin()) return true;
    const role = this.role();
    const saved = App.state.settings.rolePermissions && App.state.settings.rolePermissions[role];
    const map = saved || this.DEFAULT_ROLE_PERMISSIONS[role] || {};
    return !!map[permKey];
  },

  /* ---- Pure helpers (no storage/DOM access — unit-testable) ---- */
  normalizeEmail(email){ return String(email || '').trim().toLowerCase(); },

  isValidEmail(email){
    return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
  },

  /* <option>s for an "Assign ke" select — every registered account. Keeps a
     no-longer-registered assignee selectable so editing doesn't silently drop it. */
  /* workspaceId given: only members of that workspace (the current assignee is
     kept even if they've left it, so editing doesn't silently unassign). */
  userOptions(selected = '', workspaceId = ''){
    const users = (App.state.settings.users || [])
      .filter(u => !workspaceId || WorkspaceCalc.userWorkspaceIds(u).includes(workspaceId))
      .map(u => u.email).filter(Boolean);
    if (selected && !users.some(e => this.normalizeEmail(e) === this.normalizeEmail(selected))) users.push(selected);
    return `<option value="">— Belum di-assign —</option>` + users.sort()
      .map(e => `<option value="${escapeHtml(e)}" ${this.normalizeEmail(e) === this.normalizeEmail(selected) ? 'selected' : ''}>${escapeHtml(e)}</option>`).join('');
  },

  /* Appends to item.assignments when the assignee actually changes — the
     notification bell (notifications.js) reads this log. */
  logAssignment(item, prevAssignee, nextAssignee){
    if (this.normalizeEmail(prevAssignee || '') === this.normalizeEmail(nextAssignee || '')) return;
    if (!item.assignments) item.assignments = [];
    item.assignments.push({ at: nowISO(), to: nextAssignee || '', by: this.currentEmail() || 'unknown' });
  },

  findByEmail(users, email){
    const target = this.normalizeEmail(email);
    return (users || []).find(u => this.normalizeEmail(u.email) === target) || null;
  },

  matchCredentials(users, email, password){
    const user = this.findByEmail(users, email);
    if (!user || user.password !== password) return null;
    return user;
  },

  /* ---- Storage access (reads settings directly — App.state.settings
     isn't loaded yet at pre-login time, App.init() runs after login) ---- */
  loadSettingsRaw(){
    return Storage.get(STORAGE_KEYS.SETTINGS, { theme: 'light', customFieldDefs: [], users: [] });
  },

  ensureSeedUsers(){
    const settings = this.loadSettingsRaw();
    if (!settings.users || !settings.users.length){
      settings.users = this.DEFAULT_USERS.slice();
      Storage.set(STORAGE_KEYS.SETTINGS, settings);
    }
  },

  /* ---- Login/session lifecycle ----
     login -> (workspace picker, see workspace.js, when the account has 2+
     workspaces) -> startApp(). A reload with a live session goes straight to
     startApp() unless no valid workspace is active yet. */
  startApp(){
    document.body.classList.remove('pre-auth');
    App.init();
    if (this._freshLogin){
      ActivityLog.record('login', `${this.currentEmail()} login sebagai ${this.role()}`);
      this._freshLogin = false;
    }
    this.renderBadge();
    return App.openDeepLink(); // #bug=… link: jump straight to that bug
  },

  login(email, password){
    this.ensureSeedUsers();
    const settings = this.loadSettingsRaw();
    const user = this.matchCredentials(settings.users, email, password);
    const errEl = document.getElementById('loginError');
    if (!user){
      errEl.textContent = 'Email atau password salah.';
      return;
    }
    errEl.textContent = '';
    sessionStorage.setItem(this.ROLE_KEY, user.role);
    sessionStorage.setItem(this.EMAIL_KEY, this.normalizeEmail(email));
    const sid = IdGen.uid('S');
    sessionStorage.setItem(this.SID_KEY, sid);
    try{ localStorage.setItem(this.SESSION_SEED_KEY, JSON.stringify({ role: user.role, email: this.normalizeEmail(email), sid })); }catch(e){}
    sessionStorage.removeItem(this.WORKSPACE_KEY);
    this._freshLogin = true;
    if (WorkspacePicker.resolveOnStart()) this.startApp();
  },

  async logout(){
    if (!(await confirmDialog('Keluar dari BugRail?', 'Apakah anda yakin ingin logout?', 'Logout'))) return;
    ActivityLog.record('logout', `${this.currentEmail()} logout`);
    // Let the log (and any other save) reach the server first. Anything still
    // unsynced stays in localStorage and is re-sent on next boot, so no prompt.
    await Storage.settle();
    sessionStorage.removeItem(this.ROLE_KEY);
    sessionStorage.removeItem(this.EMAIL_KEY);
    sessionStorage.removeItem(this.SID_KEY);
    try{ localStorage.removeItem(this.SESSION_SEED_KEY); }catch(e){}
    sessionStorage.removeItem(this.WORKSPACE_KEY);
    Storage.leaving = true;
    location.reload();
  },

  renderBadge(){
    const el = document.getElementById('authBadge');
    if (!el) return;
    const role = this.role();
    const email = this.currentEmail() || '';
    const name = email.split('@')[0] || (role === 'admin' ? 'Admin' : 'User');
    el.innerHTML = `
      <span class="auth-role" title="${escapeHtml(email)}">${role === 'admin' ? '🔑' : '👤'} ${escapeHtml(name)}</span>
      <button class="btn sm ghost" id="authLogoutBtn">Logout</button>
    `;
    document.getElementById('authLogoutBtn').addEventListener('click', () => this.logout());
  },

  bindLoginScreen(){
    const form = document.getElementById('loginForm');
    form.addEventListener('submit', e => {
      e.preventDefault();
      this.login(
        document.getElementById('loginEmail').value,
        document.getElementById('loginPassword').value
      );
    });
    const pwToggle = document.getElementById('loginPwToggle');
    const pwInput = document.getElementById('loginPassword');
    pwToggle.addEventListener('click', () => {
      pwInput.type = pwInput.type === 'password' ? 'text' : 'password';
    });
  },

  init(){
    this.ensureSeedUsers();
    let seed = null;
    try{ seed = JSON.parse(localStorage.getItem(this.SESSION_SEED_KEY)); }catch(e){}
    // This tab's login was ended (Logout / new login in another tab): drop it.
    if (this.role() && (!seed || seed.sid !== sessionStorage.getItem(this.SID_KEY))){
      [this.ROLE_KEY, this.EMAIL_KEY, this.SID_KEY, this.WORKSPACE_KEY].forEach(k => sessionStorage.removeItem(k));
    }
    // New tab (or the old one ended): start from the browser's current login, if any.
    if (!this.role() && seed && seed.role && seed.email && seed.sid){
      sessionStorage.setItem(this.ROLE_KEY, seed.role);
      sessionStorage.setItem(this.EMAIL_KEY, seed.email);
      sessionStorage.setItem(this.SID_KEY, seed.sid);
    }
    this.bindLoginScreen();
    if (this.role() && WorkspacePicker.resolveOnStart()) this.startApp();
    // else: stays in pre-auth state, login screen visible, App.init() deferred until login().
  },

  /* ---- Self-check for the pure matching/validation logic.
     Run manually from the browser console: Auth.selfTest() ---- */
  selfTest(){
    const users = [
      { email: 'Admin@Bugrail.local', password: 'admin123', role: 'admin' },
      { email: 'tester@bugrail.local', password: 'test1234', role: 'user' }
    ];
    let pass = 0, total = 0;
    const check = (label, cond) => {
      total++;
      if (cond) pass++; else console.error('FAIL:', label);
    };
    check('matches correct credentials', !!this.matchCredentials(users, 'tester@bugrail.local', 'test1234'));
    check('rejects wrong password', this.matchCredentials(users, 'tester@bugrail.local', 'nope') === null);
    check('rejects unknown email', this.matchCredentials(users, 'nobody@x.com', 'test1234') === null);
    check('email match is case-insensitive', !!this.matchCredentials(users, 'ADMIN@bugrail.local', 'admin123'));
    check('findByEmail trims/lowercases', !!this.findByEmail(users, '  Tester@Bugrail.Local  '));
    check('isValidEmail accepts valid address', this.isValidEmail('a@b.com') === true);
    check('isValidEmail rejects missing @', this.isValidEmail('a-b.com') === false);
    check('isValidEmail rejects missing domain dot', this.isValidEmail('a@b') === false);
    console.log(`Auth self-test: ${pass}/${total} passed`);
    return pass === total;
  }
};

document.addEventListener('DOMContentLoaded', async () => {
  await Storage.hydrate();
  Auth.init();
  document.getElementById('loadingOverlay').style.display = 'none';
});
