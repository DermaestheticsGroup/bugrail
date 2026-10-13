// Pure logic for Dashboard, Summary, Report, Notifications and Activity Log over local rows.
// Local rows are snake_case; the domain calcs (lib/domain/{report,notifications,status}.ts) take the legacy camelCase records,
// so toDomain maps once. Bug statuses are codes; test case statuses keep their names.
import type { Row } from '../db-types';
import { normPriority } from '../domain/status';

const text = (v: unknown) => (typeof v === 'string' ? v : '');
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Rec = Record<string, any>;

// Files the workspace can see: its own plus those shared with it. '1' for the all-workspaces view.
export const FILE_SCOPE_SQL = 'file_id IN (SELECT f.id FROM files f WHERE f.deleted_at IS NULL AND (f.workspace_id = ? OR f.id IN (SELECT s.file_id FROM file_shares s WHERE s.workspace_id = ? AND s.deleted_at IS NULL)))';

export interface Dom { tcs: Rec[]; bugs: Rec[]; files: Rec[] }

export function toDomain(files: Row[], tcs: Row[], bugs: Row[], events: Row[]): Dom {
  const byBug = new Map<string, Row[]>();
  events.forEach((e) => { const k = text(e.bug_id); byBug.set(k, [...(byBug.get(k) ?? []), e]); });
  const at = (a: Row, b: Row) => text(a.at).localeCompare(text(b.at)) || text(a.id).localeCompare(text(b.id));
  return {
    files: files.map((f) => ({ id: f.id, name: text(f.name), createdAt: text(f.created_at) })),
    tcs: tcs.map((t) => ({ id: t.id, code: text(t.code), fileId: text(t.file_id), module: text(t.module), status: text(t.status), createdBy: text(t.created_by), executionDate: text(t.execution_date) })),
    bugs: bugs.map((b) => {
      const ev = (byBug.get(text(b.id)) ?? []).sort(at);
      return {
        id: b.id, code: text(b.code), fileId: text(b.file_id), title: text(b.title), module: text(b.module), severity: text(b.severity), priority: text(b.priority),
        status: text(b.status_code), tester: text(b.tester), assignee: text(b.assignee), reportDate: text(b.report_date),
        activity: ev.filter((e) => e.kind === 'status').map((e) => ({ at: text(e.at), email: text(e.email), from: text(e.from_status), to: text(e.to_status), note: text(e.note) })),
        assignments: ev.filter((e) => e.kind === 'assignment').map((e) => ({ at: text(e.at), by: text(e.email), to: text(e.assignee) })),
      };
    }),
  };
}

export interface RangeFilter { fileId: string; module: string; tester: string; dateFrom: string; dateTo: string }
export const emptyRange = (): RangeFilter => ({ fileId: '', module: '', tester: '', dateFrom: '', dateTo: '' });

// Legacy Summary.filteredTC: the date range applies to the execution date; a row with no date is never excluded by it.
export function filterTcs(tcs: Rec[], f: RangeFilter): Rec[] {
  return tcs.filter((t) => (!f.fileId || t.fileId === f.fileId) && (!f.module || t.module === f.module)
    && !(f.dateFrom && t.executionDate && t.executionDate < f.dateFrom) && !(f.dateTo && t.executionDate && t.executionDate > f.dateTo));
}
export function filterBugRange(bugs: Rec[], f: RangeFilter, ignoreFile = false): Rec[] {
  return bugs.filter((b) => {
    const day = b.reportDate ? String(b.reportDate).slice(0, 10) : '';
    return (ignoreFile || !f.fileId || b.fileId === f.fileId) && (!f.module || b.module === f.module) && (!f.tester || b.tester === f.tester)
      && !(f.dateFrom && day && day < f.dateFrom) && !(f.dateTo && day && day > f.dateTo);
  });
}

export function dashStats(tcs: Rec[], bugs: Rec[]) {
  const n = (arr: Rec[], key: string, val: string) => arr.filter((x) => x[key] === val).length;
  return {
    totalModule: new Set(tcs.map((t) => t.module).filter(Boolean)).size,
    totalTC: tcs.length, passed: n(tcs, 'status', 'Passed'), failed: n(tcs, 'status', 'Failed'), blocked: n(tcs, 'status', 'Blocked'),
    notrun: n(tcs, 'status', 'Open'), retest: n(tcs, 'status', 'Retest'),
    totalBug: bugs.length, critical: n(bugs, 'severity', 'Critical'), high: n(bugs, 'severity', 'High'), medium: n(bugs, 'severity', 'Medium'), low: n(bugs, 'severity', 'Low'),
    urgent: bugs.filter((b) => normPriority(b.priority) === 'Urgent').length, prioHigh: n(bugs, 'priority', 'High'), prioMedium: n(bugs, 'priority', 'Medium'), prioLow: n(bugs, 'priority', 'Low'),
  };
}

// Progress per module for the stacked bar: at most 8 modules, in first-seen order, as the legacy chart.
export function moduleBars(tcs: Rec[]): { module: string; passed: number; failed: number; other: number }[] {
  return [...new Set(tcs.map((t) => t.module).filter(Boolean))].slice(0, 8).map((m) => ({
    module: m,
    passed: tcs.filter((t) => t.module === m && t.status === 'Passed').length,
    failed: tcs.filter((t) => t.module === m && t.status === 'Failed').length,
    other: tcs.filter((t) => t.module === m && !['Passed', 'Failed'].includes(t.status)).length,
  }));
}

export function bugCountsByFile(bugs: Rec[], files: Rec[], f: RangeFilter): { name: string; count: number }[] {
  const counts: Record<string, number> = {};
  filterBugRange(bugs, f, true).forEach((b) => { counts[b.fileId || ''] = (counts[b.fileId || ''] || 0) + 1; });
  return Object.entries(counts).map(([id, count]) => ({ name: files.find((x) => x.id === id)?.name ?? 'Tanpa File', count })).sort((a, b) => b.count - a.count);
}

export function formatDuration(hours: number): string {
  if (!hours) return '—';
  if (hours < 1) return `${Math.round(hours * 60)} menit`;
  if (hours < 48) return `${Math.round(hours * 10) / 10} jam`;
  return `${Math.round(hours / 24 * 10) / 10} hari`;
}

const OPEN_CODES = ['OPEN', 'ASSIGNED', 'REOPENED'];
// Legacy Summary.buildAnalysis: findings and recommendations in Indonesian, from the filtered rows.
export function buildAnalysis(tcs: Rec[], bugs: Rec[], resolution: { resolvedCount: number; avgHours: number }, now = Date.now()) {
  const total = tcs.length;
  const c = (s: string) => tcs.filter((t) => t.status === s).length;
  const passed = c('Passed'), failed = c('Failed'), blocked = c('Blocked'), notrun = c('Open'), retest = c('Retest');
  const passRate = total ? Math.round(passed / total * 100) : 0;
  const failRate = total ? Math.round(failed / total * 100) : 0;
  const findings: string[] = [];
  const recs: string[] = [];

  if (!total) findings.push('Belum ada test case pada rentang filter ini.');
  else if (passRate >= 80) findings.push(`Progress testing baik: pass rate ${passRate}% (${passed}/${total} test case Passed).`);
  else if (passRate >= 50) { findings.push(`Progress testing masih moderat: pass rate ${passRate}% (${passed}/${total} test case Passed).`); recs.push('Percepat eksekusi test case yang masih Open agar coverage lebih representatif sebelum rilis.'); }
  else { findings.push(`Pass rate rendah: ${passRate}% (${passed}/${total} test case Passed).`); recs.push('Pass rate di bawah 50% berisiko tinggi untuk rilis, pertimbangkan menunda rilis sampai isu utama diperbaiki.'); }

  if (failed) {
    findings.push(`Terdapat ${failed} test case Failed (${failRate}%) yang berpotensi menghasilkan bug baru.`);
    if (!bugs.length) recs.push(`${failed} test case Failed belum punya bug report terkait, pastikan semua kegagalan sudah dicatat sebagai bug.`);
  }
  if (blocked) { findings.push(`${blocked} test case masih Blocked, kemungkinan menunggu dependency/environment.`); recs.push('Tindak lanjuti test case Blocked dengan tim terkait (environment/data/akses) agar tidak menghambat eksekusi.'); }
  if (notrun) findings.push(`${notrun} test case belum dieksekusi (Open).`);
  if (retest) findings.push(`${retest} test case berstatus Retest, menunggu verifikasi ulang setelah perbaikan.`);

  const mod: Record<string, { total: number; failed: number }> = {};
  tcs.forEach((t) => { if (!t.module) return; mod[t.module] = mod[t.module] || { total: 0, failed: 0 }; mod[t.module].total++; if (t.status === 'Failed') mod[t.module].failed++; });
  const risky = Object.entries(mod).filter(([, s]) => s.failed > 0).sort((a, b) => b[1].failed / b[1].total - a[1].failed / a[1].total).slice(0, 3);
  if (risky.length) {
    findings.push(`Modul dengan tingkat kegagalan tertinggi: ${risky.map(([m, s]) => `"${m}" (${s.failed}/${s.total})`).join(', ')}.`);
    recs.push(`Fokuskan regresi dan review kode pada modul "${risky[0][0]}" karena proporsi kegagalannya paling tinggi.`);
  }

  if (!bugs.length) findings.push('Tidak ada bug tercatat pada rentang filter ini.');
  else {
    const sev = (s: string) => bugs.filter((b) => b.severity === s).length;
    const open = bugs.filter((b) => OPEN_CODES.includes(b.status)).length;
    const reopened = bugs.filter((b) => b.status === 'REOPENED').length;
    const closed = bugs.filter((b) => b.status === 'CLOSED').length;
    findings.push(`${open} bug masih terbuka (Open/Assigned/Reopened), ${closed} bug sudah Closed dari total ${bugs.length} bug.`);
    if (sev('Critical')) { findings.push(`${sev('Critical')} bug berseverity Critical tercatat pada rentang ini.`); recs.push(`Prioritaskan ${sev('Critical')} bug Critical untuk diperbaiki sebelum rilis berikutnya, potensi dampak tinggi ke pengguna.`); }
    if (sev('High')) findings.push(`${sev('High')} bug berseverity High menunggu perbaikan.`);
    if (reopened) { findings.push(`${reopened} bug berstatus Reopened, menandakan perbaikan sebelumnya belum tuntas.`); recs.push('Telusuri root cause pada bug yang di-reopen agar fix berikutnya tidak berulang gagal.'); }

    const rounds = bugs.map((b) => ({ id: b.code || b.id, title: b.title, count: (b.activity as Rec[]).filter((a) => a.to === 'REOPENED' || a.to === 'RETEST').length }))
      .filter((r) => r.count > 0).sort((a, b) => b.count - a.count);
    if (rounds.length) {
      const sum = rounds.reduce((s, r) => s + r.count, 0);
      const chronic = rounds.filter((r) => r.count >= 3);
      findings.push(`${rounds.length} bug pernah retest (reopen) setidaknya 1x, total ${sum} kali retest.`);
      findings.push(`Distribusi retest: ${rounds.filter((r) => r.count === 1).length} bug retest 1x, ${rounds.filter((r) => r.count === 2).length} bug retest 2x, ${chronic.length} bug retest 3x atau lebih.`);
      if (chronic.length) {
        findings.push(`Bug retest kronis (>=3x): ${chronic.map((r) => `${r.id} - "${r.title}" (${r.count}x)`).join(', ')}.`);
        recs.push(`${chronic.length} bug sudah retest 3x atau lebih, indikasi fix kurang tuntas atau requirement kurang jelas; perlu review mendalam dan keterlibatan dev senior sebelum fix berikutnya.`);
      } else if (rounds[0].count > 1) {
        findings.push(`Bug paling sering retest: ${rounds[0].id} - "${rounds[0].title}" (${rounds[0].count}x reopen).`);
        recs.push(`Bug ${rounds[0].id} sudah retest ${rounds[0].count}x, review lebih dalam sebelum fix berikutnya; kemungkinan ada kasus yang belum tercover.`);
      }
    }
    if (resolution.resolvedCount) {
      findings.push(`Rata-rata waktu resolusi bug (Open -> Closed): ${formatDuration(resolution.avgHours)}, dihitung dari ${resolution.resolvedCount} bug.`);
      if (resolution.avgHours > 72) recs.push('Rata-rata waktu resolusi lebih dari 3 hari, evaluasi kembali prioritas assignment dan kapasitas tim development.');
    }
    const byTester: Record<string, number> = {};
    bugs.forEach((b) => { if (b.tester) byTester[b.tester] = (byTester[b.tester] || 0) + 1; });
    const top = Object.entries(byTester).sort((a, b) => b[1] - a[1])[0];
    if (top && Object.keys(byTester).length > 1) findings.push(`Tester dengan bug terbanyak dilaporkan: ${top[0]} (${top[1]} bug).`);
    const old = bugs.filter((b) => OPEN_CODES.includes(b.status) && b.reportDate && (now - new Date(b.reportDate).getTime()) / 36e5 > 168);
    if (old.length) recs.push(`${old.length} bug open sudah lebih dari 7 hari tanpa penyelesaian, perlu eskalasi.`);
  }
  if (!recs.length) recs.push('Tidak ada catatan risiko signifikan pada rentang filter ini, pertahankan ritme testing saat ini.');
  return { findings, recommendations: recs, passRate, failRate };
}

// Activity Log: same grouping and search as qa-app/js/activitylog.js.
export function actionGroupOf(action: string): string {
  if (action === 'login' || action === 'logout') return 'auth';
  if (action.startsWith('testcase_')) return 'testcase';
  if (action.startsWith('bugreport_')) return 'bugreport';
  if (action.startsWith('tc_file_') || action.startsWith('bug_file_')) return 'file';
  if (action.startsWith('user_') || action.startsWith('role_') || action.startsWith('workspace_')) return 'usermanagement';
  return 'other';
}
export interface ActivityUi { search: string; user: string; group: string; page: number; pageSize: number }
export const defaultActivityUi = (): ActivityUi => ({ search: '', user: '', group: '', page: 1, pageSize: 25 });
export function filterActivity(rows: Row[], ui: ActivityUi, wsName: (id: unknown) => string): Row[] {
  const words = ui.search.toLowerCase().trim().split(/\s+/).filter(Boolean);
  return rows.filter((e) => {
    if (ui.user && e.actor_email !== ui.user) return false;
    if (ui.group && actionGroupOf(text(e.action)) !== ui.group) return false;
    const hay = `${text(e.actor_email)} ${wsName(e.workspace_id)} ${text(e.label)}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  }).sort((a, b) => text(b.ts).localeCompare(text(a.ts)));
}

// Notifications: the bell's unread count compares event time against the last time the panel was opened on this device.
export const seenKey = (email: string) => `qa_notif_seen_${email.toLowerCase()}`;
// Compared as instants; if either side does not parse (an odd imported value) the string order is the fallback.
export function isNewer(at: string, seen: string): boolean {
  if (!seen) return true;
  const a = Date.parse(at), s = Date.parse(seen);
  return Number.isNaN(a) || Number.isNaN(s) ? at > seen : a > s;
}
export const unreadCount = (events: Rec[], seen: string) => events.filter((e) => isNewer(e.at, seen)).length;
