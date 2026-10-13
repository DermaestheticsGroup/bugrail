'use client';
// Dashboard, Summary, Report and Activity Log. Charts are plain SVG/CSS bars: no chart dependency, nothing to load offline.
import { useMemo, useState } from 'react';
import { ALL_WS } from '@/lib/client/nav';
import {
  FILE_SCOPE_SQL, actionGroupOf, bugCountsByFile, buildAnalysis, dashStats, defaultActivityUi, emptyRange, filterActivity, filterBugRange, filterTcs,
  formatDuration, moduleBars, toDomain, type Dom, type RangeFilter, type Rec,
} from '@/lib/client/analytics';
import { can } from '@/lib/domain/auth';
import { computeBugResolutionStats } from '@/lib/domain/status';
import { ReportCalc } from '@/lib/domain/report';
import { useApp } from './app-provider';
import { useLive } from './use-live';

const scope = (ws: string) => (ws === ALL_WS ? { sql: 'file_id IN (SELECT id FROM files WHERE deleted_at IS NULL)', params: [] as string[] } : { sql: FILE_SCOPE_SQL, params: [ws, ws] });

function useDomain(ws: string): Dom | null {
  const s = scope(ws);
  const files = useLive(`SELECT id, name, created_at FROM files WHERE deleted_at IS NULL AND ${ws === ALL_WS ? '1' : '(workspace_id = ? OR id IN (SELECT file_id FROM file_shares WHERE workspace_id = ? AND deleted_at IS NULL))'} ORDER BY rowid`, s.params);
  const tcs = useLive(`SELECT * FROM testcases WHERE deleted_at IS NULL AND (${s.sql})`, s.params);
  const bugs = useLive(`SELECT * FROM bugs WHERE deleted_at IS NULL AND (${s.sql})`, s.params);
  const events = useLive(`SELECT * FROM bug_events WHERE kind IN ('status','assignment') AND bug_id IN (SELECT id FROM bugs WHERE deleted_at IS NULL AND (${s.sql}))`, s.params);
  return useMemo(() => (files && tcs && bugs && events ? toDomain(files, tcs, bugs, events) : null), [files, tcs, bugs, events]);
}

const COLORS = { passed: '#1E9E6B', failed: '#D64550', other: '#8A93A6', crit: '#B0203A', high: '#D64550', med: '#D98A2B', low: '#4E88C7' };

function Card({ label, value, sub, pct, testid }: { label: string; value: React.ReactNode; sub: string; pct: number; testid: string }) {
  return (
    <div data-testid={testid}>
      <strong>{label}</strong> <span data-testid={`${testid}-value`}>{value}</span> <small>{sub}</small>
      <div style={{ background: '#E3E7ED', height: 4 }}><div style={{ width: `${Math.min(pct, 100)}%`, background: '#2F6FED', height: 4 }} /></div>
    </div>
  );
}

function Bars({ rows, color }: { rows: { label: string; value: number }[]; color: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return <div>{rows.map((r) => <div key={r.label}><span>{r.label}</span> <span style={{ display: 'inline-block', width: `${Math.round(r.value / max * 100)}%`, minWidth: 2, height: 8, background: color }} /> {r.value}</div>)}</div>;
}

function Donut({ title, labels, counts, colors, testid }: { title: string; labels: string[]; counts: number[]; colors: string[]; testid: string }) {
  const total = counts.reduce((a, b) => a + b, 0);
  const R = 40, C = 2 * Math.PI * R;
  let off = 0;
  return (
    <div data-testid={testid}>
      <h4>{title}</h4>
      <svg width="110" height="110" viewBox="0 0 110 110" role="img" aria-label={title}>
        <circle cx="55" cy="55" r={R} fill="none" stroke="#E3E7ED" strokeWidth="14" />
        {total ? counts.map((n, i) => { const len = n / total * C; const el = <circle key={labels[i]} cx="55" cy="55" r={R} fill="none" stroke={colors[i]} strokeWidth="14" strokeDasharray={`${len} ${C - len}`} strokeDashoffset={-off} transform="rotate(-90 55 55)" />; off += len; return el; }) : null}
        <text x="55" y="58" textAnchor="middle">{total}</text>
      </svg>
      <ul>{labels.map((l, i) => <li key={l}><span style={{ color: colors[i] }}>●</span> {l}: {counts[i]} ({total ? Math.round(counts[i] / total * 1000) / 10 : 0}%)</li>)}</ul>
    </div>
  );
}

function Filters({ f, setF, dom, withFile }: { f: RangeFilter; setF: (x: RangeFilter) => void; dom: Dom; withFile: boolean }) {
  const mods = [...new Set([...dom.tcs, ...dom.bugs].map((x) => x.module).filter(Boolean))].sort();
  const testers = [...new Set(dom.bugs.map((b) => b.tester).filter(Boolean))].sort();
  const set = (p: Partial<RangeFilter>) => setF({ ...f, ...p });
  return (
    <div role="search">
      {withFile ? <select aria-label="File filter" value={f.fileId} onChange={(e) => set({ fileId: e.target.value })}><option value="">Semua file</option>{dom.files.map((x) => <option key={x.id} value={x.id}>{x.name}</option>)}</select> : null}
      <select aria-label="Module filter" value={f.module} onChange={(e) => set({ module: e.target.value })}><option value="">Semua module</option>{mods.map((m) => <option key={m}>{m}</option>)}</select>
      <select aria-label="Tester filter" value={f.tester} onChange={(e) => set({ tester: e.target.value })}><option value="">Semua tester</option>{testers.map((m) => <option key={m}>{m}</option>)}</select>
      <input type="date" aria-label="Date from" value={f.dateFrom} onChange={(e) => set({ dateFrom: e.target.value })} />
      <input type="date" aria-label="Date to" value={f.dateTo} onChange={(e) => set({ dateTo: e.target.value })} />
      <button type="button" onClick={() => setF(emptyRange())}>Reset filters</button>
    </div>
  );
}

function Rollup({ tcs, bugs }: { tcs: Rec[]; bugs: Rec[] }) {
  const s = dashStats(tcs, bugs);
  const res = computeBugResolutionStats(bugs as never);
  const pct = (n: number) => (s.totalTC ? Math.round(n / s.totalTC * 1000) / 10 : 0);
  const passRate = s.totalTC ? Math.round(s.passed / s.totalTC * 100) : 0;
  const sub = (n: number) => `${pct(n)}% dari total test case`;
  const bars = moduleBars(tcs);
  return (
    <div>
      <h2>DASHBOARD</h2>
      <Card testid="c-module" label="Total Module" value={s.totalModule} sub="100% dari keseluruhan" pct={100} />
      <Card testid="c-tc" label="Total Test Case" value={s.totalTC} sub="100% dari keseluruhan" pct={100} />
      <Card testid="c-open" label="Total Open" value={s.notrun} sub={sub(s.notrun)} pct={pct(s.notrun)} />
      <Card testid="c-passed" label="Total Passed" value={s.passed} sub={sub(s.passed)} pct={pct(s.passed)} />
      <Card testid="c-blocked" label="Total Blocked" value={s.blocked} sub={sub(s.blocked)} pct={pct(s.blocked)} />
      <Card testid="c-failed" label="Total Failed" value={s.failed} sub={sub(s.failed)} pct={pct(s.failed)} />
      <Card testid="c-retest" label="Total Retest" value={s.retest} sub={sub(s.retest)} pct={pct(s.retest)} />
      <p data-testid="overall">Overall Test Case Progress: <b>{passRate}%</b> ({s.passed} / {s.totalTC} Passed)</p>
      <h2>BUG REPORT SUMMARY</h2>
      <Card testid="c-bug" label="Total Bug" value={s.totalBug} sub="100% dari keseluruhan bug" pct={100} />
      <p data-testid="dev-time">Pengerjaan Developer: {formatDuration(res.avgHours)} (Open → Closed, dari {res.resolvedCount} bug terukur)</p>
      <Donut testid="d-severity" title="Distribusi Severity" labels={['Critical', 'High', 'Medium', 'Low']} counts={[s.critical, s.high, s.medium, s.low]} colors={[COLORS.crit, COLORS.high, COLORS.med, COLORS.low]} />
      <Donut testid="d-priority" title="Distribusi Priority" labels={['Urgent', 'High', 'Medium', 'Low']} counts={[s.urgent, s.prioHigh, s.prioMedium, s.prioLow]} colors={[COLORS.crit, COLORS.high, COLORS.med, COLORS.low]} />
      <h3>Progress Testing per Module</h3>
      <div data-testid="module-bars">
        {bars.length ? bars.map((b) => (
          <div key={b.module}>{b.module}: <span style={{ color: COLORS.passed }}>Passed {b.passed}</span>, <span style={{ color: COLORS.failed }}>Failed {b.failed}</span>, Lainnya (Open/Blocked/Retest) {b.other}</div>
        )) : <p>Belum ada data</p>}
      </div>
    </div>
  );
}

export function Dashboard({ ws }: { ws: string }) {
  const dom = useDomain(ws);
  const [f, setF] = useState(emptyRange);
  if (!dom) return <p>Loading…</p>;
  // Dashboard has no file or date filters in the legacy page: module and tester only.
  const tcs = filterTcs(dom.tcs, { ...f, fileId: '', dateFrom: '', dateTo: '' });
  const bugs = filterBugRange(dom.bugs, { ...f, fileId: '', dateFrom: '', dateTo: '' });
  return (
    <section>
      <Filters f={f} setF={(x) => setF({ ...x, fileId: '', dateFrom: '', dateTo: '' })} dom={dom} withFile={false} />
      <Rollup tcs={tcs} bugs={bugs} />
    </section>
  );
}

export function Summary({ ws }: { ws: string }) {
  const dom = useDomain(ws);
  const [f, setF] = useState(emptyRange);
  if (!dom) return <p>Loading…</p>;
  const tcs = filterTcs(dom.tcs, f);
  const bugs = filterBugRange(dom.bugs, f);
  const a = buildAnalysis(tcs, bugs, computeBugResolutionStats(bugs as never));
  const perFile = bugCountsByFile(dom.bugs, dom.files, f);
  return (
    <section>
      <Filters f={f} setF={setF} dom={dom} withFile />
      <Rollup tcs={tcs} bugs={bugs} />
      {perFile.length ? <div data-testid="bug-per-file"><h3>Bug per File</h3><Bars rows={perFile.map((r) => ({ label: r.name, value: r.count }))} color={COLORS.failed} /></div> : null}
      <h3>Analisa</h3>
      <ul data-testid="findings">{a.findings.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <h3>Rekomendasi</h3>
      <ul data-testid="recommendations">{a.recommendations.map((x, i) => <li key={i}>{x}</li>)}</ul>
      <button type="button" onClick={() => window.print()}>Print / Save as PDF</button>
    </section>
  );
}

const VERDICT: Record<string, string> = { GO: 'GO', CONDITIONAL: 'CONDITIONAL GO', NO_GO: 'NO GO', EMPTY: 'BELUM BISA DINILAI', INCOMPLETE: 'BELUM LENGKAP', UNRATED: 'BELUM DINILAI' };

export function Report({ ws }: { ws: string }) {
  const dom = useDomain(ws);
  const [fileId, setFileId] = useState('');
  const [module, setModule] = useState('');
  if (!dom) return <p>Loading…</p>;
  const opts = ReportCalc.scopeOptions(dom.tcs, dom.bugs, dom.files, { fileId, module });
  const inScope = (x: Rec) => (!fileId || x.fileId === fileId) && (!module || ReportCalc.moduleOf(x) === module);
  const tcs = dom.tcs.filter(inScope);
  const bugs = dom.bugs.filter(inScope);
  const g = ReportCalc.goLive(tcs, bugs);
  const r = ReportCalc.reopenStats(bugs);
  const s = ReportCalc.speedStats(bugs);
  const biz = ReportCalc.businessSummary(g, r, s);
  const fix = ReportCalc.mustFix(g);
  const codeOf = (b: Rec) => b.code || b.id;
  return (
    <section>
      <div role="search">
        <select aria-label="Round filter" value={fileId} onChange={(e) => setFileId(e.target.value)}>
          <option value="">Semua round ({opts.allRoundsCount})</option>
          {opts.rounds.map((x) => <option key={x.id} value={x.id} disabled={x.disabled}>{x.name} ({x.count}){x.why ? ` — ${x.why}` : ''}</option>)}
        </select>
        <select aria-label="Module filter" value={module} onChange={(e) => setModule(e.target.value)}>
          <option value="">Semua module ({opts.allModulesCount})</option>
          {opts.modules.map((x) => <option key={x.name} value={x.name} disabled={x.disabled}>{x.name} ({x.count}){x.why ? ` — ${x.why}` : ''}</option>)}
        </select>
      </div>
      <h2 data-testid="verdict" data-verdict={g.verdict}>{VERDICT[g.verdict ?? ''] ?? g.verdict}</h2>
      <p data-testid="verdict-text">{biz.verdictText}</p>
      {g.reason ? <p data-testid="reason">{g.reason}</p> : null}
      <p data-testid="pass-rate">Pass rate: {g.passRate === null ? '—' : `${g.passRate}%`} ({g.passed} / {g.executed} dieksekusi, {g.total} total)</p>
      {fix.items.length ? <div data-testid="must-fix"><h3>Harus selesai sebelum go-live</h3><ul>{fix.items.map((x, i) => <li key={i}>{x}</li>)}</ul>{fix.more ? <p>… dan {fix.more} lainnya</p> : null}</div> : null}
      <h3>Per module</h3>
      <table data-testid="module-table">
        <thead><tr><th>Module</th><th>Vonis</th><th>Pass rate</th><th>Passed</th><th>Blocked</th><th>Belum jalan</th><th>Critical terbuka</th><th>High terbuka</th></tr></thead>
        <tbody>{g.modules.map((m: Rec) => (
          <tr key={m.module} data-verdict={m.verdict}><td>{m.module}</td><td>{VERDICT[m.verdict]}</td><td>{m.passRate === null ? '—' : `${m.passRate}%`}</td><td>{m.passed}/{m.total}</td><td>{m.blocked}</td><td>{m.notRun}</td><td>{m.openCritical.length}</td><td>{m.openHigh.length}</td></tr>
        ))}</tbody>
      </table>
      <h3>Ringkasan untuk PM &amp; BA</h3>
      <ul data-testid="business-points">{biz.points.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
      <h3>Langkah berikutnya</h3>
      <ul>{biz.nextSteps.map((x: string, i: number) => <li key={i}>{x}</li>)}</ul>
      <h3>Bug yang dibuka kembali</h3>
      <p data-testid="reopen-total">{r.rows.length} bug, total {r.totalReopens} kali</p>
      <ul>{r.rows.map((x: Rec) => <li key={x.bug.id}>{codeOf(x.bug)} — {x.bug.title} ({x.count}x){x.lastNote ? `: ${x.lastNote}` : ''}</li>)}</ul>
      <h3>Kecepatan perbaikan</h3>
      <p data-testid="speed">{s.verdict === 'NA' ? 'Belum ada bug Closed yang terukur.' : `${s.onTimePct}% sesuai target (${s.onTime}/${s.measured})`}{s.unmeasured ? `, ${s.unmeasured} tidak terukur` : ''}</p>
      <ul>{s.overdueOpen.map((o: Rec) => <li key={o.bug.id}>{codeOf(o.bug)} {o.bug.severity} terbuka {formatDuration(o.ageHours)} (target {formatDuration(o.slaHours)})</li>)}</ul>
      <button type="button" onClick={() => window.print()}>Print / Save as PDF</button>
    </section>
  );
}

export function Activity({ ws }: { ws: string }) {
  const app = useApp();
  const [ui, setUi] = useState(defaultActivityUi);
  const [open, setOpen] = useState<string | null>(null);
  const rows = useLive('SELECT * FROM activity_log ORDER BY ts DESC');
  const wsRows = useLive('SELECT id, name FROM workspaces');
  if (!app.config) return null;
  if (!can({ role: app.config.me.role }, 'activitylog', app.config.rolePermissions)) return <p data-testid="no-access">Anda tidak punya akses ke halaman ini.</p>;
  const wsName = (id: unknown) => (!id ? '(Semua / Shared)' : String((wsRows ?? []).find((w) => w.id === id)?.name ?? app.config!.workspaces.find((w) => w.id === id)?.name ?? '(workspace dihapus)'));
  const all = rows ?? [];
  const list = filterActivity(all, ui, wsName);
  const pages = Math.max(1, Math.ceil(list.length / ui.pageSize));
  const page = Math.min(ui.page, pages);
  const shown = list.slice((page - 1) * ui.pageSize, page * ui.pageSize);
  const users = [...new Set(all.map((e) => String(e.actor_email ?? '')).filter(Boolean))].sort();
  const set = (p: Partial<typeof ui>) => setUi((u) => ({ ...u, ...p, page: 'page' in p ? p.page! : 1 }));
  const detail = open ? all.find((e) => e.id === open) : null;
  void ws;
  return (
    <section>
      <div role="search">
        <input aria-label="Search" value={ui.search} onChange={(e) => set({ search: e.target.value })} />
        <select aria-label="User filter" value={ui.user} onChange={(e) => set({ user: e.target.value })}><option value="">Semua user</option>{users.map((u) => <option key={u}>{u}</option>)}</select>
        <select aria-label="Action filter" value={ui.group} onChange={(e) => set({ group: e.target.value })}>
          <option value="">Semua aksi</option>
          {[['auth', 'Login/Logout'], ['testcase', 'Test Case'], ['bugreport', 'Bug Report'], ['file', 'File'], ['usermanagement', 'User Management'], ['other', 'Lainnya']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      {list.length === 0 ? <p data-testid="activity-empty">Belum ada aktivitas.</p> : (
        <table data-testid="activity-table">
          <thead><tr><th>Waktu</th><th>User</th><th>Role</th><th>Workspace</th><th>Aksi</th><th>Keterangan</th></tr></thead>
          <tbody>{shown.map((e) => (
            <tr key={String(e.id)} tabIndex={0} onClick={() => setOpen(String(e.id))} onKeyDown={(k) => { if (k.key === 'Enter' || k.key === ' ') { k.preventDefault(); setOpen(String(e.id)); } }} style={{ cursor: 'pointer' }}>
              <td>{new Date(String(e.ts)).toLocaleString()}</td><td>{String(e.actor_email ?? '-')}</td><td>{String(e.actor_role ?? '-')}</td><td>{wsName(e.workspace_id)}</td><td>{String(e.action)}</td><td>{String(e.label)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
      <p data-testid="activity-info">Menampilkan {shown.length} dari {list.length} aktivitas</p>
      <button type="button" disabled={page <= 1} onClick={() => set({ page: page - 1 })}>Prev</button> {page} / {pages}{' '}
      <button type="button" disabled={page >= pages} onClick={() => set({ page: page + 1 })}>Next</button>
      {detail ? (
        <dialog open aria-label="Activity detail">
          <p><b>{String(detail.action)}</b> ({actionGroupOf(String(detail.action))})</p>
          <p>{String(detail.label)}</p><p>{String(detail.actor_email)} · {String(detail.actor_role)} · {wsName(detail.workspace_id)}</p><p>{new Date(String(detail.ts)).toLocaleString()}</p>
          <button type="button" onClick={() => setOpen(null)}>Close</button>
        </dialog>
      ) : null}
    </section>
  );
}

