// Ported from qa-app/js/report.js (ReportCalc only; rendering stays in the UI layer).
// Bug statuses are codes (CLOSED, REJECTED, REOPENED, RETEST); test case statuses keep their names.
// Rows come from the DB layer as loose records until Phase 3 types them.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Rec = Record<string, any>;
type Bug = Rec;
type Tc = Rec;

export const ReportCalc = {
  // Thresholds — tweak here. ponytail: constants, move to Settings if PM/BA need to change them often.
  GO_PASS_RATE: 95,
  COND_PASS_RATE: 90,
  COND_MAX_HIGH_OPEN: 2,
  SLA_DAYS: <Record<string, number>>{ Critical: 1, High: 3, Medium: 7, Low: 14 },
  SPEED_FAST_PCT: 80,
  SPEED_OK_PCT: 50,
  DONE_STATUSES: ['CLOSED', 'REJECTED'],       // Resolved is not done: QA hasn't verified it yet
  REOPEN_STATUSES: ['REOPENED', 'RETEST'],     // same as BugReportModule.reopenCount

  isOpen(bug: Bug){ return !this.DONE_STATUSES.includes(bug.status); },
  moduleOf(x: Rec){ return x.module || '(Tanpa Module)'; },
  RISK: <Record<string, number>>{ UNRATED: 0, NO_GO: 1, CONDITIONAL: 2, GO: 3 }, // table order: riskiest first

  /* Verdict is judged per module; the app verdict is the worst module
     (one NO GO module = app NO GO). App verdict values:
     EMPTY      — no test case in scope at all (never shown as NO GO)
     INCOMPLETE — some module in scope has no test case; `provisional` = worst rated module
     GO / CONDITIONAL / NO_GO. Totals are kept for cards and summary text. */
  goLive(tcs: Tc[], bugs: Bug[]){
    const names = [...new Set([...tcs, ...bugs].map(x => this.moduleOf(x)))];
    const modules = names.map(m => ({ module: m, ...this.evaluate(tcs.filter(t => this.moduleOf(t) === m), bugs.filter(b => this.moduleOf(b) === m)) }))
      .sort((a, b) => this.RISK[a.verdict] - this.RISK[b.verdict] || (a.passRate ?? -1) - (b.passRate ?? -1) || a.module.localeCompare(b.module));
    const rated = modules.filter(m => m.verdict !== 'UNRATED');
    const counts: Record<string, number> = { GO: 0, CONDITIONAL: 0, NO_GO: 0, UNRATED: 0 };
    modules.forEach(m => counts[m.verdict]++);
    const provisional = rated.length ? rated.reduce((w, m) => this.RISK[m.verdict] < this.RISK[w] ? m.verdict : w, 'GO') : null;
    const verdict = !tcs.length ? 'EMPTY' : counts.UNRATED ? 'INCOMPLETE' : provisional;
    return { ...this.evaluate(tcs, bugs), verdict, provisional, modules, counts };
  },

  /* Pass rate = Passed / executed (anything but Open; Blocked counts as attempted).
     null = nothing executed yet — shown as "—", never 0. */
  evaluate(tcs: Tc[], bugs: Bug[]){
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
    // passRate is null only when nothing ran; null compares false against every threshold, as before.
    const rate = passRate as number;
    if (!total) verdict = 'UNRATED';
    else if (rate >= this.GO_PASS_RATE && !notRun && !blocked && !openCritical.length && !openHigh.length) verdict = 'GO';
    else if (rate >= this.COND_PASS_RATE && !openCritical.length && openHigh.length <= this.COND_MAX_HIGH_OPEN) verdict = 'CONDITIONAL';

    // Reason sentence, fixed priority order (spec §4).
    const problems = [];
    if (openCritical.length) problems.push(`${openCritical.length} bug Critical terbuka`);
    if (total && passRate === null) problems.push('belum ada test yang dijalankan');
    else if (total && rate < this.GO_PASS_RATE) problems.push(`pass rate ${passRate}% (target ${this.GO_PASS_RATE}%)`);
    if (blocked) problems.push(`${blocked} test Blocked`);
    if (openHigh.length) problems.push(`${openHigh.length} bug High terbuka`);
    if (notRun && executed) problems.push(`${notRun} test belum jalan`);
    const reason = verdict === 'GO' ? 'Semua kriteria GO terpenuhi.'
      : problems.length ? `Tertahan karena ${problems.join(', ')}.` : '';

    return { verdict, total, passed, notRun, blocked, executed, passRate, openBugs, openCritical, openHigh, problems, reason };
  },

  /* "Harus selesai sebelum go-live": concrete items from the worst modules
     (NO GO first, then CONDITIONAL), capped at `limit`. */
  mustFix(g: Rec, codeOf: (b: Bug) => string = b => b.code || b.id, limit = 5){
    const items: string[] = [];
    g.modules.filter((m: Rec) => m.verdict === 'NO_GO' || m.verdict === 'CONDITIONAL').forEach((m: Rec) => {
      const target = m.verdict === 'NO_GO' ? this.COND_PASS_RATE : this.GO_PASS_RATE;
      m.openCritical.forEach((b: Bug) => items.push(`Tutup ${codeOf(b)} (Critical) — ${b.title || ''}`.trim()));
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
  scopeOptions(tcs: Tc[], bugs: Bug[], files: Rec[], { fileId = '', module = '' }: { fileId?: string; module?: string } = {}){
    const inFile = (x: Rec) => !fileId || x.fileId === fileId;
    const inModule = (x: Rec) => !module || this.moduleOf(x) === module;
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

  reopenStats(bugs: Bug[]){
    const rows = bugs.map(b => {
      const reopens = (b.activity || []).filter((a: Rec) => this.REOPEN_STATUSES.includes(a.to));
      const last = reopens[reopens.length - 1];
      return { bug: b, count: reopens.length, lastNote: last ? (last.note || '') : '' };
    }).filter(r => r.count > 0).sort((a, b) => b.count - a.count);

    const moduleMap: Record<string, { module: string; bugs: number; reopens: number }> = {};
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
  speedStats(bugs: Bug[], now = Date.now()){
    const slaHours = (sev: string) => (this.SLA_DAYS[sev] || this.SLA_DAYS.Medium) * 24;
    const bySeverity: Record<string, Rec> = {};
    Object.keys(this.SLA_DAYS).forEach(s => { bySeverity[s] = { count: 0, onTime: 0, totalHours: 0 }; });
    let measured = 0, onTime = 0, unmeasured = 0;
    const overdueOpen: Rec[] = [];

    bugs.forEach(b => {
      const sev = this.SLA_DAYS[b.severity] ? b.severity : 'Medium';
      if (b.status === 'CLOSED'){
        const closed = (b.activity || []).filter((a: Rec) => a.to === 'CLOSED');
        const hours = closed.length && b.reportDate ? (new Date(closed[closed.length - 1].at).getTime() - new Date(b.reportDate).getTime()) / 36e5 : NaN;
        if (!(hours >= 0)){ unmeasured++; return; }
        measured++;
        bySeverity[sev].count++;
        bySeverity[sev].totalHours += hours;
        if (hours <= slaHours(sev)){ onTime++; bySeverity[sev].onTime++; }
      } else if (this.isOpen(b) && b.reportDate){
        const age = (now - new Date(b.reportDate).getTime()) / 36e5;
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
  businessSummary(g: Rec, r: Rec, s: Rec){
    const verdictText = ({
      EMPTY: 'Kesiapan go-live BELUM BISA DINILAI — belum ada skenario pengujian yang tercatat.',
      INCOMPLETE: 'Report BELUM LENGKAP — sebagian module belum punya skenario pengujian, jadi vonis go-live belum final.',
      GO: 'Aplikasi SIAP untuk go-live — semua module memenuhi kriteria.',
      CONDITIONAL: 'Aplikasi SIAP go-live DENGAN SYARAT — beberapa masalah penting di module tertentu harus disepakati penanganannya dulu.',
      NO_GO: 'Aplikasi BELUM SIAP untuk go-live — ada module yang belum memenuhi kriteria.'
    } as Record<string, string>)[g.verdict];
    const points = [];
    const reasons = (m: Rec) => {
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
    const byVerdict = (v: string) => (g.modules || []).filter((m: Rec) => m.verdict === v);
    if (byVerdict('GO').length) points.push(`Module siap go-live: ${byVerdict('GO').map((m: Rec) => m.module).join(', ')}.`);
    if (byVerdict('CONDITIONAL').length) points.push(`Module siap dengan syarat: ${byVerdict('CONDITIONAL').map((m: Rec) => `${m.module} (${reasons(m)})`).join('; ')}.`);
    if (byVerdict('NO_GO').length) points.push(`Module belum siap: ${byVerdict('NO_GO').map((m: Rec) => `${m.module} (${reasons(m)})`).join('; ')}.`);
    if (byVerdict('UNRATED').length) points.push(`Module belum dinilai karena belum ada skenario pengujian: ${byVerdict('UNRATED').map((m: Rec) => m.module).join(', ')}.`);
    if (g.verdict === 'INCOMPLETE' && g.provisional){
      points.push(`Vonis sementara dari module yang sudah diuji: ${({ GO: 'GO', CONDITIONAL: 'CONDITIONAL GO', NO_GO: 'NO GO' } as Record<string, string>)[g.provisional]}.`);
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
    const titles = (list: Rec) => list.slice(0, 3).map((b: Rec) => `"${b.title}"`).join(', ') + (list.length > 3 ? `, dan ${list.length - 3} lainnya` : '');
    if (g.openCritical.length) points.push(`Masih ada ${g.openCritical.length} masalah KRITIS yang bisa menghentikan proses bisnis utama: ${titles(g.openCritical)}.`);
    if (g.openHigh.length) points.push(`Masih ada ${g.openHigh.length} masalah BERAT yang mengganggu pengguna: ${titles(g.openHigh)}.`);
    if (!g.openCritical.length && !g.openHigh.length && g.total) points.push('Tidak ada masalah kritis atau berat yang masih terbuka.');

    if (r.rows.length){
      const worst = r.byModule[0];
      points.push(`${r.rows.length} masalah muncul kembali setelah dinyatakan sudah diperbaiki (total ${r.totalReopens} kali). Area paling sering bermasalah: ${worst.module}. Ini tanda perbaikan belum tuntas.`);
    }

    if (s.verdict !== 'NA'){
      const speedWord = ({ FAST: 'cepat', WATCH: 'cukup, namun perlu perhatian', SLOW: 'lambat' } as Record<string, string>)[s.verdict];
      points.push(`Kecepatan perbaikan ${speedWord}: ${s.onTimePct}% masalah diselesaikan sesuai target waktu.`);
    }
    if (s.overdueOpen.length) points.push(`${s.overdueOpen.length} masalah yang masih terbuka sudah melewati target waktu penyelesaian.`);

    const nextSteps = [];
    if (!g.total) nextSteps.push('Tim QA menambahkan skenario pengujian, menjalankannya, lalu mencatat bug yang ditemukan — report terisi otomatis.');
    if (byVerdict('UNRATED').length && g.total) nextSteps.push(`Tambahkan skenario pengujian untuk module yang belum dinilai (${byVerdict('UNRATED').map((m: Rec) => m.module).join(', ')}).`);
    if (g.openCritical.length) nextSteps.push('Selesaikan dan uji ulang semua masalah kritis sebelum menjadwalkan go-live.');
    if (g.openHigh.length) nextSteps.push(g.verdict === 'CONDITIONAL'
      ? 'Putuskan bersama tim developer & QA: masalah berat yang tersisa diperbaiki sebelum go-live, atau diterima dengan solusi sementara (workaround) dan jadwal perbaikan.'
      : 'Prioritaskan perbaikan masalah berat yang masih terbuka.');
    if (g.notRun || g.blocked) nextSteps.push('Tuntaskan pengujian skenario yang belum diuji / terhambat agar seluruh fitur terverifikasi.');
    if (r.rows.some((x: Rec) => x.count >= 3)) nextSteps.push('Masalah yang berulang 3 kali atau lebih perlu dibahas bersama tim developer dan BA — kemungkinan kebutuhan (requirement) belum jelas.');
    if (s.verdict === 'SLOW' || s.overdueOpen.length) nextSteps.push('Evaluasi kapasitas dan prioritas tim developer agar perbaikan sesuai target waktu.');
    if (!nextSteps.length) nextSteps.push('Lanjutkan persiapan go-live (sosialisasi pengguna, rencana rollback, dan monitoring setelah rilis).');

    return { verdictText, points, nextSteps };
  }
};
