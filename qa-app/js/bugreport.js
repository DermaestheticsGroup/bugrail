/* ==========================================================
   bugreport.js — Bug Report module, tightly integrated with
   Test Case (per spec: selecting a Test Case auto-fills
   Module/Feature/Scenario/Expected Result/Steps/Tester).
   ========================================================== */

const BugReportModule = {
  SEVERITY: ['Critical', 'High', 'Medium', 'Low'],
  /* Seed for Settings > Master > Status Bug Report (js/masterstatus.js) */
  DEFAULT_STATUS_MASTER: [
    { code: 'OPEN', name: 'Open', color: '#2563EB', order: 1 },
    { code: 'IN_PROGRESS', name: 'In Progress', color: '#F59E0B', order: 2 },
    { code: 'RETEST', name: 'Retest', color: '#06B6D4', order: 3 },
    { code: 'RESOLVED', name: 'Resolved', color: '#22C55E', order: 4 },
    { code: 'CLOSED', name: 'Closed', color: '#6B7280', order: 5 },
    { code: 'REJECTED', name: 'Rejected', color: '#EF4444', order: 6 }
  ],
  statusMaster(){
    const list = App.state.settings.bugStatusMaster;
    return (list && list.length) ? list : this.DEFAULT_STATUS_MASTER;
  },
  get STATUS(){
    return this.statusMaster().slice().sort((a, b) => a.order - b.order).map(s => s.name);
  },

  ui: {
    search: '', filters: { module:'', severity:'', priority:'', status:'', tester:'' },
    sortKey: 'reportDate', sortDir: 'desc', page: 1, pageSize: 10,
    selected: new Set(), editingId: null, activeFileId: null,
    view: 'table', detailId: null, chatTab: 'comment'
  },

  setSearch(term){ this.ui.search = term; this.ui.page = 1; this.render(); },
  // Linked test case: bugs store its internal id; show / import by its number.
  tcLabel(tcId){ return tcId ? tcCode(App.state.testcases.find(t => t.id === tcId) || { id: tcId }) : ''; },
  tcIdFromCode(code){
    code = String(code || '').trim();
    if (!code) return null;
    const ws = fileWorkspace(this.ui.activeFileId);
    const hit = t => tcCode(t) === code || t.id === code;
    // Same file first (codes can repeat across files/workspaces), then same workspace, then anywhere.
    const tc = App.state.testcases.find(t => hit(t) && t.fileId === this.ui.activeFileId)
      || App.state.testcases.find(t => hit(t) && fileWorkspace(t.fileId) === ws)
      || App.state.testcases.find(t => tcCode(t) === code || t.id === code);
    return tc ? tc.id : null;
  },

  // Display number, counted per workspace of the file the bug lives in.
  nextCode(fileId){
    const ws = fileWorkspace(fileId);
    return IdGen.nextInScope('BUG', App.state.bugs.filter(b => fileWorkspace(b.fileId) === ws).map(bugCode));
  },

  all(){
    if (Auth.seesAllWorkspaces()) return App.state.bugs;
    const visibleIds = new Set(this.files().map(f => f.id));
    return App.state.bugs.filter(b => !b.fileId || visibleIds.has(b.fileId));
  },

  /* ---- files (grouping, shared with Test Case module) ---- */
  files(){ return Auth.visibleFiles(App.state.files); },
  fileCount(fileId){ return App.state.bugs.filter(b => b.fileId === fileId).length; },
  createFile(name, workspaceId = Auth.currentWorkspaceId()){
    name = (name || '').trim();
    if (!name) return;
    const file = { id: 'FILE-' + Date.now(), name, workspaceId, createdBy: Auth.currentEmail() || '', createdAt: nowISO() };
    App.state.files.push(file);
    App.saveFiles();
    ActivityLog.record('bug_file_create', `File Bug Report "${name}" dibuat`);
    this.renderFileList();
    Toast.show(`File "${name}" dibuat.`, 'success');
  },
  async editFile(fileId){
    const file = this.files().find(f => f.id === fileId);
    if (!file) return;
    const canShare = Auth.canShareFile(file);
    const result = await fileEditDialog(file, canShare, Auth.workspaces());
    if (!result) return;
    const oldName = file.name;
    const oldShared = (file.sharedWith || []).slice().sort();
    file.name = result.name;
    if (canShare) file.sharedWith = result.sharedWith;
    App.saveFiles();
    if (oldName !== file.name) ActivityLog.record('bug_file_rename', `File Bug Report "${oldName}" diganti nama jadi "${file.name}"`);
    const newShared = (file.sharedWith || []).slice().sort();
    if (canShare && JSON.stringify(oldShared) !== JSON.stringify(newShared)){
      ActivityLog.record('bug_file_share', newShared.length
        ? `File Bug Report "${file.name}" dibagikan ke ${newShared.length} workspace`
        : `Sharing File Bug Report "${file.name}" dihapus`);
    }
    this.render();
    Toast.show(`File "${file.name}" diperbarui.`, 'success');
  },
  async deleteFile(fileId){
    if (!Auth.isAdmin()){ Toast.show('Hanya Admin yang dapat menghapus file.', 'error'); return; }
    const file = this.files().find(f => f.id === fileId);
    const tcCount = App.state.testcases.filter(t => t.fileId === fileId).length;
    const bugCount = App.state.bugs.filter(b => b.fileId === fileId).length;
    const ok = await confirmDialog('Hapus File?', `File "${file.name}" beserta ${tcCount} test case dan ${bugCount} bug di dalamnya akan dihapus permanen.`, 'Hapus');
    if (!ok) return;
    App.deleteFileCascade(fileId);
    ActivityLog.record('bug_file_delete', `File Bug Report "${file.name}" dihapus`);
    if (this.ui.activeFileId === fileId) this.ui.activeFileId = null;
    this.render();
    Toast.show(`File "${file.name}" dihapus.`, 'info');
  },
  openFile(fileId){
    this.ui.activeFileId = fileId; this.ui.page = 1; this.ui.selected.clear();
    this.render();
  },
  backToFiles(){
    this.ui.activeFileId = null; this.ui.search = '';
    const globalSearch = document.getElementById('globalSearch');
    if (globalSearch) globalSearch.value = '';
    this.render();
  },

  filtered(){
    const { search, filters, sortKey, sortDir, activeFileId } = this.ui;
    let rows = this.all().filter(b => {
      if (activeFileId && b.fileId !== activeFileId) return false;
      if (search){
        const hay = `${bugCode(b)} ${b.module} ${b.title} ${b.tester} ${this.tcLabel(b.testCaseId)} ${b.description||''} ${b.steps||''} ${b.expectedResult||''} ${b.actualResult||''}`.toLowerCase();
        const words = search.toLowerCase().trim().split(/\s+/).filter(Boolean);
        if (!words.every(w => hay.includes(w))) return false;
      }
      if (filters.module && b.module !== filters.module) return false;
      if (filters.severity && b.severity !== filters.severity) return false;
      if (filters.priority && normPriority(b.priority) !== filters.priority) return false;
      if (filters.status && b.status !== filters.status) return false;
      if (filters.tester && b.tester !== filters.tester) return false;
      return true;
    });
    rows.sort((a, b) => compareRows(a, b, sortKey, sortDir, bugCode));
    return rows;
  },

  uniqueValues(field){ return [...new Set(this.all().map(b => b[field]).filter(Boolean))].sort(); },

  render(){
    // If the open file was deleted or is no longer shared with this user,
    // fall back to the file list instead of a stuck empty detail view.
    if (this.ui.activeFileId && !this.files().some(f => f.id === this.ui.activeFileId)) this.ui.activeFileId = null;
    const searching = !!this.ui.search;
    const inFile = !!this.ui.activeFileId || searching;
    document.getElementById('bugFileListView').style.display = inFile ? 'none' : 'block';
    document.getElementById('bugFileDetailView').style.display = inFile ? 'block' : 'none';
    document.getElementById('bugNewFileBtn').style.display = Auth.can('bugreport_fileCreate') ? '' : 'none';
    if (!inFile){ this.renderFileList(); return; }

    const activeFile = this.files().find(f => f.id === this.ui.activeFileId);
    document.getElementById('bugActiveFileName').textContent = activeFile
      ? `📁 ${activeFile.name}`
      : `🔎 Hasil pencarian "${this.ui.search}" (semua file)`;
    document.getElementById('bugActiveFileHint').textContent = activeFile
      ? `(${this.fileCount(this.ui.activeFileId)} bug)`
      : `${this.filtered().length} hasil ditemukan`;

    document.getElementById('bugAddBtn').style.display = Auth.can('bugreport_create') ? '' : 'none';
    document.getElementById('bugViewToggle').querySelector('[data-view="board"]').style.display = Auth.can('bugreport_board') ? '' : 'none';
    if (!Auth.can('bugreport_board') && this.ui.view === 'board') this.ui.view = 'table';

    this.renderFilterOptions();
    const rows = this.filtered();
    const total = rows.length;
    const totalPages = Math.max(1, Math.ceil(total / this.ui.pageSize));
    if (this.ui.page > totalPages) this.ui.page = totalPages;
    const start = (this.ui.page - 1) * this.ui.pageSize;
    const pageRows = rows.slice(start, start + this.ui.pageSize);

    const isBoard = this.ui.view === 'board';
    document.getElementById('bugEmptyState').style.display = total ? 'none' : 'flex';
    if (!total){
      const searchingNow = !!this.ui.search || Object.values(this.ui.filters).some(Boolean);
      document.getElementById('bugEmptyGlyph').textContent = searchingNow ? '🔍' : '🐞';
      document.getElementById('bugEmptyTitle').textContent = searchingNow ? 'Data tidak ditemukan' : 'Belum ada Bug Report';
      document.getElementById('bugEmptyDesc').textContent = searchingNow ? 'Coba kata kunci atau filter lain.' : 'Buat bug baru, atau klik "Create Bug" pada Test Case berstatus Failed.';
      document.getElementById('bugEmptyAddBtn').style.display = searchingNow ? 'none' : (Auth.can('bugreport_create') ? '' : 'none');
    }
    document.getElementById('bugTableWrap').style.display = (total && !isBoard) ? 'block' : 'none';
    document.getElementById('bugTableFooter').style.display = isBoard ? 'none' : 'flex';
    document.getElementById('bugBoardWrap').style.display = (isBoard && total) ? 'flex' : 'none';
    if (isBoard){
      if (total) this.renderBoard(rows);
      const bulkBar = document.getElementById('bugBulkBar');
      bulkBar.style.display = 'none';
      return;
    }

    const canEdit = Auth.can('bugreport_update') || Auth.can('bugreport_updateStatusPriority');
    const canDelete = Auth.can('bugreport_delete');

    const bulkBar = document.getElementById('bugBulkBar');
    bulkBar.style.display = this.ui.selected.size ? 'flex' : 'none';
    bulkBar.querySelector('.count').textContent = this.ui.selected.size;
    document.getElementById('bugBulkDeleteBtn').style.display = canDelete ? '' : 'none';
    document.getElementById('bugBulkStatusSelect').style.display = canEdit ? '' : 'none';
    document.getElementById('bugTableBody').innerHTML = pageRows.map(b => `
      <tr class="row-clickable" data-id="${b.id}">
        <td><input type="checkbox" class="checkbox bug-row-check" data-id="${b.id}" ${this.ui.selected.has(b.id)?'checked':''}></td>
        <td class="mono">${this.bugKeyLink(b)}</td>
        <td class="mono text-dim">${escapeHtml(this.tcLabel(b.testCaseId) || '-')}</td>
        <td class="truncate" title="${escapeHtml(b.title)}">${escapeHtml(b.title)}</td>
        <td class="truncate" title="${escapeHtml(b.module)}">${escapeHtml(b.module)}</td>
        <td>${this.severityBadge(b.severity)}</td>
        <td>${this.statusBadge(b.status)}</td>
        <td>${escapeHtml(b.tester || '-')}</td>
        <td>${formatDate(b.reportDate)}</td>
        <td class="cell-actions">
          ${actionMenu(`
            <button data-act="view" data-id="${b.id}">👁 Lihat Detail</button>
            ${canEdit ? `<button data-act="edit" data-id="${b.id}">✎ Edit</button>` : ''}
            <button data-act="print" data-id="${b.id}">🖨 Print</button>
            ${canDelete ? `<button class="danger" data-act="del" data-id="${b.id}">🗑 Delete</button>` : ''}
          `)}
        </td>
      </tr>
    `).join('');

    document.getElementById('bugResultInfo').textContent = `Menampilkan ${pageRows.length} dari ${total} bug`;
    this.renderPagination(totalPages);
    this.bindRowEvents();
    document.getElementById('bugSelectAll').checked = pageRows.length > 0 && pageRows.every(r => this.ui.selected.has(r.id));
  },

  renderFileList(){
    App.ensureDefaultFile();
    const wrap = document.getElementById('bugFileListGrid');
    const files = this.files();
    if (!files.length){
      wrap.innerHTML = `<p class="text-faint" style="font-size:13.5px; grid-column:1/-1; padding:24px 0; text-align:center;">📁 Belum ada file. Buat file di halaman Test Case.</p>`;
      return;
    }
    wrap.innerHTML = files.map(f => {
      const shareCount = (f.sharedWith || []).length;
      return `
      <div class="card tc-file-card ${f.workspaceId ? 'ws-colored' : ''}" data-open="${f.id}" style="--ws-fg:${WorkspaceCalc.colorFor(Auth.workspaces(), f.workspaceId)[1]};">
        <div class="flex-between">
          <h3 style="margin:0; font-size:14.5px; cursor:pointer; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" data-open="${f.id}">📁 ${escapeHtml(f.name)}</h3>
          <div class="file-card-actions"><button class="file-info-btn" type="button" data-info="${f.id}" title="Detail file" aria-label="Detail file"><svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/></svg></button>${actionMenu(`
            <button data-act="edit" data-id="${f.id}">✎ Edit</button>
            <button class="danger" data-act="del" data-id="${f.id}">🗑 Hapus</button>
          `)}</div>
        </div>
        <div class="flex-between" style="margin-top:8px;">
          <p class="text-faint" style="font-size:12.5px; margin:0;">${App.state.testcases.filter(t => t.fileId === f.id).length} test case · ${App.state.bugs.filter(b => b.fileId === f.id).length} bug</p>
          ${shareCount ? `<span class="badge st-notrun" title="Dibagikan ke ${shareCount} workspace">📤 ${shareCount}</span>` : ''}
        </div>
      </div>
    `;
    }).join('') + (Auth.can('bugreport_fileCreate') ? `<button class="card tc-file-card tc-file-add" type="button" id="bugNewFileAddCard">+ Tambah file</button>` : '');
    wrap.querySelectorAll('[data-open]').forEach(el => el.addEventListener('click', (e) => {
      if (e.target.closest('.action-menu, .file-info-btn')) return;
      this.openFile(el.dataset.open);
    }));
    const addCard = document.getElementById('bugNewFileAddCard');
    if (addCard) addCard.onclick = () => document.getElementById('bugNewFileBtn').click();
    wrap.querySelectorAll('.file-info-btn').forEach(btn => { btn.onclick = () => App.showFileDetail(btn.dataset.info); });
    wrap.querySelectorAll('.action-menu button[data-act]').forEach(btn => {
      btn.onclick = async () => {
        const { act, id } = btn.dataset;
        if (act === 'edit') this.editFile(id);
        if (act === 'del') this.deleteFile(id);
      };
    });
  },

  renderBoard(rows){
    const wrap = document.getElementById('bugBoardWrap');
    const columns = this.statusMaster().slice().sort((a,b) => a.order - b.order);
    wrap.innerHTML = columns.map(col => {
      const items = rows.filter(b => b.status === col.name);
      return `
        <div class="board-col" data-status="${escapeHtml(col.name)}">
          <div class="board-col-head" style="border-top:3px solid ${col.color};">
            <span>${escapeHtml(col.name)}</span>
            <span class="board-col-count">${items.length}</span>
          </div>
          <div class="board-col-body" data-status="${escapeHtml(col.name)}">
            ${items.map(b => `
              <div class="board-card" draggable="true" data-id="${b.id}">
                <div class="board-card-top">
                  <span class="mono" style="font-size:11px;">${this.bugKeyLink(b)}</span>
                  ${this.severityBadge(b.severity)}
                </div>
                <div class="board-card-title">${escapeHtml(b.title)}</div>
                <div class="board-card-meta"><span>${escapeHtml(b.tester || '-')}</span><span>${formatDate(b.reportDate)}</span></div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }).join('');

    this.bindBugKeyLinks(wrap);
    wrap.querySelectorAll('.board-card').forEach(card => {
      card.addEventListener('click', () => this.openDetail(card.dataset.id));
      card.addEventListener('dragstart', e => {
        card.classList.add('dragging');
        e.dataTransfer.setData('text/plain', card.dataset.id);
      });
      card.addEventListener('dragend', () => card.classList.remove('dragging'));
    });
    wrap.querySelectorAll('.board-col-body').forEach(colBody => {
      colBody.addEventListener('dragover', e => { e.preventDefault(); colBody.classList.add('drag-over'); });
      colBody.addEventListener('dragleave', () => colBody.classList.remove('drag-over'));
      colBody.addEventListener('drop', e => {
        e.preventDefault();
        colBody.classList.remove('drag-over');
        const id = e.dataTransfer.getData('text/plain');
        this.setStatus(id, colBody.dataset.status);
      });
    });
  },

  async setStatus(id, status){
    if (!Auth.can('bugreport_board')) return;
    const bug = this.all().find(b => b.id === id);
    if (!bug || bug.status === status) return;
    const from = bug.status;
    const change = await this.confirmStatusChange([bug], status, `${bugCode(bug)}: ${from} → ${status}`);
    if (!change) return;
    this.logActivity(bug, bug.status, status, change);
    bug.status = status;
    App.saveBugs();
    ActivityLog.record('bugreport_update', `Bug ${bugCode(bug)} status diubah dari ${from} ke ${status} (board)${change.note ? `: ${change.note}` : ''}`);
    this.render();
  },

  logActivity(bug, from, to, change = {}){
    if (!bug.activity) bug.activity = [];
    bug.activity.push({ at: nowISO(), from, to, note: change.note, attachment: change.attachment || '', email: Auth.currentEmail() || 'unknown' });
  },

  // Status name -> master code (OPEN, IN_PROGRESS, RETEST...); unknown names normalised the same way.
  statusCode(name){
    const m = this.statusMaster().find(s => s.name === name);
    return String(m ? m.code : name || '').toUpperCase().replace(/\s+/g, '_');
  },

  /* Gate for every status change (board, form, bulk): enforces statusTransitionRule
     (utils.js) and asks for a note only when a move needs one.
     Resolves { note, attachment }, or null (with a toast) when blocked/cancelled. */
  async confirmStatusChange(bugs, to, label){
    const isQA = !Auth.isAdmin() && Auth.can('bugreport_statusQA');
    const rules = bugs.filter(b => b.status !== to)
      .map(b => statusTransitionRule(this.statusCode(b.status), this.statusCode(to), isQA));
    if (rules.some(r => !r.ok)){
      Toast.show('QA hanya bisa memindahkan status dari Retest ke Open, Blocked, Resolved, atau Closed.', 'error');
      return null;
    }
    return rules.some(r => r.needNote) ? this.askStatusNote(label) : { note: '', attachment: '' };
  },

  /* Reason (required) + optional attachment links for a status change.
     Resolves { note, attachment }, or null (with a toast) when cancelled. */
  askStatusNote(label){
    return new Promise(resolve => {
      const overlay = document.createElement('div');
      overlay.className = 'modal-overlay confirm-modal status-change-modal active';
      overlay.innerHTML = `
        <div class="modal">
          <h2 style="margin:0 0 14px; font-size:17px;">${escapeHtml(`Perubahan status — ${label}`)}</h2>
          <div class="field">
            <label>Keterangan <span class="req">*</span></label>
            <textarea id="statusNoteInput" placeholder="Alasan / keterangan perubahan status"></textarea>
            <p class="combobox-error" id="statusNoteError" style="display:none;">Keterangan wajib diisi.</p>
          </div>
          <div class="field">
            <label>Attachment <span class="text-faint">(opsional)</span></label>
            <textarea id="statusAttachInput" placeholder="Link screenshot / video / dokumen, satu per baris"></textarea>
          </div>
          <div class="modal-footer">
            <button class="btn" id="statusCancelBtn">Batal</button>
            <button class="btn primary" id="statusOkBtn">Ubah Status</button>
          </div>
        </div>`;
      document.body.appendChild(overlay);
      const noteEl = overlay.querySelector('#statusNoteInput');
      const errEl = overlay.querySelector('#statusNoteError');
      noteEl.focus();
      const close = value => {
        overlay.remove();
        if (!value) Toast.show('Status tidak diubah.', 'info');
        resolve(value);
      };
      noteEl.addEventListener('input', () => { errEl.style.display = 'none'; noteEl.classList.remove('input-invalid'); });
      overlay.querySelector('#statusCancelBtn').onclick = () => close(null);
      overlay.querySelector('#statusOkBtn').onclick = () => {
        const note = noteEl.value.trim();
        if (!note){ errEl.style.display = 'block'; noteEl.classList.add('input-invalid'); noteEl.focus(); return; }
        close({ note, attachment: overlay.querySelector('#statusAttachInput').value.trim() });
      };
      bindBackdropClose(overlay, () => close(null));
    });
  },

  /* Times a bug bounced back to Reopened/Retest — i.e. how many retest rounds it
     failed. Status naming isn't unified across the app (form dropdown uses
     "Reopened", board/master status list uses "Retest"), so match both. */
  reopenCount(bug){
    return (bug.activity || []).filter(a => a.to === 'Reopened' || a.to === 'Retest').length;
  },

  /* ---- Detail (read-only view + activity log + chat) ----
     Popup from the list / board / reports; asPage (App.goTo('bugdetail'), from a
     #bug= link) moves the same box into its own page instead. */
  openDetail(id, asPage = false){
    const bug = this.all().find(b => b.id === id);
    if (!bug) return;
    this.ui.detailId = id;
    this.ui.chatTab = 'comment';
    document.querySelectorAll('#bugChatTabs .bug-chat-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.chatTab === 'comment');
    });
    // In the popup the ID opens the full page; on the page it's there to copy.
    document.getElementById('bugDetailTitle').innerHTML = `Detail Bug — ${this.bugKeyLink(bug)}`;

    /* Content blocks (description/steps/results) read like a document, so they
       live in the main column as titled cards. Short facts (status, severity,
       tester...) go in a compact sidebar instead of the same flat row list —
       keeps the two kinds of information from blurring into one wall of text. */
    const block = (label, value, extraClass = '') => `
      <div class="bug-detail-block ${extraClass}">
        <div class="bug-detail-block-label">${label}</div>
        <div class="bug-detail-block-body">${value}</div>
      </div>`;
    const sideField = (label, value) => `
      <div class="bug-side-field">
        <div class="bug-side-label">${label}</div>
        <div class="bug-side-value">${value}</div>
      </div>`;
    const retestCount = this.reopenCount(bug);
    const attachmentsHtml = (bug.attachments || '').split('\n').map(s => s.trim()).filter(Boolean)
      .map(link => /^https?:\/\//i.test(link) ? `<a href="${escapeHtml(link)}" target="_blank" rel="noopener">${escapeHtml(link)}</a>` : escapeHtml(link))
      .join('<br>') || null;

    document.getElementById('bugDetailBody').innerHTML = `
      <div class="bug-detail-grid">
        <div class="bug-detail-main">
          <h3 class="bug-detail-title">${escapeHtml(bug.title)}</h3>
          ${bug.preconditions ? block('Pre-condition', escapeHtml(bug.preconditions)) : ''}
          ${bug.testData ? block('Test Data', escapeHtml(bug.testData)) : ''}
          ${block('Steps to Reproduce', safeStepsHtml(bug.steps) || '-')}
          ${block('Expected Result', escapeHtml(bug.expectedResult || '-'))}
          ${block('Actual Result', escapeHtml(bug.actualResult || '-'))}
          ${bug.description ? block('Impact / Catatan Tambahan', escapeHtml(bug.description)) : ''}
          ${attachmentsHtml ? block('Attachment', attachmentsHtml) : ''}
        </div>
        <div class="bug-detail-side">
          <div class="bug-side-heading">Details</div>
          ${sideField('Status', this.statusBadge(bug.status))}
          ${sideField('Severity', this.severityBadge(bug.severity))}
          ${sideField('Priority', escapeHtml(bug.priority))}
          ${sideField('Module', escapeHtml(bug.module || '-'))}
          ${sideField('Tester', escapeHtml(bug.tester || '-'))}
          ${sideField('Assignee', escapeHtml(bug.assignee || '-'))}
          ${sideField('Environment', escapeHtml([bug.environment, bug.buildVersion].filter(Boolean).join(' · ') || '-'))}
          ${sideField('Platform', escapeHtml([bug.platform, bug.os, bug.browser, bug.device].filter(Boolean).join(' · ') || '-'))}
          ${sideField('Report Date', bug.reportDate ? formatDate(bug.reportDate) : '-')}
          ${sideField('Jumlah Retest', retestCount ? `${retestCount}x (Reopened)` : 'Belum pernah')}
        </div>
      </div>`;

    this.renderChat(bug);
    document.getElementById('bugChatSendBtn').onclick = () => this.addComment(bug.id);
    const overlay = document.getElementById('bugDetailModalOverlay');
    const box = this._detailBox || (this._detailBox = overlay.querySelector('.modal'));
    box.classList.toggle('as-page', asPage);
    // Close / Tutup: the popup just hides (generic [data-close]); the page goes back to the list.
    box.querySelectorAll('[data-close]').forEach(btn => { btn.onclick = asPage ? () => App.goTo('bugreport') : null; });
    if (asPage){
      document.getElementById('page-bugdetail').appendChild(box);
      overlay.classList.remove('active');
    } else {
      if (App.state.currentPage === 'bugdetail') App.goTo('bugreport'); // e.g. global search: don't leave an empty page behind
      overlay.appendChild(box);
      overlay.classList.add('active');
    }
  },

  /* Bug ID as a real link to its detail page (Jira-style): right-click → copy link,
     ctrl/middle-click → new tab. */
  bugKeyLink(bug){
    return `<a class="bug-key" href="${escapeHtml(App.bugLink(bug))}" draggable="false" data-bug-key="${escapeHtml(bug.id)}">${escapeHtml(bugCode(bug))}</a>`;
  },
  // In the list / board a plain click opens the popup, not the page.
  bindBugKeyLinks(root){
    root.querySelectorAll('a[data-bug-key]').forEach(a => {
      a.onclick = e => {
        e.stopPropagation();
        if (e.ctrlKey || e.metaKey || e.shiftKey) return; // browser opens it in a new tab/window
        e.preventDefault();
        this.openDetail(a.dataset.bugKey);
      };
    });
  },

  setChatTab(tab, bug){
    this.ui.chatTab = tab;
    document.querySelectorAll('#bugChatTabs .bug-chat-tab').forEach(el => {
      el.classList.toggle('active', el.dataset.chatTab === tab);
    });
    this.renderChat(bug);
  },

  /* Merges status-change activity + chat comments into one timeline, sorted by time,
     filtered by the active tab (All / Comments / Activity — Jira-style). */
  renderChat(bug){
    const list = document.getElementById('bugChatList');
    const tab = this.ui.chatTab;
    // Writing is only for the Comments tab; All / Activity are read-only timelines.
    const composer = document.querySelector('.bug-chat-composer');
    if (composer) composer.style.display = tab === 'comment' ? '' : 'none';
    let feed = [
      ...(bug.activity || []).map(a => ({ type:'activity', at:a.at, from:a.from, to:a.to, note:a.note, attachment:a.attachment, email:a.email })),
      ...(bug.comments || []).map(c => ({ type:'comment', at:c.at, email:c.email, text:c.text }))
    ].sort((a,b) => new Date(a.at) - new Date(b.at));
    if (tab !== 'all') feed = feed.filter(item => item.type === tab);
    // All / Activity read as a history: newest on top. Comments stay chat-style (newest at the bottom, by the composer).
    const newestFirst = tab !== 'comment';
    if (newestFirst) feed.reverse();

    if (!feed.length){
      const emptyLabel = tab === 'comment' ? 'Belum ada komentar.' : tab === 'activity' ? 'Belum ada aktivitas.' : 'Belum ada aktivitas atau pesan.';
      list.innerHTML = `<p class="text-faint" style="font-size:12.5px;">${emptyLabel}</p>`;
      return;
    }

    list.innerHTML = feed.map(item => {
      if (item.type === 'activity'){
        return `<div class="bug-chat-notice">🔄 Status berubah <b>${escapeHtml(item.from)}</b> → <b>${escapeHtml(item.to)}</b>${item.email ? ` oleh ${escapeHtml(item.email)}` : ''} · ${formatDateTime(item.at)}${item.note ? `<div class="bug-chat-note">${linkify(item.note)}</div>` : ''}${item.attachment ? `<div class="bug-chat-note">📎 ${linkify(item.attachment)}</div>` : ''}</div>`;
      }
      const textHtml = escapeHtml(item.text).replace(/\n/g, '<br>')
        .replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener">$1</a>');
      return `
        <div class="bug-chat-msg">
          <span class="bug-chat-author">${escapeHtml(item.email)}<span class="bug-chat-time">${formatDateTime(item.at)}</span></span>
          <div class="bug-chat-text">${textHtml}</div>
        </div>
      `;
    }).join('');
    list.scrollTop = newestFirst ? 0 : list.scrollHeight;
  },

  addComment(id){
    const input = document.getElementById('bugChatInput');
    const text = input.value.trim();
    if (!text) return;
    const bug = this.all().find(b => b.id === id);
    if (!bug) return;
    if (!bug.comments) bug.comments = [];
    bug.comments.push({ at: nowISO(), email: Auth.currentEmail() || 'unknown', text });
    App.saveBugs();
    input.value = '';
    this.renderChat(bug);
  },

  severityBadge(sev){ return `<span class="badge sev-${sev.toLowerCase()}"><span class="dot"></span>${sev}</span>`; },
  /* Status options always come from Settings > Master > Status Bug Report.
     A bug still holding a status that's no longer in the master (legacy data)
     keeps it as an extra option, so opening/saving it doesn't silently change it. */
  statusOptions(selected = '', extra = []){
    const list = [...this.STATUS];
    [selected, ...extra].forEach(v => { if (v && !list.includes(v)) list.push(v); });
    return list.map(v => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  },

  statusBadge(status){
    const m = this.statusMaster().find(s => s.name === status);
    if (m && m.color) return `<span class="badge" style="color:${m.color}; background:color-mix(in srgb, ${m.color} 14%, transparent);">${escapeHtml(status)}</span>`;
    const map = { 'Open':'open','Assigned':'assigned','In Progress':'inprogress','Ready To Test':'readytotest','Reopened':'reopened','Closed':'closed' };
    return `<span class="badge bug-${map[status] || 'open'}">${escapeHtml(status)}</span>`;
  },

  renderFilterOptions(){
    const build = (id, field) => {
      const el = document.getElementById(id);
      const current = this.ui.filters[field];
      el.innerHTML = `<option value="">${el.dataset.label}</option>` +
        this.uniqueValues(field).map(v => `<option value="${escapeHtml(v)}" ${v===current?'selected':''}>${escapeHtml(v)}</option>`).join('');
    };
    build('bugFilterModule', 'module');
    build('bugFilterTester', 'tester');
    const statusEl = document.getElementById('bugFilterStatus');
    statusEl.innerHTML = `<option value="">${statusEl.dataset.label}</option>` +
      this.statusOptions(this.ui.filters.status, this.uniqueValues('status'));
    document.getElementById('bugBulkStatusSelect').innerHTML = `<option value="">Ubah status ke...</option>` + this.statusOptions();
  },

  resetFilters(){
    this.ui.filters = { module:'', severity:'', priority:'', status:'', tester:'' };
    this.ui.page = 1;
    document.getElementById('bugFilterSeverity').value = '';
    document.getElementById('bugFilterPriority').value = '';
    document.getElementById('bugFilterStatus').value = '';
    this.render();
  },

  renderPagination(totalPages){
    const el = document.getElementById('bugPagination');
    let html = `<button ${this.ui.page===1?'disabled':''} data-pg="prev">‹</button>`;
    for (let i=1;i<=totalPages;i++){
      if (totalPages > 7 && Math.abs(i-this.ui.page) > 2 && i!==1 && i!==totalPages){
        if (i === 2 || i === totalPages-1) html += `<span>…</span>`;
        continue;
      }
      html += `<button class="${i===this.ui.page?'active':''}" data-pg="${i}">${i}</button>`;
    }
    html += `<button ${this.ui.page===totalPages?'disabled':''} data-pg="next">›</button>`;
    el.innerHTML = html;
    el.querySelectorAll('button[data-pg]').forEach(b => b.addEventListener('click', () => {
      const v = b.dataset.pg;
      if (v==='prev') this.ui.page--; else if (v==='next') this.ui.page++; else this.ui.page = parseInt(v,10);
      this.render();
    }));
  },

  bindRowEvents(){
    // Click anywhere on a row opens the detail; checkbox / action menu keep their own behaviour.
    document.querySelectorAll('#bugTableBody tr[data-id]').forEach(tr => {
      tr.onclick = e => { if (!e.target.closest('input, button, a, .dropdown')) this.openDetail(tr.dataset.id); };
    });
    this.bindBugKeyLinks(document.getElementById('bugTableBody'));
    document.querySelectorAll('.bug-row-check').forEach(cb => {
      cb.onchange = () => { cb.checked ? this.ui.selected.add(cb.dataset.id) : this.ui.selected.delete(cb.dataset.id); this.render(); };
    });
    document.querySelectorAll('#bugTableBody button[data-act]').forEach(btn => {
      btn.onclick = () => {
        const { act, id } = btn.dataset;
        if (act === 'view') this.openDetail(id);
        if (act === 'edit') this.openForm(id);
        if (act === 'del') this.remove(id);
        if (act === 'print') this.printOne(id);
      };
    });
  },

  /* ---- Form: openForm(bugId, prefillTestCaseId) ----
     - bugId set => editing existing bug
     - prefillTestCaseId set (from "Create Bug" on a Failed test case) => new bug pre-linked */
  TC_FIELDS: ['module', 'scenario', 'preconditions', 'testData'],               // auto-filled, stay editable
  TC_COPIES: { useTcSteps: 'stepsRef', useTcExpected: 'expectedResultRef' },    // "Dari test case" checkbox -> textarea

  // <select> options; a value from old data that's no longer in the list stays selectable.
  fillSelect(select, options, selected = '', placeholder = ''){
    const list = [...options];
    if (selected && !list.includes(selected)) list.push(selected);
    select.innerHTML = (placeholder ? `<option value="">${escapeHtml(placeholder)}</option>` : '') +
      list.map(v => `<option value="${escapeHtml(v)}" ${v === selected ? 'selected' : ''}>${escapeHtml(v)}</option>`).join('');
  },

  openForm(bugId = null, prefillTestCaseId = null){
    const bug = bugId ? this.all().find(b => b.id === bugId) : null;
    const canFull = Auth.can('bugreport_update');
    const canLimited = Auth.can('bugreport_updateStatusPriority');
    if (!bug && !Auth.can('bugreport_create')){ Toast.show('Tidak punya izin membuat Bug Report.', 'error'); return; }
    if (bug && !canFull && !canLimited){ Toast.show('Tidak punya izin mengedit Bug Report.', 'error'); return; }
    this.ui.limitedEdit = !!(bug && !canFull && canLimited);

    this.ui.editingId = bugId;
    this.ui.formTcId = null;
    this.ui.tcEdited = new Set(); // TC_FIELDS the tester typed in — a test case never overwrites them
    const f = document.getElementById('bugForm');
    f.reset();
    this.clearFormErrors();
    document.getElementById('bugSimilarInfo').hidden = true;
    f.assignee.innerHTML = Auth.userOptions(bug ? bug.assignee : '');
    if (bug) this.ui.activeFileId = bug.fileId;
    else if (prefillTestCaseId){
      const tc = App.state.testcases.find(t => t.id === prefillTestCaseId);
      if (tc) this.ui.activeFileId = tc.fileId;
    }

    document.getElementById('bugModalTitle').textContent = bug ? `Edit Bug — ${bugCode(bug)}` : 'Buat Bug Report';
    document.getElementById('bugFieldId').value = bug ? bugCode(bug) : '(auto generate, nomor per workspace)';
    document.getElementById('bugFieldDate').value = formatDateTime(bug ? bug.reportDate : nowISO());

    this.fillSelect(f.priority, BUG_FORM.PRIORITIES, bug ? bug.priority : 'Medium');
    this.fillSelect(f.environment, BUG_FORM.ENVIRONMENTS, bug ? bug.environment : '', '— Pilih Environment —');
    // Bugs saved before Platform existed: infer it from Browser / Device (not written back until saved).
    const platform = bug ? (bug.platform || (bug.device && !bug.browser ? 'Mobile App' : bug.browser ? 'Web' : '')) : '';
    this.fillSelect(f.platform, BUG_FORM.PLATFORMS, platform, '— Pilih Platform —');

    if (bug){
      this.TC_FIELDS.forEach(name => { f[name].value = bug[name] || ''; this.ui.tcEdited.add(name); }); // the bug's own snapshot
      f.stepsRef.value = stepsHtmlToText(bug.steps || ''); f.expectedResultRef.value = bug.expectedResult || '';
      f.title.value = bug.title || ''; f.description.value = bug.description || '';
      f.actualResult.value = bug.actualResult || '';
      f.severity.value = bug.severity;
      f.status.innerHTML = this.statusOptions(bug.status);
      f.browser.value = bug.browser || ''; f.os.value = bug.os || ''; f.device.value = bug.device || '';
      f.buildVersion.value = bug.buildVersion || '';
      f.attachments.value = bug.attachments || ''; f.tester.value = bug.tester || '';
      this.applyTestCase(bug.testCaseId || null, { restore: { useTcSteps: !!bug.useTcSteps, useTcExpected: !!bug.useTcExpected } });
    } else {
      f.severity.value = 'Medium';
      f.status.innerHTML = this.statusOptions(); // first status in master order
      f.tester.value = Auth.currentEmail() || '';
      this.applyTestCase(prefillTestCaseId || null);
      // Actual result the tester wrote when running the test case — still editable.
      const tc = App.state.testcases.find(t => t.id === prefillTestCaseId);
      if (tc) f.actualResult.value = tc.actualResult || '';
    }
    f.description.closest('.field').hidden = !f.description.value; // shown once it has text (AI analysis / old bugs)
    // Already linked to a test case (editing a linked bug, or "Create Bug" from a
    // test case): lock the picker so the link — and the fields it filled — can't change.
    const trigger = document.getElementById('bugTestCaseTrigger');
    trigger.disabled = !!(bug ? bug.testCaseId : prefillTestCaseId);
    trigger.title = trigger.disabled ? 'Test case sudah terkait dan tidak bisa diganti' : '';
    document.getElementById('bugTestCaseDropdown').classList.remove('open'); // don't carry an open picker over from the last form
    this.applyFormFieldLock();
    // A new bug always starts at the first status of the lifecycle.
    if (!bug){ f.status.disabled = true; f.status.title = 'Bug baru selalu mulai dari status ini'; }
    this.updatePlatformFields();
    this.render();
    this.ui.formSnapshot = this.formSnapshot();
    document.getElementById('bugModalOverlay').classList.add('active');
    if (!bug && prefillTestCaseId) this.aiAnalyze(prefillTestCaseId);
  },
  // Failed test case -> AI drafts title / severity / priority / analysis from its actual
  // result. Only fills what the tester hasn't typed; they review it before saving.
  async aiAnalyze(tcId){
    const tc = App.state.testcases.find(t => t.id === tcId);
    if (!tc || !String(tc.actualResult || '').trim()) return;
    const f = document.getElementById('bugForm');
    const titleHint = f.title.placeholder;
    f.title.placeholder = '✨ AI sedang menganalisa...';
    try{
      const res = await fetch(`${API_BASE}/bug/analyze`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          apiKey: App.state.settings.geminiApiKey || undefined,
          testcase: { module: tc.module, scenario: tc.scenario, testCase: tc.testCase, preconditions: tc.preconditions,
            steps: stepsHtmlToText(tc.steps || ''), testData: tc.testData, expectedResult: tc.expectedResult, actualResult: tc.actualResult }
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analisa gagal');
      // The tester may have closed the form or opened another one while waiting.
      if (this.ui.editingId || this.ui.formTcId !== tcId || !document.getElementById('bugModalOverlay').classList.contains('active')) return;
      if (data.title && !f.title.value.trim()) f.title.value = data.title;
      if (data.severity) f.severity.value = data.severity;
      if (data.priority) f.priority.value = data.priority;
      if (data.analysis && !f.description.value.trim()){
        f.description.value = data.analysis;
        f.description.closest('.field').hidden = false;
      }
      Toast.show('Draft bug dari AI terisi — cek lalu simpan.', 'success');
    }catch(e){
      Toast.show(`Analisa AI gagal (${e.message}). Isi manual.`, 'error');
    }finally{
      f.title.placeholder = titleHint;
    }
  },
  closeForm(){ document.getElementById('bugModalOverlay').classList.remove('active'); },
  formSnapshot(){
    return JSON.stringify([...document.getElementById('bugForm').elements].filter(el => el.name).map(el => el.type === 'checkbox' ? el.checked : el.value));
  },
  // Batal / ✕: ask before throwing away what was typed.
  async requestCloseForm(){
    if (this.formSnapshot() !== this.ui.formSnapshot && !(await confirmDialog('Buang perubahan?', 'Isian form bug report yang belum disimpan akan hilang.', 'Buang'))) return;
    this.closeForm();
  },

  /* Limited editors (bugreport_updateStatusPriority without full bugreport_update)
     can only change Status & Priority — every other field is disabled. */
  applyFormFieldLock(){
    const f = document.getElementById('bugForm');
    const keepEnabled = ['status', 'priority'];
    Array.from(f.elements).forEach(el => {
      if (!el.name) return;
      el.disabled = this.ui.limitedEdit && !keepEnabled.includes(el.name);
    });
  },

  // Browser only for Web, Device only for Mobile App.
  updatePlatformFields(){
    const show = BUG_FORM.conditionalFields(document.getElementById('bugForm').platform.value);
    document.getElementById('bugBrowserField').hidden = !show.browser;
    document.getElementById('bugDeviceField').hidden = !show.device;
    document.getElementById('bugPlatformDetailRow').hidden = !show.browser && !show.device;
  },

  /* ---- Test Case combobox (searchable, replaces a plain <select> so long
     test case lists stay usable) ---- */
  setTestCase(tcId){ this.applyTestCase(tcId, { silent: false }); },
  renderTestCaseList(query){
    const listEl = document.getElementById('bugTestCaseList');
    const q = query.trim().toLowerCase();
    const all = App.state.testcases;
    const filtered = q ? all.filter(t => tcCode(t).toLowerCase().includes(q) || (t.scenario||'').toLowerCase().includes(q) || (t.testCase||'').toLowerCase().includes(q) || (t.module||'').toLowerCase().includes(q)) : all;
    const noneItem = `<div class="dropdown-item combobox-option" data-tc="">— Tidak terkait Test Case —</div>`;
    if (!filtered.length){
      listEl.innerHTML = noneItem + `<div class="combobox-empty"><p>Test case tidak ditemukan.</p></div>`;
    } else {
      listEl.innerHTML = noneItem + filtered.map(t => `<div class="dropdown-item combobox-option" data-tc="${escapeHtml(t.id)}">${escapeHtml(tcCode(t))} —${escapeHtml(t.scenario||'').slice(0,60)}</div>`).join('');
    }
    listEl.querySelectorAll('[data-tc]').forEach(el => {
      el.addEventListener('click', () => {
        this.setTestCase(el.dataset.tc || null);
        document.getElementById('bugTestCaseDropdown').classList.remove('open');
      });
    });
  },
  openTestCaseCombobox(){
    document.getElementById('bugTestCaseSearch').value = '';
    this.renderTestCaseList('');
  },

  // The test case's value for a form field, as plain text.
  tcValue(tc, name){
    if (!tc) return '';
    if (name === 'stepsRef') return stepsHtmlToText(tc.steps || '');
    if (name === 'expectedResultRef') return String(tc.expectedResult || '');
    return String(tc[name] || '');
  },

  /* Apply the chosen test case (or none) to the form:
     - Module / Scenario / Pre-condition / Test Data are filled unless the tester
       already typed in them; clearing the test case leaves them as they are.
     - Steps / Expected Result follow their "Dari test case" checkbox: shown only
       when the test case has that data, ticked (filled + locked) when it first
       appears; a test case change only refreshes a ticked one.
     restore = saved checkbox states when opening an existing bug: its saved text
     is shown as-is (a snapshot), never refreshed from the test case. */
  applyTestCase(tcId, { restore = null, silent = true } = {}){
    const f = document.getElementById('bugForm');
    const tc = tcId ? App.state.testcases.find(t => t.id === tcId) : null;
    document.getElementById('bugTestCaseSelect').value = tc ? tc.id : '';
    const label = document.getElementById('bugTestCaseTriggerText');
    label.textContent = tc ? `${tcCode(tc)} — ${(tc.scenario || '').slice(0,60)}` : '— Tidak terkait Test Case —';
    label.classList.toggle('text-faint', !tc);
    this.ui.formTcId = tc ? tc.id : null;

    if (tc && !restore) this.TC_FIELDS.forEach(name => { if (!this.ui.tcEdited.has(name)) f[name].value = this.tcValue(tc, name); });
    Object.entries(this.TC_COPIES).forEach(([flag, name]) => {
      const box = f[flag], wrap = box.closest('.tc-copy-check'), el = f[name];
      const src = this.tcValue(tc, name);
      const wasHidden = wrap.hidden;
      wrap.hidden = !src;
      el.placeholder = tc && !src ? `Test case ini tidak memiliki ${flag === 'useTcSteps' ? 'test steps' : 'expected result'}` : (el.dataset.placeholder || '');
      if (!src){ box.checked = false; this.setCopyLocked(name, false); return; }
      if (restore){ box.checked = restore[flag]; this.setCopyLocked(name, box.checked); return; }
      if (wasHidden || box.checked){ box.checked = true; this.copyFromTestCase(name, src); }
    });
    this.refreshTcHints();
    if (tc && !silent) Toast.show('Field Test Case otomatis terisi.', 'info', { duration: 1800 });
  },
  setCopyLocked(name, locked){
    const el = document.getElementById('bugForm')[name];
    el.readOnly = locked;
    el.classList.toggle('tc-locked', locked);
    // Locked text can still be selected / copied; only the checkbox unlocks it.
    el.title = locked ? 'Hilangkan centang "Dari test case" untuk mengedit' : '';
  },
  // Puts the test case's text in the textarea (locked); overwriting different text can be undone.
  copyFromTestCase(name, src){
    const f = document.getElementById('bugForm'), el = f[name];
    const flag = Object.keys(this.TC_COPIES).find(k => this.TC_COPIES[k] === name);
    const prev = el.value;
    el.value = src;
    this.setCopyLocked(name, true);
    if (prev.trim() && prev !== src){
      Toast.show('Diganti dengan data dari test case', 'info', { duration: 5000, undo: () => {
        el.value = prev; f[flag].checked = false; this.setCopyLocked(name, false);
      } });
    }
  },
  // "Diubah dari test case" under an auto-filled field whose text differs from the linked test case.
  refreshTcHints(){
    const f = document.getElementById('bugForm');
    const tc = App.state.testcases.find(t => t.id === this.ui.formTcId);
    this.TC_FIELDS.forEach(name => {
      f[name].closest('.field').querySelector('.field-hint').hidden = !(tc && f[name].value !== this.tcValue(tc, name));
    });
  },

  // "Bug serupa ditemukan": open bugs in the visible workspace with a similar title (never blocks saving).
  showSimilar(){
    const f = document.getElementById('bugForm'), box = document.getElementById('bugSimilarInfo');
    const closed = this.STATUS.filter(s => this.statusCode(s) === 'CLOSED');
    const matches = BUG_FORM.similar(f.title.value, this.all().filter(b => b.id !== this.ui.editingId), closed.length ? closed : ['Closed']).slice(0, 3);
    box.hidden = !matches.length;
    box.innerHTML = matches.map(b => `Bug serupa ditemukan: ${this.bugKeyLink(b)} — ${escapeHtml(b.title)}`).join('<br>');
    this.bindBugKeyLinks(box);
  },

  clearFormErrors(){
    const f = document.getElementById('bugForm');
    f.querySelectorAll('.field-error').forEach(el => el.remove());
    f.querySelectorAll('.input-invalid').forEach(el => el.classList.remove('input-invalid'));
  },
  // One message under each invalid field, then scroll to the first.
  showFormErrors(errors){
    this.clearFormErrors();
    let first = null;
    Object.entries(errors).forEach(([key, msg]) => {
      const field = document.querySelector(`#bugForm [data-field="${key}"]`);
      if (!field) return;
      const control = field.querySelector('input:not([type="checkbox"]), textarea, select');
      if (control) control.classList.add('input-invalid');
      const p = document.createElement('p');
      p.className = 'field-error';
      p.textContent = msg;
      field.appendChild(p);
      if (!first) first = control || field;
    });
    if (first){ first.scrollIntoView({ block: 'center', behavior: 'smooth' }); first.focus({ preventScroll: true }); }
  },

  async submitForm(e){
    e.preventDefault();
    if (this.ui.saving) return; // no double submit
    const f = e.target;
    const creating = !this.ui.editingId;
    const show = BUG_FORM.conditionalFields(f.platform.value);
    const linked = !!f.testCaseId.value;
    const data = {
      testCaseId: f.testCaseId.value || null,
      module: f.module.value.trim(), scenario: f.scenario.value.trim(),
      preconditions: f.preconditions.value.trim(), testData: f.testData.value.trim(),
      // Snapshot text, not a reference: editing the test case later doesn't change the bug.
      steps: textToStepsHtml(f.stepsRef.value), expectedResult: f.expectedResultRef.value.trim(),
      useTcSteps: linked && f.useTcSteps.checked, useTcExpected: linked && f.useTcExpected.checked,
      tester: f.tester.value.trim(),
      title: f.title.value.trim(), description: f.description.value.trim(), actualResult: f.actualResult.value.trim(),
      severity: f.severity.value, priority: f.priority.value, status: f.status.value,
      environment: f.environment.value, buildVersion: f.buildVersion.value.trim(),
      platform: f.platform.value, os: f.os.value.trim(),
      // A new bug doesn't keep Browser / Device its platform doesn't use.
      browser: (show.browser || !creating) ? f.browser.value.trim() : '',
      device: (show.device || !creating) ? f.device.value.trim() : '',
      attachments: f.attachments.value.trim(),
      assignee: f.assignee.value
    };
    const errors = this.ui.limitedEdit ? {} : BUG_FORM.errors({ ...data, steps: f.stepsRef.value }, creating);
    if (Object.keys(errors).length){ this.showFormErrors(errors); return; }

    const btn = document.getElementById('bugFormSubmitBtn');
    this.ui.saving = true; btn.disabled = true; btn.textContent = 'Menyimpan…';
    try{
      if (!creating){
        const idx = App.state.bugs.findIndex(b => b.id === this.ui.editingId);
        const prev = App.state.bugs[idx];
        let change = null;
        if (prev.status !== data.status){
          change = await this.confirmStatusChange([prev], data.status, `${bugCode(prev)}: ${prev.status} → ${data.status}`);
          if (!change) return; // form stays open so nothing typed is lost
          this.logActivity(prev, prev.status, data.status, change);
        }
        Auth.logAssignment(prev, prev.assignee, data.assignee);
        App.state.bugs[idx] = { ...prev, ...data };
        await App.saveBugs();
        ActivityLog.record('bugreport_update', `Bug ${bugCode(prev)} diperbarui${change ? ` (status ${prev.status} → ${data.status}${change.note ? `: ${change.note}` : ''})` : ''}`);
        Toast.show(`Bug ${bugCode(prev)} diperbarui.`, 'success');
      } else {
        const bug = { id: IdGen.uid('BUG'), code: this.nextCode(this.ui.activeFileId), ...data, fileId: this.ui.activeFileId, reportDate: nowISO() };
        Auth.logAssignment(bug, '', data.assignee);
        App.state.bugs.push(bug);
        const saved = await App.saveBugs();
        if (!saved && Storage.serverOnline){
          // Rejected by the server (validation / no access; Storage already showed why): drop it, keep the form.
          App.state.bugs.splice(App.state.bugs.indexOf(bug), 1);
          App.saveBugs();
          return;
        }
        // Offline / network drop: kept locally and re-sent by Storage — the bug isn't lost.
        ActivityLog.record('bugreport_create', `Bug ${bug.code} dibuat`);
        // TODO: notify the workspace QA Lead when severity is Critical — there's no QA Lead role yet and the
        // bell (notifications.js) only derives events from bug data; the assignee is already notified.
        Toast.show(`Bug report ${bug.code} berhasil dibuat`, 'success');
      }
      this.closeForm();
      this.render();
    } finally {
      this.ui.saving = false; btn.disabled = false; btn.textContent = 'Simpan Bug Report';
    }
  },

  async remove(id){
    if (!Auth.can('bugreport_delete')){ Toast.show('Tidak punya izin menghapus Bug Report.', 'error'); return; }
    const code = bugCode(App.state.bugs.find(b => b.id === id));
    const ok = await confirmDialog('Hapus Bug Report?', `${code} akan dihapus.`);
    if (!ok) return;
    const idx = App.state.bugs.findIndex(b => b.id === id);
    const removed = App.state.bugs.splice(idx,1)[0];
    ActivityLog.record('bugreport_delete', `Bug ${code} dihapus`);
    App.saveBugs(); this.ui.selected.delete(id); this.render();
    Toast.show(`${code} dihapus.`, 'info', { undo: () => { App.state.bugs.splice(idx,0,removed); App.saveBugs(); this.render(); } });
  },

  async bulkDelete(){
    if (!this.ui.selected.size || !Auth.can('bugreport_delete')) return;
    const ids = [...this.ui.selected];
    const ok = await confirmDialog('Hapus Bug Terpilih?', `${ids.length} bug akan dihapus.`);
    if (!ok) return;
    const removed = App.state.bugs.filter(b => ids.includes(b.id));
    App.state.bugs = App.state.bugs.filter(b => !ids.includes(b.id));
    ActivityLog.record('bugreport_delete', `${ids.length} bug dihapus (bulk)`);
    App.saveBugs(); this.ui.selected.clear(); this.render();
    Toast.show(`${ids.length} bug dihapus.`, 'info', { undo: () => { App.state.bugs.push(...removed); App.saveBugs(); this.render(); } });
  },

  async bulkUpdateStatus(status){
    if (!this.ui.selected.size || !status) return;
    const change = await this.confirmStatusChange(this.all().filter(b => this.ui.selected.has(b.id)), status, `${this.ui.selected.size} bug → ${status}`);
    if (!change) return;
    let changed = 0;
    App.state.bugs.forEach(b => {
      if (this.ui.selected.has(b.id) && b.status !== status){
        this.logActivity(b, b.status, status, change);
        b.status = status;
        changed++;
      }
    });
    App.saveBugs(); this.render();
    if (changed) ActivityLog.record('bugreport_update', `${changed} bug status diubah menjadi ${status} (bulk)${change.note ? `: ${change.note}` : ''}`);
    Toast.show(`Status ${this.ui.selected.size} bug diubah menjadi ${status}.`, 'success');
  },

  printOne(id){
    App.goTo('bugreport');
    this.openForm(id);
    setTimeout(() => window.print(), 200);
  },

  /* ---- Export ---- */
  exportExcel(){
    const rows = this.filtered().map(b => ({
      'Bug ID': bugCode(b), 'Test Case ID': this.tcLabel(b.testCaseId), Module: b.module,
      Scenario: b.scenario, 'Pre-condition': b.preconditions || '', 'Test Data': b.testData || '',
      'Bug Title': b.title, 'Impact / Catatan Tambahan': b.description,
      'Expected Result': b.expectedResult, 'Actual Result': b.actualResult,
      Severity: b.severity, Priority: b.priority, Status: b.status, Tester: b.tester,
      Date: formatDate(b.reportDate), Environment: b.environment, Platform: b.platform || '', Browser: b.browser, OS: b.os, Device: b.device || '',
      Attachment: b.attachments || '',
      'Build Version': b.buildVersion
    }));
    const ws = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Bug Reports');
    XLSX.writeFile(wb, `BugReports_${todayISO()}.xlsx`);
    ActivityLog.record('bugreport_export', `${rows.length} bug di-export ke Excel`);
    Toast.show('Export Excel Bug Report berhasil.', 'success');
  },
  exportCSV(){
    const cols = [
      {key:'code',label:'Bug ID'},{key:'testCaseId',label:'Test Case ID'},{key:'module',label:'Module'},
      {key:'scenario',label:'Scenario'},{key:'title',label:'Bug Title'},
      {key:'preconditions',label:'Pre-condition'},{key:'testData',label:'Test Data'},
      {key:'description',label:'Impact / Catatan Tambahan'},{key:'expectedResult',label:'Expected Result'},
      {key:'actualResult',label:'Actual Result'},{key:'severity',label:'Severity'},{key:'priority',label:'Priority'},
      {key:'status',label:'Status'},{key:'tester',label:'Tester'},{key:'reportDate',label:'Date'},
      {key:'environment',label:'Environment'},{key:'platform',label:'Platform'},{key:'browser',label:'Browser'},{key:'os',label:'OS'},{key:'device',label:'Device'},
      {key:'attachments',label:'Attachment'},{key:'buildVersion',label:'Build Version'}
    ];
    downloadBlob(arrayToCSV(this.filtered().map(b => ({ ...b, code: bugCode(b), testCaseId: this.tcLabel(b.testCaseId) })), cols), `BugReports_${todayISO()}.csv`, 'text/csv');
    ActivityLog.record('bugreport_export', `${this.filtered().length} bug di-export ke CSV`);
    Toast.show('Export CSV Bug Report berhasil (siap import ke Google Spreadsheet).', 'success');
  },

  /* ---- Import (Excel/CSV) ---- */
  importFile(file){
    if (!Auth.can('bugreport_create')) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      try{
        const wb = XLSX.read(e.target.result, { type: 'array' });
        // Read every sheet (same as Test Case import). A row with an empty Module
        // takes the sheet's name, unless it's a generic "Sheet1"/"Template".
        let count = 0, sheetsUsed = 0;
        const unknownTc = new Set();
        wb.SheetNames.forEach(sheetName => {
          const rows = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });
          const sheetModule = /^(sheet\s*\d*|template)$/i.test(sheetName.trim()) ? '' : sheetName.trim();
          const before = count;
          rows.forEach(raw => {
            // Template headers mark required columns with "*": "Bug Title *" -> "Bug Title".
            const r = {};
            Object.keys(raw).forEach(k => { r[k.replace(/\s*\*\s*$/, '').trim()] = typeof raw[k] === 'string' ? raw[k].trim() : raw[k]; });
            const tcRef = String(r['Test Case ID'] || r.testCaseId || '').trim();
            const testCaseId = this.tcIdFromCode(tcRef);
            if (tcRef && !testCaseId) unknownTc.add(tcRef);
            const tc = testCaseId ? App.state.testcases.find(t => t.id === testCaseId) : null; // same auto-fill as the form
            const title = r['Bug Title'] || r.title;
            // Blank Actual Result: take the one written when the test case was run.
            const actualResult = r['Actual Result'] || r.actualResult || (tc && tc.actualResult) || '';
            if (!title || !actualResult) return;
            // Text identical to the test case (pre-filled template) counts as "from the test case".
            const same = (v, src) => tc && String(v || '').trim() === String(src || '').trim();
            let ownSteps = r['Test Steps'] || r.steps, ownExpected = r['Expected Result'] || r.expectedResult;
            if (same(ownSteps, stepsHtmlToText(tc ? tc.steps || '' : ''))) ownSteps = '';
            if (same(ownExpected, tc && tc.expectedResult)) ownExpected = '';
            const statuses = this.STATUS;
            const status = statuses.includes(r.Status || r.status) ? (r.Status || r.status) : (statuses[0] || 'Open');
            const bug = {
              id: IdGen.uid('BUG'), code: this.nextCode(this.ui.activeFileId), testCaseId,
              module: String(r.Module || r.module || (tc && tc.module) || sheetModule).trim(),
              scenario: r.Scenario || r.scenario || (tc && tc.scenario) || '',
              preconditions: r['Pre-condition'] || r.preconditions || (tc && tc.preconditions) || '',
              testData: r['Test Data'] || r.testData || (tc && tc.testData) || '',
              expectedResult: ownExpected || (tc && tc.expectedResult) || '',
              steps: ownSteps ? textToStepsHtml(ownSteps) : ((tc && tc.steps) || ''),
              // Copied from the test case = the form's "Dari test case" ticks.
              useTcSteps: !!(tc && !ownSteps && tc.steps), useTcExpected: !!(tc && !ownExpected && tc.expectedResult),
              tester: r.Tester || r.tester || Auth.currentEmail() || '', title, description: r.Description || r.description || '',
              actualResult, severity: r.Severity || r.severity || 'Medium',
              priority: r.Priority || r.priority || 'Medium', status,
              assignee: r['Assign ke'] || r.assignee || '',
              environment: r.Environment || r.environment || '', browser: r.Browser || r.browser || '',
              os: r.OS || r.os || '', device: r.Device || r.device || '',
              buildVersion: r['Build Version'] || r.buildVersion || '', attachments: r.Attachment || r.attachments || '',
              fileId: this.ui.activeFileId, reportDate: nowISO()
            };
            Auth.logAssignment(bug, '', bug.assignee); // assignee gets the bell notification
            App.state.bugs.push(bug);
            count++;
          });
          if (count > before) sheetsUsed++;
        });
        App.ensureDefaultFile();
        App.saveBugs();
        ActivityLog.record('bugreport_create', `${count} bug report di-import dari ${sheetsUsed} sheet`);
        this.render();
        Toast.show(`${count} bug report dari ${sheetsUsed} sheet berhasil di-import.`, count ? 'success' : 'info');
        if (unknownTc.size) Toast.show(`Test Case ID tidak ditemukan (bug tetap di-import tanpa link): ${[...unknownTc].slice(0, 5).join(', ')}${unknownTc.size > 5 ? ` +${unknownTc.size - 5}` : ''}`, 'error');
      }catch(err){
        console.error(err);
        Toast.show('Gagal membaca file. Pastikan format sesuai template.', 'error');
      }
    };
    reader.readAsArrayBuffer(file);
  },

  /* Import template: same fields and order as the Bug Report form. Required
     columns end with " *" (importFile() strips it). Dropdown choices are read
     from the form so they stay in sync. */
  IMPORT_COLUMNS: [
    { label:'Test Case ID', key:'testCaseId', width:14 },
    { label:'Module', key:'module', width:16 },
    { label:'Scenario', key:'scenario', width:28 }, { label:'Test Steps', key:'steps', width:30 },
    { label:'Expected Result', key:'expectedResult', width:26 }, { label:'Tester', key:'tester', width:24 },
    { label:'Actual Result *', key:'actualResult', width:28 }, { label:'Bug Title *', key:'title', width:30 },
    { label:'Description', key:'description', width:28 },
    { label:'Severity', key:'severity', width:12, listFrom:'severity' }, { label:'Priority', key:'priority', width:12, listFrom:'priority' },
    { label:'Status', key:'status', width:14, listFrom:'status' }, { label:'Assign ke', key:'assignee', width:26, listFrom:'assignee' },
    { label:'Environment', key:'environment', width:14, listFrom:'environment' },
    { label:'Browser', key:'browser', width:14 }, { label:'OS', key:'os', width:14 },
    { label:'Device', key:'device', width:16 }, { label:'Build Version', key:'buildVersion', width:14 },
    { label:'Attachment', key:'attachments', width:30 }
  ],

  TEMPLATE_FROM_TC_KEYS: ['testCaseId', 'module', 'scenario', 'actualResult', 'title', 'severity', 'priority', 'assignee'],

  async downloadImportTemplate(){
    const formOptions = name => [...document.querySelectorAll(`#bugForm [name="${name}"] option`)].map(o => o.value).filter(Boolean);
    const lists = {
      severity: formOptions('severity'), priority: formOptions('priority'), environment: formOptions('environment'),
      status: this.STATUS, assignee: (App.state.settings.users || []).map(u => u.email).filter(Boolean)
    };
    let cols = this.IMPORT_COLUMNS;
    const sample = {
      module:'Login', scenario:'Login dengan kredensial valid', steps:'1. Buka halaman login\n2. Isi email & password\n3. Klik Login',
      expectedResult:'User masuk ke Dashboard', tester:'',
      actualResult:'Muncul error "Invalid credentials"', title:'Login gagal dengan password valid',
      description:'User tidak bisa login walau kredensial benar', severity: lists.severity[1] || 'High', priority: lists.priority[1] || 'High',
      status: lists.status[0] || 'Open', assignee:'', environment: lists.environment[1] || '', browser:'Chrome 126', os:'Android 14',
      device:'Samsung A54', buildVersion:'v1.2.3', attachments:''
    };

    /* Inside a file: one row per Failed test case that has no bug yet, everything
       filled from the test case — the tester only types the Bug Title (yellow).
       Rows left without a title are skipped on import. */
    const failed = this.ui.activeFileId
      ? App.state.testcases.filter(t => t.fileId === this.ui.activeFileId && t.status === 'Failed' && !App.state.bugs.some(b => b.testCaseId === t.id))
      : [];
    // Failed-test-case template: steps / expected / tester / status come from the
    // test case and the importer on import, so only what a tester checks or types stays.
    if (failed.length) cols = cols.filter(c => this.TEMPLATE_FROM_TC_KEYS.includes(c.key));
    const rows = failed.length ? failed.map(t => ({
      testCaseId: tcCode(t), module: t.module || '', scenario: t.scenario || '', steps: stepsHtmlToText(t.steps || ''),
      expectedResult: t.expectedResult || '', tester: Auth.currentEmail() || '', actualResult: t.actualResult || '', title: '',
      severity: 'Medium', priority: 'Medium', status: lists.status[0] || 'Open'
    })) : [sample];

    // One sheet per module (first-seen order, like the Test Case export); the sample stays one "Template" sheet.
    const byModule = new Map();
    rows.forEach(r => { const m = failed.length ? (r.module || 'Tanpa Module') : 'Template'; byModule.set(m, [...(byModule.get(m) || []), r]); });
    const wb = new ExcelJS.Workbook();
    const usedNames = new Set();
    const thin = { style: 'thin', color: { argb: 'FFB0B7C3' } };
    const titleCol = cols.findIndex(c => c.key === 'title') + 1;
    byModule.forEach((sheetRows, moduleName) => {
      const ws = wb.addWorksheet(TestCaseModule.safeSheetName(moduleName, usedNames));
      ws.columns = cols.map(c => ({ header: c.label, key: c.key, width: c.width }));
      ws.getRow(1).eachCell(cell => {
        cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
        cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF2F5496' } };
        cell.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
      });
      sheetRows.forEach(r => ws.addRow(cols.map(c => r[c.key] ?? '')));
      ws.eachRow(row => {
        row.eachCell(cell => {
          cell.border = { top: thin, left: thin, bottom: thin, right: thin };
          if (cell.row !== 1) cell.alignment = { vertical: 'top', wrapText: true };
        });
      });
      if (failed.length){
        for (let r = 2; r <= sheetRows.length + 1; r++) ws.getCell(r, titleCol).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFFFF2CC' } };
      }
      // Inline dropdowns (Excel caps an inline list at 255 chars — skip one that's longer, e.g. many users).
      cols.forEach((c, i) => {
        const values = c.listFrom && lists[c.listFrom];
        const formula = values && values.length ? `"${values.join(',')}"` : '';
        if (!formula || formula.length > 257) return;
        const letter = ws.getColumn(i + 1).letter;
        for (let r = 2; r <= Math.max(500, sheetRows.length + 1); r++) ws.getCell(`${letter}${r}`).dataValidation = { type: 'list', allowBlank: true, formulae: [formula] };
      });
      ws.views = [{ state: 'frozen', ySplit: 1 }];
    });

    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(buf, 'Template_Import_BugReport.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    Toast.show(failed.length
      ? `Template berisi ${failed.length} test case Failed — cukup isi Bug Title (kolom kuning).`
      : 'Template import Bug Report diunduh.', 'success');
  },

  bindStaticEvents(){
    bindPageSize('bugPageSize', this);
    document.getElementById('bugBackToFilesBtn').addEventListener('click', () => this.backToFiles());
    document.getElementById('bugNewFileBtn').addEventListener('click', async () => {
      if (Auth.isAdmin()){
        const result = await fileCreateDialog(Auth.workspaces());
        if (result) this.createFile(result.name, result.workspaceId);
      } else {
        const name = await promptDialog('File Baru', 'Nama file, misal: Sprint 12', '', 'Buat File');
        if (name) this.createFile(name);
      }
    });
    document.querySelectorAll('#bugChatTabs .bug-chat-tab').forEach(el => {
      el.addEventListener('click', () => {
        const bug = this.all().find(b => b.id === this.ui.detailId);
        if (bug) this.setChatTab(el.dataset.chatTab, bug);
      });
    });
    document.querySelectorAll('#bugViewToggle button[data-view]').forEach(btn => {
      btn.addEventListener('click', () => {
        this.ui.view = btn.dataset.view;
        document.querySelectorAll('#bugViewToggle button').forEach(b => b.classList.toggle('active', b === btn));
        this.render();
      });
    });
    const f = document.getElementById('bugForm');
    f.addEventListener('submit', e => this.submitForm(e));
    document.getElementById('bugFormCancelBtn').addEventListener('click', () => this.requestCloseForm());
    document.getElementById('bugFormCloseX').addEventListener('click', () => this.requestCloseForm());
    f.addEventListener('input', e => {
      const field = e.target.closest('[data-field]');
      if (field){ field.querySelectorAll('.field-error').forEach(el => el.remove()); e.target.classList.remove('input-invalid'); }
      if (this.TC_FIELDS.includes(e.target.name)){ this.ui.tcEdited.add(e.target.name); this.refreshTcHints(); }
    });
    f.platform.addEventListener('change', () => this.updatePlatformFields());
    f.title.addEventListener('input', debounce(() => this.showSimilar(), 500));
    Object.entries(this.TC_COPIES).forEach(([flag, name]) => {
      const el = f[name];
      el.dataset.placeholder = el.placeholder;
      f[flag].addEventListener('change', () => {
        const tc = App.state.testcases.find(t => t.id === this.ui.formTcId);
        if (f[flag].checked) this.copyFromTestCase(name, this.tcValue(tc, name));
        else this.setCopyLocked(name, false); // the copied text stays as a starting point
      });
    });
    document.getElementById('bugTestCaseTrigger').addEventListener('click', () => this.openTestCaseCombobox());
    document.getElementById('bugTestCaseSearch').addEventListener('input', e => this.renderTestCaseList(e.target.value));

    document.getElementById('bugSearchInput').addEventListener('input', debounce(e => this.setSearch(e.target.value), 200));
    document.getElementById('bugSelectAll').addEventListener('change', e => {
      const rows = this.filtered().slice((this.ui.page-1)*this.ui.pageSize, this.ui.page*this.ui.pageSize);
      rows.forEach(r => e.target.checked ? this.ui.selected.add(r.id) : this.ui.selected.delete(r.id));
      this.render();
    });
    ['bugFilterModule','bugFilterSeverity','bugFilterPriority','bugFilterStatus','bugFilterTester'].forEach(id => {
      document.getElementById(id).addEventListener('change', e => {
        const map = { bugFilterModule:'module', bugFilterSeverity:'severity', bugFilterPriority:'priority', bugFilterStatus:'status', bugFilterTester:'tester' };
        this.ui.filters[map[id]] = e.target.value; this.ui.page = 1; this.render();
      });
    });
    document.getElementById('bugFilterResetBtn').addEventListener('click', () => this.resetFilters());
    document.querySelectorAll('#bugTable thead th.sortable').forEach(th => {
      th.addEventListener('click', () => {
        const key = th.dataset.key;
        this.ui.sortDir = (this.ui.sortKey === key && this.ui.sortDir === 'asc') ? 'desc' : 'asc';
        this.ui.sortKey = key; this.render();
      });
    });
    document.getElementById('bugBulkDeleteBtn').addEventListener('click', () => this.bulkDelete());
    document.getElementById('bugBulkStatusSelect').addEventListener('change', e => { this.bulkUpdateStatus(e.target.value); e.target.value=''; });

    document.getElementById('bugExportExcelBtn').addEventListener('click', () => this.exportExcel());
    document.getElementById('bugExportCsvBtn').addEventListener('click', () => this.exportCSV());
    document.getElementById('bugImportTemplateBtn').addEventListener('click', () => this.downloadImportTemplate());
    document.getElementById('bugImportTemplateBtn2').addEventListener('click', () => this.downloadImportTemplate());

    const importOverlay = document.getElementById('bugImportModalOverlay');
    const importDz = document.getElementById('bugImportDropzone');
    const importInput = document.getElementById('bugImportFileInput');
    const importPending = document.getElementById('bugImportPending');
    const importConfirmBtn = document.getElementById('bugImportConfirmBtn');
    let pendingFile = null;

    const stageFile = (file) => {
      if (!file) return;
      pendingFile = file;
      document.getElementById('bugImportFileName').textContent = file.name;
      document.getElementById('bugImportFileSize').textContent = `${(file.size / 1024).toFixed(1)} KB`;
      importDz.style.display = 'none';
      importPending.style.display = 'block';
      importConfirmBtn.style.display = 'inline-flex';
    };
    const resetImportModal = () => {
      pendingFile = null;
      importDz.style.display = 'flex';
      importPending.style.display = 'none';
      importConfirmBtn.style.display = 'none';
    };

    document.getElementById('bugImportBtn').addEventListener('click', () => { resetImportModal(); importOverlay.classList.add('active'); });
    document.getElementById('bugImportCancelBtn').addEventListener('click', resetImportModal);
    importDz.addEventListener('click', () => importInput.click());
    importInput.addEventListener('change', e => { stageFile(e.target.files[0]); e.target.value = ''; });
    ['dragenter','dragover'].forEach(evt => importDz.addEventListener(evt, e => { e.preventDefault(); importDz.classList.add('dragover'); }));
    ['dragleave','drop'].forEach(evt => importDz.addEventListener(evt, e => { e.preventDefault(); importDz.classList.remove('dragover'); }));
    importDz.addEventListener('drop', e => stageFile(e.dataTransfer.files[0]));
    importConfirmBtn.addEventListener('click', () => {
      if (!pendingFile) return;
      this.importFile(pendingFile);
      importOverlay.classList.remove('active');
      resetImportModal();
    });
    document.querySelectorAll('#bugImportModalOverlay [data-close]').forEach(btn => {
      btn.addEventListener('click', () => importOverlay.classList.remove('active'));
    });
  }
};

document.addEventListener('DOMContentLoaded', () => BugReportModule.bindStaticEvents());
