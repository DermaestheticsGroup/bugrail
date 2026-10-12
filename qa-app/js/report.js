/* ==========================================================
   report.js — Go-Live readiness report for PM/BA (read-only):
   go-live verdict with a contextual module / testing-round filter,
   reopen/retest ranking, and a plain-language summary. Bug fix speed
   vs SLA is in the summary text and the PDF only.
   ReportCalc is pure (no DOM) so it can be checked in Node —
   see qa-app/test/report.check.js.
   ========================================================== */

const ReportCalc = {
  // Thresholds — tweak here. ponytail: constants, move to Settings if PM/BA need to change them often.
  GO_PASS_RATE: 95,
  COND_PASS_RATE: 90,
  COND_MAX_HIGH_OPEN: 2,
  SLA_DAYS: { Critical: 1, High: 3, Medium: 7, Low: 14 },
  SPEED_FAST_PCT: 80,
  SPEED_OK_PCT: 50,
  DONE_STATUSES: ['Closed', 'Rejected'],       // Resolved is not done: QA hasn't verified it yet
  REOPEN_STATUSES: ['Reopened', 'Retest'],     // same as BugReportModule.reopenCount

  isOpen(bug){ return !this.DONE_STATUSES.includes(bug.status); },
  moduleOf(x){ return x.module || '(Tanpa Module)'; },
  RISK: { UNRATED: 0, NO_GO: 1, CONDITIONAL: 2, GO: 3 }, // table order: riskiest first

  /* Verdict is judged per module; the app verdict is the worst module
     (one NO GO module = app NO GO). App verdict values:
     EMPTY      — no test case in scope at all (never shown as NO GO)
     INCOMPLETE — some module in scope has no test case; `provisional` = worst rated module
     GO / CONDITIONAL / NO_GO. Totals are kept for cards and summary text. */
  goLive(tcs, bugs){
    const names = [...new Set([...tcs, ...bugs].map(x => this.moduleOf(x)))];
    const modules = names.map(m => ({ module: m, ...this.evaluate(tcs.filter(t => this.moduleOf(t) === m), bugs.filter(b => this.moduleOf(b) === m)) }))
      .sort((a, b) => this.RISK[a.verdict] - this.RISK[b.verdict] || (a.passRate ?? -1) - (b.passRate ?? -1) || a.module.localeCompare(b.module));
    const rated = modules.filter(m => m.verdict !== 'UNRATED');
    const counts = { GO: 0, CONDITIONAL: 0, NO_GO: 0, UNRATED: 0 };
    modules.forEach(m => counts[m.verdict]++);
    const provisional = rated.length ? rated.reduce((w, m) => this.RISK[m.verdict] < this.RISK[w] ? m.verdict : w, 'GO') : null;
    const verdict = !tcs.length ? 'EMPTY' : counts.UNRATED ? 'INCOMPLETE' : provisional;
    return { ...this.evaluate(tcs, bugs), verdict, provisional, modules, counts };
  },

  /* Pass rate = Passed / executed (anything but Open; Blocked counts as attempted).
     null = nothing executed yet — shown as "—", never 0. */
  evaluate(tcs, bugs){
    const total = tcs.length;
    const passed = tcs.filter(t => t.status === 'Passed').length;
    const notRun = tcs.filter(t => t.status === 'Open').length;
    const blocked = tcs.filter(t => t.status === 'Blocked').length;
    const executed = total - notRun;
    const passRate = executed ? Math.round(passed / executed * 1000) / 10 : null;
    const openBugs = bugs.filter(b => this.isOpen(b));
    const openCritical = openBugs.filter(b => b.severity === 'Critical');
    const openHigh = openBugs.filter(b => b.severity === 'High');

    let verdict = 'NO_GO';
    if (!total) verdict = 'UNRATED';
    else if (passRate >= this.GO_PASS_RATE && !notRun && !blocked && !openCritical.length && !openHigh.length) verdict = 'GO';
    else if (passRate >= this.COND_PASS_RATE && !openCritical.length && openHigh.length <= this.COND_MAX_HIGH_OPEN) verdict = 'CONDITIONAL';

    // Reason sentence, fixed priority order (spec §4).
    const problems = [];
    if (openCritical.length) problems.push(`${openCritical.length} bug Critical terbuka`);
    if (total && passRate === null) problems.push('belum ada test yang dijalankan');
    else if (total && passRate < this.GO_PASS_RATE) problems.push(`pass rate ${passRate}% (target ${this.GO_PASS_RATE}%)`);
    if (blocked) problems.push(`${blocked} test Blocked`);
    if (openHigh.length) problems.push(`${openHigh.length} bug High terbuka`);
    if (notRun && executed) problems.push(`${notRun} test belum jalan`);
    const reason = verdict === 'GO' ? 'Semua kriteria GO terpenuhi.'
      : problems.length ? `Tertahan karena ${problems.join(', ')}.` : '';

    return { verdict, total, passed, notRun, blocked, executed, passRate, openBugs, openCritical, openHigh, problems, reason };
  },

  /* "Harus selesai sebelum go-live": concrete items from the worst modules
     (NO GO first, then CONDITIONAL), capped at `limit`. */
  mustFix(g, codeOf = b => b.code || b.id, limit = 5){
    const items = [];
    g.modules.filter(m => m.verdict === 'NO_GO' || m.verdict === 'CONDITIONAL').forEach(m => {
      const target = m.verdict === 'NO_GO' ? this.COND_PASS_RATE : this.GO_PASS_RATE;
      m.openCritical.forEach(b => items.push(`Tutup ${codeOf(b)} (Critical) — ${b.title || ''}`.trim()));
      if (m.blocked) items.push(`Selesaikan ${m.blocked} test Blocked di ${m.module}`);
      if (m.passRate === null) items.push(`Jalankan test case di ${m.module}`);
      else if (m.passRate < target) items.push(`Naikkan pass rate ${m.module} dari ${m.passRate}% ke ≥ ${target}%`);
      const highOver = m.verdict === 'NO_GO' ? m.openHigh.length > this.COND_MAX_HIGH_OPEN : m.openHigh.length > 0;
      if (highOver) items.push(`Tutup ${m.openHigh.length} bug High di ${m.module}`);
      if (m.notRun && m.passRate !== null) items.push(`Jalankan ${m.notRun} test tersisa di ${m.module}`);
    });
    return { items: items.slice(0, limit), more: Math.max(0, items.length - limit) };
  },

  /* Contextual filter: each module / round option with its test case count in
     the other filter's scope. 0 test cases = disabled (would give an empty report). */
  scopeOptions(tcs, bugs, files, { fileId = '', module = '' } = {}){
    const inFile = x => !fileId || x.fileId === fileId;
    const inModule = x => !module || this.moduleOf(x) === module;
    const fileName = (files.find(f => f.id === fileId) || {}).name || '';
    const names = [...new Set([...tcs, ...bugs].map(x => this.moduleOf(x)))].sort((a, b) => a.localeCompare(b));
    const modules = names.map(name => {
      const mt = tcs.filter(t => inFile(t) && this.moduleOf(t) === name);
      return {
        name, count: mt.length, disabled: !mt.length,
        verdict: mt.length ? this.evaluate(mt, bugs.filter(b => inFile(b) && this.moduleOf(b) === name)).verdict : null,
        why: mt.length ? '' : fileId ? `tidak ada di ${fileName}` : 'belum ada test case'
      };
    });
    const rounds = files.map(f => {
      const ft = tcs.filter(t => t.fileId === f.id && inModule(t));
      const fb = bugs.filter(b => b.fileId === f.id && inModule(b));
      const count = ft.length;
      return {
        id: f.id, name: f.name, date: f.createdAt || '', count, disabled: !count,
        why: count ? '' : module ? `tidak berisi ${module}` : 'belum ada test case',
        verdict: count ? this.goLive(ft, fb).verdict : null,
        openBugs: fb.filter(b => this.isOpen(b)).length
      };
    });
    return {
      modules, rounds,
      allModulesCount: tcs.filter(inFile).length,
      allRoundsCount: tcs.filter(inModule).length
    };
  },

  reopenStats(bugs){
    const rows = bugs.map(b => {
      const reopens = (b.activity || []).filter(a => this.REOPEN_STATUSES.includes(a.to));
      const last = reopens[reopens.length - 1];
      return { bug: b, count: reopens.length, lastNote: last ? (last.note || '') : '' };
    }).filter(r => r.count > 0).sort((a, b) => b.count - a.count);

    const moduleMap = {};
    rows.forEach(r => {
      const m = r.bug.module || '(Tanpa Module)';
      moduleMap[m] = moduleMap[m] || { module: m, bugs: 0, reopens: 0 };
      moduleMap[m].bugs++;
      moduleMap[m].reopens += r.count;
    });
    const byModule = Object.values(moduleMap).sort((a, b) => b.reopens - a.reopens);
    const totalReopens = rows.reduce((sum, r) => sum + r.count, 0);
    return { rows, byModule, totalReopens };
  },

  /* Fix time = reportDate -> last "-> Closed" entry in the status log. Bugs closed
     without a logged transition (imported/old data) can't be measured. */
  speedStats(bugs, now = Date.now()){
    const slaHours = sev => (this.SLA_DAYS[sev] || this.SLA_DAYS.Medium) * 24;
    const bySeverity = {};
    Object.keys(this.SLA_DAYS).forEach(s => { bySeverity[s] = { count: 0, onTime: 0, totalHours: 0 }; });
    let measured = 0, onTime = 0, unmeasured = 0;
    const overdueOpen = [];

    bugs.forEach(b => {
      const sev = this.SLA_DAYS[b.severity] ? b.severity : 'Medium';
      if (b.status === 'Closed'){
        const closed = (b.activity || []).filter(a => a.to === 'Closed');
        const hours = closed.length && b.reportDate ? (new Date(closed[closed.length - 1].at) - new Date(b.reportDate)) / 36e5 : NaN;
        if (!(hours >= 0)){ unmeasured++; return; }
        measured++;
        bySeverity[sev].count++;
        bySeverity[sev].totalHours += hours;
        if (hours <= slaHours(sev)){ onTime++; bySeverity[sev].onTime++; }
      } else if (this.isOpen(b) && b.reportDate){
        const age = (now - new Date(b.reportDate)) / 36e5;
        if (age > slaHours(sev)) overdueOpen.push({ bug: b, ageHours: age, slaHours: slaHours(sev) });
      }
    });

    Object.values(bySeverity).forEach(s => { s.avgHours = s.count ? s.totalHours / s.count : 0; });
    overdueOpen.sort((a, b) => (b.ageHours - b.slaHours) - (a.ageHours - a.slaHours));
    const onTimePct = measured ? Math.round(onTime / measured * 100) : null;
    const verdict = onTimePct === null ? 'NA'
      : onTimePct >= this.SPEED_FAST_PCT ? 'FAST'
      : onTimePct >= this.SPEED_OK_PCT ? 'WATCH' : 'SLOW';
    return { measured, onTime, unmeasured, onTimePct, bySeverity, overdueOpen, verdict };
  },

  /* Plain-language lines for PM/BA — no QA jargon ("pass rate", "severity"). */
  businessSummary(g, r, s){
    const verdictText = {
      EMPTY: 'Kesiapan go-live BELUM BISA DINILAI — belum ada skenario pengujian yang tercatat.',
      INCOMPLETE: 'Report BELUM LENGKAP — sebagian module belum punya skenario pengujian, jadi vonis go-live belum final.',
      GO: 'Aplikasi SIAP untuk go-live — semua module memenuhi kriteria.',
      CONDITIONAL: 'Aplikasi SIAP go-live DENGAN SYARAT — beberapa masalah penting di module tertentu harus disepakati penanganannya dulu.',
      NO_GO: 'Aplikasi BELUM SIAP untuk go-live — ada module yang belum memenuhi kriteria.'
    }[g.verdict];
    const points = [];
    const reasons = m => {
      if (!m.total) return 'belum ada skenario pengujian';
      const out = [];
      if (m.passRate === null) out.push('belum ada skenario yang diuji');
      else if (m.passRate < this.GO_PASS_RATE) out.push(`baru ${m.passRate}% skenario berhasil`);
      if (m.notRun) out.push(`${m.notRun} skenario belum diuji`);
      if (m.blocked) out.push(`${m.blocked} skenario terhambat`);
      if (m.openCritical.length) out.push(`${m.openCritical.length} masalah kritis`);
      if (m.openHigh.length) out.push(`${m.openHigh.length} masalah berat`);
      return out.join(', ');
    };
    const byVerdict = v => (g.modules || []).filter(m => m.verdict === v);
    if (byVerdict('GO').length) points.push(`Module siap go-live: ${byVerdict('GO').map(m => m.module).join(', ')}.`);
    if (byVerdict('CONDITIONAL').length) points.push(`Module siap dengan syarat: ${byVerdict('CONDITIONAL').map(m => `${m.module} (${reasons(m)})`).join('; ')}.`);
    if (byVerdict('NO_GO').length) points.push(`Module belum siap: ${byVerdict('NO_GO').map(m => `${m.module} (${reasons(m)})`).join('; ')}.`);
    if (byVerdict('UNRATED').length) points.push(`Module belum dinilai karena belum ada skenario pengujian: ${byVerdict('UNRATED').map(m => m.module).join(', ')}.`);
    if (g.verdict === 'INCOMPLETE' && g.provisional){
      points.push(`Vonis sementara dari module yang sudah diuji: ${{ GO: 'GO', CONDITIONAL: 'CONDITIONAL GO', NO_GO: 'NO GO' }[g.provisional]}.`);
    }
    if (!g.total){
      points.push('Belum ada skenario pengujian yang tercatat, sehingga kualitas aplikasi belum bisa dinilai.');
    } else if (!g.executed){
      points.push(`Ada ${g.total} skenario pengujian, tetapi belum ada yang diuji.`);
    } else {
      points.push(`Dari ${g.executed} skenario yang sudah diuji (total ${g.total}), ${g.passed} (${g.passRate}%) berjalan sesuai harapan.`);
      if (g.notRun) points.push(`${g.notRun} skenario belum diuji — ada bagian aplikasi yang kualitasnya belum terjamin.`);
      if (g.blocked) points.push(`${g.blocked} skenario tidak bisa diuji karena terhambat (misalnya menunggu data, akses, atau environment).`);
    }
    const titles = list => list.slice(0, 3).map(b => `"${b.title}"`).join(', ') + (list.length > 3 ? `, dan ${list.length - 3} lainnya` : '');
    if (g.openCritical.length) points.push(`Masih ada ${g.openCritical.length} masalah KRITIS yang bisa menghentikan proses bisnis utama: ${titles(g.openCritical)}.`);
    if (g.openHigh.length) points.push(`Masih ada ${g.openHigh.length} masalah BERAT yang mengganggu pengguna: ${titles(g.openHigh)}.`);
    if (!g.openCritical.length && !g.openHigh.length && g.total) points.push('Tidak ada masalah kritis atau berat yang masih terbuka.');

    if (r.rows.length){
      const worst = r.byModule[0];
      points.push(`${r.rows.length} masalah muncul kembali setelah dinyatakan sudah diperbaiki (total ${r.totalReopens} kali). Area paling sering bermasalah: ${worst.module}. Ini tanda perbaikan belum tuntas.`);
    }

    if (s.verdict !== 'NA'){
      const speedWord = { FAST: 'cepat', WATCH: 'cukup, namun perlu perhatian', SLOW: 'lambat' }[s.verdict];
      points.push(`Kecepatan perbaikan ${speedWord}: ${s.onTimePct}% masalah diselesaikan sesuai target waktu.`);
    }
    if (s.overdueOpen.length) points.push(`${s.overdueOpen.length} masalah yang masih terbuka sudah melewati target waktu penyelesaian.`);

    const nextSteps = [];
    if (!g.total) nextSteps.push('Tim QA menambahkan skenario pengujian, menjalankannya, lalu mencatat bug yang ditemukan — report terisi otomatis.');
    if (byVerdict('UNRATED').length && g.total) nextSteps.push(`Tambahkan skenario pengujian untuk module yang belum dinilai (${byVerdict('UNRATED').map(m => m.module).join(', ')}).`);
    if (g.openCritical.length) nextSteps.push('Selesaikan dan uji ulang semua masalah kritis sebelum menjadwalkan go-live.');
    if (g.openHigh.length) nextSteps.push(g.verdict === 'CONDITIONAL'
      ? 'Putuskan bersama tim developer & QA: masalah berat yang tersisa diperbaiki sebelum go-live, atau diterima dengan solusi sementara (workaround) dan jadwal perbaikan.'
      : 'Prioritaskan perbaikan masalah berat yang masih terbuka.');
    if (g.notRun || g.blocked) nextSteps.push('Tuntaskan pengujian skenario yang belum diuji / terhambat agar seluruh fitur terverifikasi.');
    if (r.rows.some(x => x.count >= 3)) nextSteps.push('Masalah yang berulang 3 kali atau lebih perlu dibahas bersama tim developer dan BA — kemungkinan kebutuhan (requirement) belum jelas.');
    if (s.verdict === 'SLOW' || s.overdueOpen.length) nextSteps.push('Evaluasi kapasitas dan prioritas tim developer agar perbaikan sesuai target waktu.');
    if (!nextSteps.length) nextSteps.push('Lanjutkan persiapan go-live (sosialisasi pengguna, rencana rollback, dan monitoring setelah rilis).');

    return { verdictText, points, nextSteps };
  }
};

// Line icons (stroke, currentColor) — no emoji on this page.
const RPT_ICON = (() => {
  const svg = (d, size = 16, w = 2.2) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  return {
    chevron: svg('<path d="m6 9 6 6 6-6"/>', 14, 2.6),
    check: svg('<path d="M5 12l5 5 9-10"/>', 16, 3),
    download: svg('<path d="M12 4v12M7 11l5 5 5-5M5 20h14"/>'),
    filter: svg('<path d="M3 5h18l-7 8v6l-4-2v-4z"/>', 30, 2),
    arrow: svg('<path d="M9 6l6 6-6 6"/>', 18, 2.4),
    file: svg('<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h4"/>', 20, 2),
    files: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>', 20, 2),
    go: svg('<circle cx="12" cy="12" r="9"/><path d="M8 12l3 3 5-6"/>', 22, 2.6),
    cond: svg('<path d="M12 3 2 20h20z"/><path d="M12 10v4M12 17h.01"/>', 22, 2.4),
    nogo: svg('<circle cx="12" cy="12" r="9"/><path d="M8 8l8 8"/>', 22, 2.6),
    wait: svg('<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>', 22, 2.6)
  };
})();

const ReportModule = {
  /* fileId: '' = nothing picked yet (the page shows the file picker),
     ALL_FILES = every file combined, else one file id. */
  filters: { fileId: '', module: '' },
  ALL_FILES: 'all',
  open: null,  // filter dropdown currently open: 'module' | 'round' | null
  URL_KEYS: { module: 'rptModule', fileId: 'rptRound' },
  VERDICT: {
    GO: ['go', 'GO', 'GO', 'go'],
    CONDITIONAL: ['cond', 'CONDITIONAL GO', 'CONDITIONAL', 'cond'],
    NO_GO: ['nogo', 'NO GO', 'NO GO', 'nogo'],
    INCOMPLETE: ['neutral', 'BELUM LENGKAP', 'BELUM LENGKAP', 'wait'],
    UNRATED: ['unrated', 'BELUM DINILAI', 'BELUM DINILAI', 'wait'],
    EMPTY: ['neutral', 'Menunggu data', 'Menunggu data', 'wait']
  },

  /* ---- Filters in the query string, so a shared link opens the same context ---- */
  hasUrlFilter(){
    const p = new URLSearchParams(location.search);
    return Object.values(this.URL_KEYS).some(k => p.has(k));
  },
  readUrl(){
    const p = new URLSearchParams(location.search);
    this.filters = { module: p.get(this.URL_KEYS.module) || '', fileId: p.get(this.URL_KEYS.fileId) || '' };
  },
  // href with the report filters set (filters) or stripped (null — other pages).
  urlWith(href, filters){
    const u = new URL(href);
    Object.entries(this.URL_KEYS).forEach(([key, param]) => {
      if (filters && filters[key]) u.searchParams.set(param, filters[key]); else u.searchParams.delete(param);
    });
    return u.toString();
  },

  // The one file filtered on, '' for none / all files.
  fileFilter(){ return this.filters.fileId === this.ALL_FILES ? '' : this.filters.fileId; },
  filtered(list){
    const fid = this.fileFilter();
    return list.filter(x =>
      (!fid || x.fileId === fid) &&
      (!this.filters.module || ReportCalc.moduleOf(x) === this.filters.module));
  },
  fileName(files){
    const fid = this.fileFilter();
    if (!fid) return '';
    return (files.find(f => f.id === fid) || {}).name || 'putaran tidak ditemukan';
  },
  scopeLabel(files){
    return `${this.filters.module || 'Semua module'} · ${this.fileName(files) || 'Semua putaran testing'}`;
  },
  chip(verdict, size = ''){
    const [cls, label, short, icon] = this.VERDICT[verdict];
    return `<span class="rpt-chip rpt-${cls}${size ? ` rpt-chip-${size}` : ''}">${size === 'big' ? RPT_ICON[icon] : ''}${size === 'sm' ? short : label}</span>`;
  },
  pct(v){ return v === null || v === undefined ? '—' : `${v}%`; },

  /* Big data: show the logo spinner first, build the report a frame later so the
     browser can paint it. Only when the report is regenerated (filters changed) —
     opening a dropdown re-renders instantly. ponytail: below this size the report
     is instant and a loader would only flicker. */
  LOADER_MIN_ITEMS: 500,
  render(){
    if (!this._urlRead){ this._urlRead = true; if (this.hasUrlFilter()) this.readUrl(); }
    const key = JSON.stringify(this.filters);
    const heavy = this.filters.fileId && key !== this._renderedKey && typeof requestAnimationFrame === 'function'
      && TestCaseModule.all().length + BugReportModule.all().length >= this.LOADER_MIN_ITEMS;
    if (!heavy) return this.renderNow();
    const token = this._renderToken = (this._renderToken || 0) + 1;
    document.getElementById('rptBody').innerHTML = `
      <div class="rpt-loading" role="status" aria-label="Membuat report…">
        <div class="rpt-loader"><span class="rpt-loader-ring"></span><span class="rpt-loader-mark">QA</span></div>
      </div>`;
    // A newer render (another filter click) supersedes this one.
    requestAnimationFrame(() => setTimeout(() => { if (token === this._renderToken) this.renderNow(); }, 0));
  },

  renderNow(){
    this._renderToken = (this._renderToken || 0) + 1;
    this._renderedKey = JSON.stringify(this.filters);
    const allTcs = TestCaseModule.all(), allBugs = BugReportModule.all();
    const files = Auth.visibleFiles(App.state.files);
    const tcs = this.filtered(allTcs), bugs = this.filtered(allBugs);
    const g = ReportCalc.goLive(tcs, bugs);
    const r = ReportCalc.reopenStats(bugs);
    const s = ReportCalc.speedStats(bugs);
    const biz = ReportCalc.businessSummary(g, r, s);
    const opts = ReportCalc.scopeOptions(allTcs, allBugs, files, { module: this.filters.module, fileId: this.fileFilter() });
    // pick: no file chosen yet · empty: no test case at all · filtered: combo is empty · data: partial or full
    const state = !this.filters.fileId ? 'pick' : !allTcs.length ? 'empty' : !tcs.length ? 'filtered' : 'data';
    this._last = { g, r, s, biz, state, bugs, scope: this.scopeLabel(files) };
    if (App.state.currentPage === 'report') history.replaceState(history.state, '', this.urlWith(location.href, this.filters));

    const body = state === 'pick' || state === 'empty' ? this.pickView(opts, files, state)
      : state === 'filtered' ? this.filteredView(opts, allBugs, files)
      : this.dataView(g, r, bugs, files);
    // Pick / empty: no toolbar — the file picker sits inside the card instead.
    document.getElementById('rptBody').innerHTML = `<div class="rpt">${state === 'pick' || state === 'empty' ? '' : this.filterBar(opts, files, state)}${body}</div>`;
  },

  /* ---- Filter toolbar (same look as other pages), options are contextual ---- */
  filterBar(opts, files, state){
    const off = state === 'empty';
    const fileName = this.fileName(files);
    const active = !!(this.filters.module || this.fileFilter());
    return `
      <div class="toolbar rpt-toolbar" title="Ringkasan dan PDF otomatis mencantumkan konteks filter ini.">
        ${this.dropdown('module', 'Module', this.filters.module || 'Semua module', off, () => this.moduleMenu(opts, fileName))}
        ${this.dropdown('round', 'Putaran', fileName || 'Semua putaran testing', off, () => this.roundMenu(opts))}
        ${active ? '<button type="button" class="btn sm ghost" data-act="reset">Reset</button>' : ''}
        <div class="spacer"></div>
        ${state === 'data' ? '<button type="button" class="btn sm" data-act="copy">Salin Ringkasan</button>' : ''}
        <button type="button" class="btn sm primary" data-act="pdf" ${state === 'data' ? '' : 'disabled'}>Export PDF</button>
      </div>`;
  },
  dropdown(key, prefix, value, disabled, menu){
    const open = this.open === key && !disabled;
    const on = key === 'module' ? !!this.filters.module : !!this.fileFilter();
    return `
      <div class="rpt-dd">
        <button type="button" class="filter-select rpt-dd-trigger${on ? ' on' : ''}" data-act="toggle" data-dd="${key}"
          aria-haspopup="listbox" aria-expanded="${open}" ${disabled ? 'disabled' : ''}>
          <span class="rpt-dd-prefix">${prefix}:</span><span class="rpt-dd-value">${escapeHtml(value)}</span>${RPT_ICON.chevron}
        </button>
        ${open ? menu() : ''}
      </div>`;
  },
  option(act, value, label, meta, selected, disabled, end = ''){
    return `
      <button type="button" role="option" class="rpt-opt${selected ? ' sel' : ''}" aria-selected="${selected}"
        data-act="${act}" data-value="${escapeHtml(value)}" ${disabled ? 'disabled' : ''}>
        <span class="rpt-opt-text"><b>${escapeHtml(label)}</b><span>${escapeHtml(meta)}</span></span>
        <span class="rpt-opt-end">${end}${selected ? RPT_ICON.check : ''}</span>
      </button>`;
  },
  moduleMenu(opts, fileName){
    const cur = this.filters.module;
    return `
      <div class="rpt-menu" role="listbox" aria-label="Pilih module">
        <div class="rpt-menu-head">Module di ${escapeHtml(fileName || 'semua putaran')}</div>
        ${this.option('pick-module', '', 'Semua module', `${opts.allModulesCount} test case`, !cur, false)}
        ${opts.modules.map(m => this.option('pick-module', m.name, m.name, m.disabled ? m.why : `${m.count} test case`,
          m.name === cur, m.disabled, m.verdict ? this.chip(m.verdict, 'sm') : '')).join('')}
      </div>`;
  },
  roundMenu(opts){
    const cur = this.filters.fileId;
    return `
      <div class="rpt-menu" role="listbox" aria-label="Pilih putaran testing">
        <div class="rpt-menu-head">Putaran testing</div>
        ${this.option('pick-round', this.ALL_FILES, 'Semua putaran testing', `${opts.allRoundsCount} test case`, cur === this.ALL_FILES, false)}
        ${opts.rounds.map(f => this.option('pick-round', f.id, f.name,
          f.disabled ? f.why : `${f.date ? `${formatDate(f.date)} · ` : ''}${f.count} test case`, f.id === cur, f.disabled)).join('')}
      </div>`;
  },

  /* ---- File picker on the first screen: every file is selectable, with its
     size and verdict so the choice is informed. ---- */
  filePicker(opts, files){
    const open = this.open === 'picker';
    const fileName = this.fileName(files);
    const withData = opts.rounds.filter(f => f.count).length;
    const row = (value, name, meta, end, icon, selected) => `
      <button type="button" role="option" class="rpt-pick-opt${selected ? ' sel' : ''}" aria-selected="${selected}" data-act="pick-round" data-value="${escapeHtml(value)}">
        <span class="rpt-pick-icon${icon === 'all' ? ' all' : ''}">${icon === 'all' ? RPT_ICON.files : RPT_ICON.file}</span>
        <span class="rpt-pick-text"><b>${escapeHtml(name)}</b><span>${meta}</span></span>
        <span class="rpt-opt-end">${end}${selected ? RPT_ICON.check : ''}</span>
      </button>`;
    const menu = `
      <div class="rpt-pick-menu" role="listbox" aria-label="Pilih file">
        <div class="rpt-menu-head">${opts.rounds.length} file · ${withData} berisi test case</div>
        ${withData > 1 ? row(this.ALL_FILES, 'Semua file', `Gabungan ${opts.allRoundsCount} test case`, '', 'all', this.filters.fileId === this.ALL_FILES) : ''}
        ${opts.rounds.map(f => row(f.id, f.name,
          [f.date ? formatDate(f.date) : '', f.count ? `${f.count} test case` : '', f.count ? (f.openBugs ? `${f.openBugs} bug terbuka` : 'tanpa bug terbuka') : ''].filter(Boolean).join(' · ') || 'Belum ada test case',
          f.count ? this.chip(f.verdict, 'sm') : '<span class="rpt-tag">Kosong</span>', 'file', f.id === this.filters.fileId)).join('')}
      </div>`;
    return `
      <div class="rpt-picker">
        <button type="button" class="rpt-pick-trigger${open ? ' open' : ''}" data-act="toggle" data-dd="picker" aria-haspopup="listbox" aria-expanded="${open}">
          <span class="rpt-pick-icon">${RPT_ICON.file}</span>
          <span class="rpt-pick-text"><b>${escapeHtml(fileName || 'Pilih file')}</b><span>${fileName ? 'Ganti file' : `${opts.rounds.length} file tersedia`}</span></span>
          ${RPT_ICON.chevron}
        </button>
        ${open ? menu : ''}
      </div>`;
  },

  /* ---- First screen (no file picked yet) and "no test case at all": never NO GO ---- */
  pickView(opts, files, state){
    const fileName = this.fileName(files);
    const text = state === 'empty' && fileName
      ? `File <b>${escapeHtml(fileName)}</b> belum berisi test case, jadi vonis GO / NO GO belum bisa dihitung. Pilih file lain, atau tunggu tim QA mengisi test case-nya.`
      : 'Report terisi sendiri dari hasil pengujian tim QA, lengkap dengan vonis, angka penting, dan apa saja yang masih kurang.';
    const picker = opts.rounds.length ? this.filePicker(opts, files) : '<div class="rpt-hint">Belum ada file di workspace ini.</div>';
    const step = (n, title, text) => `<li class="rpt-step"><span class="rpt-step-n">${n}</span><div><b>${title}</b><span>${text}</span></div></li>`;
    const preview = (label, value, foot) => `<div class="rpt-card rpt-stat rpt-stat-ghost"><div class="rpt-stat-label">${label}</div><div class="rpt-num rpt-num-ghost">${value}</div><div class="rpt-stat-foot">${foot}</div></div>`;
    return `
      <section class="rpt-card rpt-empty">
        <div class="rpt-empty-main">
          <h1>Di sini nanti kamu tahu: siap rilis atau belum</h1>
          <p>${text}</p>
          ${picker}
        </div>
        <ol class="rpt-steps">
          ${step(1, 'QA menambahkan test case', 'Per module, manual atau import dari Excel.')}
          ${step(2, 'QA menjalankan &amp; mencatat hasil', 'Pass, Fail, atau Blocked untuk tiap test case.')}
          ${step(3, 'QA melaporkan bug', 'Lengkap dengan severity supaya vonis akurat.')}
        </ol>
      </section>
      <section class="rpt-block">
        <div class="rpt-block-head"><h2>Yang akan tampil nanti</h2><span class="rpt-hint">Pratinjau — terisi setelah ada data</span></div>
        <div class="rpt-stats">
          ${preview('Vonis go-live', '—', 'GO · CONDITIONAL · NO GO')}
          ${preview('Pass rate', '—', 'Target GO ≥ 95%')}
          ${preview('Bug terbuka', '—', 'Critical &amp; High disorot')}
          ${preview('Module siap', '— / —', 'Dinilai per module')}
        </div>
      </section>
      ${this.criteriaDetails()}`;
  },
  criteriaDetails(){
    return `
      <details class="rpt-card rpt-details">
        <summary>Bagaimana vonis dihitung?</summary>
        <div class="rpt-criteria">
          <div><b class="rpt-t-go">GO</b>Pass rate ≥ ${ReportCalc.GO_PASS_RATE}%, semua test case dijalankan, tidak ada Blocked, tidak ada bug Critical/High terbuka.</div>
          <div><b class="rpt-t-cond">CONDITIONAL GO</b>Pass rate ≥ ${ReportCalc.COND_PASS_RATE}%, tanpa bug Critical terbuka, bug High terbuka maksimal ${ReportCalc.COND_MAX_HIGH_OPEN}.</div>
          <div><b class="rpt-t-nogo">NO GO</b>Di luar kriteria di atas. Vonis aplikasi = vonis module terburuk. Pass rate = test Pass ÷ test yang sudah dijalankan; bug selesai bila ${ReportCalc.DONE_STATUSES.join(' / ')}.</div>
        </div>
      </details>`;
  },

  /* ---- State 2: data exists, but this filter combo has no test case ---- */
  filteredView(opts, allBugs, files){
    const module = this.filters.module, fileId = this.fileFilter();
    const fileName = escapeHtml(this.fileName(files));
    const mod = escapeHtml(module);
    const why = module && fileId ? `Putaran <b>${fileName}</b> tidak berisi test case untuk module <b>${mod}</b>`
      : module ? `Module <b>${mod}</b> belum punya test case` : `Putaran <b>${fileName}</b> belum berisi test case`;
    const secondary = module && fileId
      ? `<button type="button" class="rpt-btn rpt-btn-lg" data-act="clear" data-key="module">Lihat semua module di ${fileName}</button>
         <button type="button" class="rpt-btn rpt-btn-lg" data-act="clear" data-key="fileId">Lihat ${mod} di semua putaran</button>` : '';
    const otherRounds = module ? opts.rounds.filter(f => !f.disabled) : [];
    const fileModules = fileId ? opts.modules.filter(m => !m.disabled) : [];
    const openBugs = (fid) => allBugs.filter(b => b.fileId === fid && ReportCalc.moduleOf(b) === module && ReportCalc.isOpen(b)).length;
    return `
      <section class="rpt-card rpt-filtered">
        <span class="rpt-filtered-icon">${RPT_ICON.filter}</span>
        <h1>Tidak ada data untuk filter ini</h1>
        <p>${why}, jadi vonis go-live tidak dihitung untuk pilihan ini.</p>
        <div class="rpt-row-btns">
          <button type="button" class="rpt-btn rpt-btn-primary rpt-btn-lg" data-act="reset">Reset semua filter</button>
          ${secondary}
        </div>
      </section>
      ${otherRounds.length || fileModules.length ? `<section class="rpt-suggest">
        ${otherRounds.length ? `<div class="rpt-card rpt-suggest-box">
          <h2>Module ${mod} ada di putaran lain</h2><div class="rpt-hint">Pilih salah satu untuk ganti filter putaran</div>
          <div class="rpt-suggest-list">${otherRounds.map(f => { const n = openBugs(f.id); return `
            <button type="button" class="rpt-suggest-row" data-act="pick-round" data-value="${escapeHtml(f.id)}">
              <span><b>${escapeHtml(f.name)}</b><span>${f.count} test case · ${n ? `${n} bug terbuka` : 'tanpa bug terbuka'}</span></span>${RPT_ICON.arrow}
            </button>`; }).join('')}</div>
        </div>` : ''}
        ${fileModules.length ? `<div class="rpt-card rpt-suggest-box">
          <h2>Isi putaran ${fileName}</h2><div class="rpt-hint">Pilih salah satu untuk ganti filter module</div>
          <div class="rpt-suggest-chips">${fileModules.map(m => `
            <button type="button" class="rpt-suggest-chip" data-act="pick-module" data-value="${escapeHtml(m.name)}">${escapeHtml(m.name)} <span class="rpt-mono">${m.count}</span></button>`).join('')}</div>
          <div class="rpt-hint">Angka = jumlah test case di putaran ini</div>
        </div>` : ''}
      </section>` : ''}`;
  },

  /* ---- States 3 & 4: partial (some module unrated) or complete data ---- */
  dataView(g, r, bugs, files){
    const canInput = Auth.can('testcase_create');
    const canSee = App.canAccessPage('testcase');
    const unrated = g.modules.filter(m => m.verdict === 'UNRATED');
    const rated = g.modules.filter(m => m.verdict !== 'UNRATED');
    const names = list => { const n = list.map(m => `<b>${escapeHtml(m.module)}</b>`); return n.length <= 3 ? n.join(n.length === 2 ? ' dan ' : ', ') : `${n.slice(0, 3).join(', ')} dan ${n.length - 3} lainnya`; };
    const total = g.modules.length;

    const side = {
      INCOMPLETE: `${unrated.length} dari ${total} module belum dinilai`,
      NO_GO: `${g.counts.NO_GO} dari ${total} module belum memenuhi kriteria`,
      CONDITIONAL: `${g.counts.CONDITIONAL} dari ${total} module siap dengan syarat`,
      GO: `Semua ${total} module memenuhi kriteria`
    }[g.verdict];
    const notGo = rated.filter(m => m.verdict !== 'GO');
    const reason = g.verdict === 'INCOMPLETE'
      ? `Vonis GO / NO GO keluar setelah semua module punya test case. Saat ini ${names(unrated)} belum dites sama sekali.`
      : escapeHtml(g.verdict !== 'GO' && !g.problems.length ? `Tertahan karena module ${notGo.map(m => m.module).join(', ')} belum memenuhi kriteria.` : g.reason);

    let box;
    if (g.verdict === 'INCOMPLETE'){
      const items = [
        ...unrated.map(m => `<li><span>Tambah test case untuk <b>${escapeHtml(m.module)}</b></span>${canInput ? '<button type="button" class="rpt-link" data-act="goto" data-page="testcase">Tambah →</button>' : ''}</li>`),
        ...rated.filter(m => m.notRun).map(m => `<li><span>Jalankan ${m.notRun} test case tersisa di <b>${escapeHtml(m.module)}</b></span>${canSee ? '<button type="button" class="rpt-link" data-act="goto" data-page="testcase">Buka →</button>' : ''}</li>`)
      ];
      box = `<div class="rpt-box rpt-box-info"><div class="rpt-box-title">Supaya report lengkap</div>
        <ul class="rpt-todo">${items.slice(0, 5).join('')}</ul>${items.length > 5 ? `<div class="rpt-hint">+ ${items.length - 5} lainnya</div>` : ''}</div>`;
    } else if (g.verdict === 'GO'){
      box = `<div class="rpt-box rpt-box-go"><div class="rpt-box-title">Siap go-live</div>
        <p>Tidak ada yang menahan. Lanjutkan persiapan rilis: sosialisasi pengguna, rencana rollback, dan monitoring setelah rilis.</p></div>`;
    } else {
      const fix = ReportCalc.mustFix(g, bugCode);
      const nogo = g.verdict === 'NO_GO';
      box = `<div class="rpt-box ${nogo ? 'rpt-box-nogo' : 'rpt-box-cond'}"><div class="rpt-box-title">${nogo ? 'Harus selesai sebelum go-live' : 'Perlu disepakati sebelum go-live'}</div>
        <ul class="rpt-dots">${fix.items.map(x => `<li>${escapeHtml(x)}</li>`).join('')}</ul>${fix.more ? `<div class="rpt-hint">+ ${fix.more} lainnya</div>` : ''}</div>`;
    }

    const verdictCard = `
      <section class="rpt-card rpt-verdict-card">
        <div class="rpt-verdict-main">
          <div class="rpt-scope"><span class="rpt-eyebrow">Vonis untuk</span><span class="rpt-scope-pill">${escapeHtml(this.scopeLabel(files))}</span></div>
          <div class="rpt-verdict-row">${this.chip(g.verdict, 'big')}<span class="rpt-verdict-side">${side}</span></div>
          <p class="rpt-reason">${reason}</p>
          ${g.verdict === 'INCOMPLETE' && g.provisional ? `<div class="rpt-provisional"><span>Vonis sementara dari ${rated.length} module yang sudah dites:</span>${this.chip(g.provisional, 'sm')}</div>` : ''}
        </div>
        ${box}
      </section>`;

    // Every number carries its context; no data = "—", never 0.
    const others = g.openBugs.length - g.openCritical.length - g.openHigh.length;
    const segs = [['GO', 'go'], ['CONDITIONAL', 'cond'], ['NO_GO', 'nogo'], ['UNRATED', 'unrated']].filter(([k]) => g.counts[k])
      .map(([k, cls]) => `<span class="rpt-seg rpt-seg-${cls}" style="flex:${g.counts[k]}"></span>`).join('');
    const legend = [`${g.counts.GO} GO`, `${g.counts.CONDITIONAL} Conditional`, `${g.counts.NO_GO} No Go`, g.counts.UNRATED ? `${g.counts.UNRATED} belum dinilai` : ''].filter(Boolean).join(' · ');
    const stats = `
      <section class="rpt-stats">
        <div class="rpt-card rpt-stat">
          <div class="rpt-stat-label">Pass rate${g.verdict === 'INCOMPLETE' ? '' : ' keseluruhan'}</div>
          <div class="rpt-num">${this.pct(g.passRate)}</div>
          <div class="rpt-bar"><span style="width:${g.passRate || 0}%"></span></div>
          <div class="rpt-stat-foot">${g.executed ? `Dari ${g.executed} test yang sudah dijalankan · target GO ≥ ${ReportCalc.GO_PASS_RATE}%` : 'Belum ada test yang dijalankan'}</div>
        </div>
        <div class="rpt-card rpt-stat">
          <div class="rpt-stat-label">Test case dijalankan</div>
          <div class="rpt-num">${g.executed}<small>/${g.total}</small></div>
          <div class="rpt-stat-foot">${g.notRun} belum jalan · ${g.blocked} blocked${unrated.length ? ` · ${unrated.length} module belum ada test` : ''}</div>
        </div>
        <div class="rpt-card rpt-stat">
          <div class="rpt-stat-label">Bug terbuka</div>
          <div class="rpt-num">${g.openBugs.length}</div>
          ${g.openBugs.length ? `<div class="rpt-sev-row">
            ${g.openCritical.length ? `<span class="rpt-sev rpt-sev-crit">${g.openCritical.length} Critical</span>` : ''}
            ${g.openHigh.length ? `<span class="rpt-sev rpt-sev-high">${g.openHigh.length} High</span>` : ''}
            ${others ? `<span class="rpt-sev">${others} lainnya</span>` : ''}</div>` : ''}
          <div class="rpt-stat-foot">${g.openBugs.length ? `Dari ${bugs.length} bug tercatat dalam scope ini` : `Tidak ada bug terbuka dari ${bugs.length} bug tercatat`}</div>
        </div>
        <div class="rpt-card rpt-stat">
          <div class="rpt-stat-label">Module siap</div>
          <div class="rpt-num">${g.counts.GO}<small>/${total}</small></div>
          <div class="rpt-segbar">${segs}</div>
          <div class="rpt-stat-foot">${legend}</div>
        </div>
      </section>`;

    const row = m => m.verdict === 'UNRATED' ? `
      <tr class="rpt-tr-unrated">
        <td class="rpt-td-name">${escapeHtml(m.module)}</td>
        <td colspan="4"><span class="rpt-dim">Belum ada test case — module ini belum bisa dinilai.</span>
          ${canInput ? '<button type="button" class="rpt-link" data-act="goto" data-page="testcase">+ Tambah test case</button>' : ''}</td>
        <td>${this.chip('UNRATED', 'sm')}</td>
      </tr>` : `
      <tr>
        <td class="rpt-td-name">${escapeHtml(m.module)}</td>
        <td><div class="rpt-passcell"><div class="rpt-bar"><span class="rpt-bar-${this.VERDICT[m.verdict][0]}" style="width:${m.passRate || 0}%"></span></div><span class="rpt-mono rpt-b">${this.pct(m.passRate)}</span></div></td>
        <td class="rpt-num-cell">${m.executed}/${m.total}</td>
        <td class="rpt-num-cell">${m.blocked}</td>
        <td class="rpt-num-cell">${m.openCritical.length} / ${m.openHigh.length}</td>
        <td>${this.chip(m.verdict, 'sm')}</td>
      </tr>`;
    const table = this.filters.module ? '' : `
      <section class="rpt-card rpt-section">
        <div class="rpt-block-head"><h2>Kesiapan per module</h2><span class="rpt-hint">${unrated.length ? 'Module yang belum dinilai ditaruh paling atas' : 'Diurutkan dari yang paling berisiko'}</span></div>
        <div class="rpt-table-wrap"><table class="rpt-table">
          <thead><tr><th>Module</th><th class="rpt-th-pass">Pass rate</th><th class="rpt-r">Dijalankan</th><th class="rpt-r">Blocked</th><th class="rpt-r">Crit / High</th><th>Vonis</th></tr></thead>
          <tbody>${g.modules.map(row).join('')}</tbody>
        </table></div>
      </section>`;

    const sevCls = s => s === 'Critical' ? ' rpt-sev-crit' : s === 'High' ? ' rpt-sev-high' : '';
    const reopen = `
      <section class="rpt-card rpt-section">
        <div class="rpt-block-head">
          <div><h2>Bug sering reopen / retest</h2><div class="rpt-hint">${r.rows.length ? `${r.rows.length} bug pernah dibuka ulang, total ${r.totalReopens} kali` : `Dihitung dari riwayat status ${ReportCalc.REOPEN_STATUSES.join(' / ')}`}</div></div>
          <button type="button" class="rpt-btn" data-act="export-reopen" ${r.rows.length ? '' : 'disabled'}>Export Excel</button>
        </div>
        ${r.rows.length ? `<div class="rpt-reopen-list">${r.rows.map(x => `
          <button type="button" class="rpt-reopen-row" data-act="bug" data-id="${escapeHtml(x.bug.id)}">
            <span class="rpt-mono rpt-dim rpt-reopen-id">${escapeHtml(bugCode(x.bug))}</span>
            <span class="rpt-reopen-text"><b>${escapeHtml(x.bug.title || '')}</b><span>${escapeHtml(ReportCalc.moduleOf(x.bug))} · ${escapeHtml(x.bug.status)}</span></span>
            <span class="rpt-sev${sevCls(x.bug.severity)}">${escapeHtml(x.bug.severity || '-')}</span>
            <span class="rpt-mono rpt-b rpt-reopen-count">${x.count}× reopen</span>
          </button>`).join('')}</div>` : `
          <div class="rpt-positive">
            <span class="rpt-positive-icon">${RPT_ICON.check}</span>
            <div><b>Belum ada bug yang dibuka ulang</b><span>Bagus. Bagian ini akan terisi kalau ada bug yang balik ke status ${ReportCalc.REOPEN_STATUSES.join(' atau ')}.</span></div>
          </div>`}
      </section>`;

    return verdictCard + stats + table + reopen + this.criteriaDetails();
  },

  async copySummary(){
    const { biz, scope } = this._last;
    const text = [`Kesiapan go-live untuk: ${scope}`, '', biz.verdictText, '', ...biz.points.map(p => `• ${p}`), '', 'Langkah selanjutnya:', ...biz.nextSteps.map((p, i) => `${i + 1}. ${p}`)].join('\n');
    try{
      await navigator.clipboard.writeText(text);
      Toast.show('Ringkasan disalin — tinggal paste ke email/chat.', 'success');
    }catch(e){
      Toast.show('Gagal menyalin ke clipboard.', 'error');
    }
  },

  async exportReopenExcel(){
    const { r } = this._last;
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Reopen');
    ws.columns = [
      { header: 'Bug ID', key: 'id', width: 14 }, { header: 'Judul', key: 'title', width: 40 },
      { header: 'Module', key: 'module', width: 18 }, { header: 'Severity', key: 'severity', width: 12 },
      { header: 'Status', key: 'status', width: 14 }, { header: 'Jumlah Reopen', key: 'count', width: 14 },
      { header: 'Keterangan Terakhir', key: 'note', width: 40 }
    ];
    r.rows.forEach(x => ws.addRow({ id: bugCode(x.bug), title: x.bug.title, module: x.bug.module, severity: x.bug.severity, status: x.bug.status, count: x.count, note: x.lastNote }));
    ws.getRow(1).font = { bold: true };
    const buf = await wb.xlsx.writeBuffer();
    downloadBlob(buf, 'Report_Bug_Reopen.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  },

  /* PDF for PM/BA — same data as the page, business summary first. Same
     visual language as Summary.exportPDF. */
  exportPDF(){
    if (!this._last || this._last.state !== 'data') return; // button is disabled without data
    const { g, r, s, biz } = this._last;
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF();
    const pageW = doc.internal.pageSize.getWidth();
    const pageH = doc.internal.pageSize.getHeight();
    const ink = [31, 41, 55], dim = [107, 114, 128], line = [222, 226, 232], soft = [246, 247, 249];
    // Built-in PDF fonts are WinAnsi only — swap the symbols the UI text uses.
    const t = str => String(str ?? '').replace(/≥/g, '>=').replace(/≤/g, '<=').replace(/→/g, '->').replace(/[—–]/g, '-').replace(/[^\x00-\xFF]/g, '');
    const ensureSpace = (y, needed) => (y + needed > pageH - 16) ? (doc.addPage(), 18) : y;
    const sectionTitle = (text, y) => {
      y = ensureSpace(y, 20);
      doc.setFont('helvetica', 'bold'); doc.setFontSize(11.5); doc.setTextColor(...ink);
      doc.text(t(text), 14, y);
      doc.setDrawColor(...line); doc.setLineWidth(.4); doc.line(14, y + 2, pageW - 14, y + 2);
      doc.setFont('helvetica', 'normal');
      return y + 8;
    };
    const paragraph = (lines, y, { bullet = null, bold = false } = {}) => {
      doc.setFont('helvetica', bold ? 'bold' : 'normal'); doc.setFontSize(10); doc.setTextColor(...ink);
      lines.forEach((text, i) => {
        const prefix = bullet === 'num' ? `${i + 1}. ` : bullet ? '- ' : '';
        const wrapped = doc.splitTextToSize(t(text), pageW - 28 - (prefix ? 6 : 0));
        y = ensureSpace(y, wrapped.length * 5);
        if (prefix) doc.text(prefix, 14, y);
        doc.text(wrapped, prefix ? 20 : 14, y);
        y += wrapped.length * 5 + 1.5;
      });
      return y;
    };
    const table = (y, head, body, columnStyles = {}) => {
      doc.autoTable({
        startY: y, head: [head.map(t)], body: body.map(row => row.map(t)), theme: 'grid',
        headStyles: { fillColor: soft, textColor: ink, fontStyle: 'bold', lineColor: line, lineWidth: .3 },
        bodyStyles: { textColor: ink, lineColor: line, lineWidth: .3, valign: 'top' },
        styles: { fontSize: 8.5, font: 'helvetica', cellPadding: 2 },
        columnStyles, margin: { left: 14, right: 14 }
      });
      return doc.lastAutoTable.finalY + 10;
    };

    // Header
    doc.setFont('helvetica', 'bold'); doc.setFontSize(16); doc.setTextColor(...ink);
    doc.text('Go-Live Readiness Report', 14, 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(...dim);
    doc.text(`Generated: ${new Date().toLocaleString('id-ID')}`, pageW - 14, 18, { align: 'right' });
    doc.setDrawColor(...ink); doc.setLineWidth(.6); doc.line(14, 22, pageW - 14, 22);
    doc.text(t(`Vonis untuk: ${this._last.scope}  -  ${g.total} test case, ${this._last.bugs.length} bug`), 14, 28);

    // Verdict banner (colors = the page's verdict tokens)
    const verdictLabel = { GO: 'GO', CONDITIONAL: 'CONDITIONAL GO', NO_GO: 'NO GO', UNRATED: 'BELUM DINILAI' };
    const verdict = {
      GO: ['GO - Siap go-live', [23, 102, 58], [227, 244, 234]],
      CONDITIONAL: ['CONDITIONAL GO - Siap go-live dengan syarat', [138, 83, 0], [255, 241, 214]],
      NO_GO: ['NO GO - Belum siap go-live', [161, 42, 32], [253, 228, 225]],
      INCOMPLETE: [`BELUM LENGKAP - ${g.counts.UNRATED} module belum dinilai${g.provisional ? ` (vonis sementara: ${verdictLabel[g.provisional]})` : ''}`, [63, 70, 84], [238, 240, 243]]
    }[g.verdict];
    doc.setFillColor(...verdict[2]); doc.rect(14, 33, pageW - 28, 16, 'F');
    doc.setFillColor(...verdict[1]); doc.rect(14, 33, 2.5, 16, 'F');
    doc.setFont('helvetica', 'bold'); doc.setFontSize(14); doc.setTextColor(...verdict[1]);
    doc.text(verdict[0], 21, 43.5);

    let y = sectionTitle('Ringkasan untuk PM & BA', 60);
    y = paragraph([biz.verdictText], y, { bold: true }) + 1;
    y = paragraph(biz.points, y, { bullet: true }) + 3;
    y = ensureSpace(y, 12);
    doc.setFont('helvetica', 'bold'); doc.setFontSize(10); doc.text('Langkah selanjutnya:', 14, y); y += 6;
    y = paragraph(biz.nextSteps, y, { bullet: 'num' }) + 6;

    y = sectionTitle('Kesiapan Go-Live per Module', y);
    y = table(y, ['Module', 'Test Case', 'Dijalankan', 'Pass Rate', 'Blocked', 'Critical Terbuka', 'High Terbuka', 'Vonis'],
      [...g.modules, { ...g, module: 'TOTAL', verdict: null }].map(m => [m.module, m.total, m.total ? `${m.executed}/${m.total}` : '-', this.pct(m.passRate), m.blocked,
        m.openCritical.length, m.openHigh.length, m.verdict ? verdictLabel[m.verdict] : this.VERDICT[g.verdict][1]]),
      { 0: { cellWidth: 40 } });
    y = paragraph([`Vonis aplikasi = vonis module terburuk; ada module tanpa test case = BELUM LENGKAP. Pass rate = test Pass / test yang sudah dijalankan. GO: pass rate >= ${ReportCalc.GO_PASS_RATE}%, semua test case dijalankan, tidak ada Blocked, tidak ada bug Critical/High terbuka. CONDITIONAL: pass rate >= ${ReportCalc.COND_PASS_RATE}%, tanpa Critical terbuka, High terbuka maks. ${ReportCalc.COND_MAX_HIGH_OPEN}.`], y - 5) + 6;
    if (g.openCritical.length || g.openHigh.length){
      y = sectionTitle('Bug Critical / High yang Masih Terbuka', y);
      y = table(y, ['ID', 'Judul', 'Module', 'Severity', 'Status'],
        [...g.openCritical, ...g.openHigh].map(b => [bugCode(b), b.title, b.module || '-', b.severity, b.status]), { 1: { cellWidth: 70 } });
    }

    y = sectionTitle(`Bug Sering Reopen / Retest (${r.rows.length} bug, total ${r.totalReopens}x)`, y);
    if (r.rows.length){
      y = table(y, ['ID', 'Judul', 'Module', 'Severity', 'Status', 'Reopen', 'Keterangan Terakhir'],
        r.rows.map(x => [bugCode(x.bug), x.bug.title, x.bug.module || '-', x.bug.severity || '-', x.bug.status, `${x.count}x`, x.lastNote || '-']),
        { 1: { cellWidth: 45 }, 6: { cellWidth: 45 } });
      y = table(y, ['Module', 'Bug Reopen', 'Total Reopen'], r.byModule.map(m => [m.module, m.bugs, `${m.reopens}x`]));
    } else {
      y = paragraph(['Belum ada bug yang dibuka ulang.'], y) + 6;
    }

    const speedWord = { FAST: 'Cepat', WATCH: 'Perlu perhatian', SLOW: 'Lambat', NA: 'Belum ada data' }[s.verdict];
    y = sectionTitle(`Kecepatan Penanganan Bug - ${speedWord}${s.measured ? ` (${s.onTimePct}% tepat waktu)` : ''}`, y);
    y = table(y, ['Severity', 'Target', 'Bug Selesai', 'Rata-rata Durasi', 'Tepat Waktu'],
      Object.entries(s.bySeverity).map(([sev, v]) => [sev, `${ReportCalc.SLA_DAYS[sev]} hari`, v.count, formatDuration(v.avgHours),
        v.count ? `${v.onTime}/${v.count} (${Math.round(v.onTime / v.count * 100)}%)` : '-']));
    if (s.unmeasured) y = paragraph([`${s.unmeasured} bug Closed tidak bisa diukur karena tidak punya riwayat status.`], y - 4) + 4;
    if (s.overdueOpen.length){
      y = sectionTitle('Bug Terbuka yang Melewati Target', y);
      table(y, ['ID', 'Judul', 'Severity', 'Status', 'Umur', 'Target'],
        s.overdueOpen.map(x => [bugCode(x.bug), x.bug.title, x.bug.severity || '-', x.bug.status, formatDuration(x.ageHours), formatDuration(x.slaHours)]),
        { 1: { cellWidth: 70 } });
    }

    const pages = doc.getNumberOfPages();
    for (let i = 1; i <= pages; i++){
      doc.setPage(i);
      doc.setFont('helvetica', 'normal'); doc.setFontSize(8); doc.setTextColor(...dim);
      doc.text(`BugRail - Go-Live Readiness Report  |  Halaman ${i} / ${pages}`, pageW / 2, pageH - 8, { align: 'center' });
    }
    doc.save(`GoLive_Report_${new Date().toISOString().slice(0, 10)}.pdf`);
  },

  setFilters(next){ this.filters = { ...this.filters, ...next }; this.open = null; this.render(); },

  bindStaticEvents(){
    const page = document.getElementById('page-report');
    page.addEventListener('click', e => {
      const el = e.target.closest('[data-act]');
      if (!el || el.disabled){
        if (this.open && !e.target.closest('.rpt-menu')){ this.open = null; this.render(); }
        return;
      }
      const v = el.dataset.value;
      switch (el.dataset.act){
        case 'toggle': this.open = this.open === el.dataset.dd ? null : el.dataset.dd; this.render(); break;
        case 'pick-module': this.setFilters({ module: v }); break;
        case 'pick-round': this.setFilters({ fileId: v }); break;
        case 'reset': this.setFilters({ module: '', fileId: this.ALL_FILES }); break;
        case 'clear': this.setFilters({ [el.dataset.key]: el.dataset.key === 'fileId' ? this.ALL_FILES : '' }); break;
        case 'copy': this.copySummary(); break;
        case 'pdf': this.exportPDF(); break;
        case 'export-reopen': this.exportReopenExcel(); break;
        case 'goto': App.goTo(el.dataset.page); break;
        case 'bug': BugReportModule.openDetail(el.dataset.id); break;
      }
    });
    // Close an open filter menu on outside click / Escape. composedPath() still holds
    // the report page even when its click handler already re-rendered the target away.
    document.addEventListener('click', e => {
      if (this.open && !e.composedPath().includes(page)){ this.open = null; this.render(); }
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && this.open){ this.open = null; this.render(); }
    });
  }
};

if (typeof document !== 'undefined') document.addEventListener('DOMContentLoaded', () => ReportModule.bindStaticEvents());
