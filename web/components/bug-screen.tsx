'use client';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useEffect, useMemo, useState } from 'react';
import { can } from '@/lib/domain/auth';
import { BUG_FORM } from '@/lib/domain/forms';
import { stepsHtmlToText } from '@/lib/domain/steps';
import { hrefFor } from '@/lib/client/nav';
import { BugFormError, addComment, bugTimeline, changeStatus, deleteBugs, emptyBugForm, saveBug, type BugForm, type StatusChange } from '@/lib/client/bugs';
import {
  SEVERITIES, boardColumns, bugCodeOf, defaultBugUi, filterBugs, inferPlatform, readExtra, reopenCount, similarBugs,
  statusMaster, statusName, statusRule, tcPrefill, QA_BLOCK_MESSAGE,
} from '@/lib/client/bug-model';
import { effectiveSelection, paginate, uniqueValues } from '@/lib/client/testcase-model';
import type { Row } from '@/lib/db-types';
import { useApp } from './app-provider';
import { FileList } from './file-list';
import { useStatusNote } from './status-note';
import { useLive } from './use-live';

const s = (v: unknown) => (typeof v === 'string' ? v : '');
const when = (v: unknown) => (s(v) ? new Date(s(v)).toLocaleString() : '-');

export default function BugScreen({ ws, rest }: { ws: string; rest: string[] }) {
  const fileId = rest[0] ? decodeURIComponent(rest[0]) : null;
  if (!fileId) return <FileList ws={ws} area="bugs" />;
  if (rest[1] === 'board') return <BugFile ws={ws} fileId={fileId} view="board" />;
  if (rest[1]) return <BugDetail ws={ws} fileId={fileId} bugId={decodeURIComponent(rest[1])} />;
  return <BugFile ws={ws} fileId={fileId} view="table" />;
}

function useBugCan() {
  const app = useApp();
  const role = app.config!.me.role;
  const perms = app.config!.rolePermissions;
  const c = (k: string) => can({ role }, k, perms);
  return {
    can: c, role, isAdmin: role === 'admin',
    // Legacy: QA is whoever holds bugreport_statusQA and is not an admin.
    isQA: role !== 'admin' && c('bugreport_statusQA'),
    canEdit: c('bugreport_update') || c('bugreport_updateStatusPriority'),
  };
}

function useMaster(dep = 0) {
  const rows = useLive('SELECT id, name, color, sort_order, deleted_at FROM bug_status_master', [], dep);
  return useMemo(() => statusMaster(rows ?? []), [rows]);
}

function BugFile({ ws, fileId, view }: { ws: string; fileId: string; view: 'table' | 'board' }) {
  const app = useApp();
  const c = useBugCan();
  const { dialog, ask } = useStatusNote();
  const params = useSearchParams();
  const fromTc = params.get('newFromTc');
  const [n, setN] = useState(0);
  const [ui, setUi] = useState(defaultBugUi);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [form, setForm] = useState<{ id: string | null; tcId: string | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const file = useLive('SELECT id, name, workspace_id FROM files WHERE id = ? AND deleted_at IS NULL', [fileId], n);
  const all = useLive('SELECT * FROM bugs WHERE file_id = ? AND deleted_at IS NULL ORDER BY rowid', [fileId], n);
  const tcs = useLive('SELECT id, code FROM testcases WHERE deleted_at IS NULL', [], n);
  const master = useMaster(n);
  const tcLabel = useMemo(() => { const m = new Map((tcs ?? []).map((t) => [String(t.id), s(t.code) || String(t.id)])); return (id: unknown) => (id ? m.get(String(id)) ?? '' : ''); }, [tcs]);
  const rows = useMemo(() => filterBugs(all ?? [], ui, tcLabel), [all, ui, tcLabel]);
  const pg = paginate(rows, ui.page, ui.pageSize);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); setN((x) => x + 1); } catch (e) { setErr((e as Error).message); } };
  const set = (p: Partial<typeof ui>) => setUi((u) => ({ ...u, ...p, page: 'page' in p ? p.page! : 1 }));
  const eff = effectiveSelection(selected, rows); // only ids still visible: bulk actions never touch hidden or deleted rows

  // "Create Bug" from a Failed test case lands here with ?newFromTc=<id>: open the form once, prefilled.
  useEffect(() => { if (fromTc && all && !form) setForm({ id: null, tcId: fromTc }); }, [fromTc, all]); // eslint-disable-line react-hooks/exhaustive-deps

  if (file && file.length === 0) return <p data-testid="file-gone">This file no longer exists. <Link href={hrefFor(ws, 'bugs')}>Back to files</Link></p>;

  // One entry point for every status move: the rule, then the note when the rule asks for one, then the write.
  async function move(ids: string[], to: string, label: string) {
    const bugs = (all ?? []).filter((b) => ids.includes(String(b.id)));
    const rule = statusRule(bugs, to, c.isQA);
    if (!rule.ok) { setErr(QA_BLOCK_MESSAGE); return; }
    let change: StatusChange | null = { note: '', attachment: '' };
    if (rule.needNote) { change = await ask(label); if (!change) return; }
    await run(() => changeStatus(app.ctx!, ids, to, change, c.isQA));
  }

  const ids = pg.items.map((r) => String(r.id));
  const tabs = (
    <p>
      <Link href={hrefFor(ws, 'bugs')}>← Files</Link> <strong>{s(file?.[0]?.name)}</strong>{' '}
      <Link href={hrefFor(ws, `bugs/${encodeURIComponent(fileId)}`)} aria-current={view === 'table' ? 'page' : undefined}>Table</Link>{' '}
      {c.can('bugreport_board') ? <Link href={hrefFor(ws, `bugs/${encodeURIComponent(fileId)}/board`)} aria-current={view === 'board' ? 'page' : undefined}>Board</Link> : null}
    </p>
  );

  return (
    <section>
      {tabs}
      {err ? <p role="alert">{err}</p> : null}
      {dialog}
      <div role="search">
        <input aria-label="Search" value={ui.search} onChange={(e) => set({ search: e.target.value })} />
        <select aria-label="Module filter" value={ui.module} onChange={(e) => set({ module: e.target.value })}><option value="">All modules</option>{uniqueValues(all ?? [], 'module').map((m) => <option key={m}>{m}</option>)}</select>
        <select aria-label="Severity filter" value={ui.severity} onChange={(e) => set({ severity: e.target.value })}><option value="">All severities</option>{SEVERITIES.map((m) => <option key={m}>{m}</option>)}</select>
        <select aria-label="Priority filter" value={ui.priority} onChange={(e) => set({ priority: e.target.value })}><option value="">All priorities</option>{BUG_FORM.PRIORITIES.map((m) => <option key={m}>{m}</option>)}</select>
        <select aria-label="Status filter" value={ui.status} onChange={(e) => set({ status: e.target.value })}><option value="">All statuses</option>{master.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}</select>
        <select aria-label="Tester filter" value={ui.tester} onChange={(e) => set({ tester: e.target.value })}><option value="">All testers</option>{uniqueValues(all ?? [], 'tester').map((m) => <option key={m}>{m}</option>)}</select>
        <button type="button" onClick={() => setUi(defaultBugUi())}>Reset filters</button>
        {view === 'table' ? (
          <select aria-label="Sort" value={`${ui.sortKey}:${ui.sortDir}`} onChange={(e) => { const [k, d] = e.target.value.split(':'); set({ sortKey: k, sortDir: d as 'asc' | 'desc' }); }}>
            {['reportDate', 'id', 'title', 'module', 'severity', 'status'].flatMap((k) => (['asc', 'desc'] as const).map((d) => <option key={`${k}:${d}`} value={`${k}:${d}`}>{k} {d}</option>))}
          </select>
        ) : null}
      </div>
      {c.can('bugreport_create') ? <button type="button" onClick={() => setForm({ id: null, tcId: null })}>New bug</button> : null}

      {view === 'table' && eff.length > 0 ? (
        <div data-testid="bulk-bar">
          {eff.length} selected{' '}
          {c.canEdit ? (
            <select aria-label="Bulk status" value="" onChange={(e) => { const v = e.target.value; if (v) void move(eff, v, `${eff.length} bug → ${statusName(master, v)}`).then(() => setSelected(new Set())); }}>
              <option value="">Set status…</option>{master.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
            </select>
          ) : null}
          {c.can('bugreport_delete') ? <button type="button" onClick={() => void run(async () => { if (confirm(`Delete ${eff.length} bugs?`)) { await deleteBugs(app.ctx!, eff); setSelected(new Set()); } })}>Delete selected</button> : null}
        </div>
      ) : null}

      {view === 'table' ? (
        <>
          <table data-testid="bug-table">
            <thead><tr>
              <th><input type="checkbox" aria-label="Select page" checked={ids.length > 0 && ids.every((i) => selected.has(i))} onChange={(e) => setSelected((cur) => { const nx = new Set(cur); ids.forEach((i) => (e.target.checked ? nx.add(i) : nx.delete(i))); return nx; })} /></th>
              <th>ID</th><th>Test case</th><th>Title</th><th>Module</th><th>Severity</th><th>Status</th><th>Tester</th><th>Reported</th><th>Actions</th>
            </tr></thead>
            <tbody>
              {pg.items.map((b) => {
                const id = String(b.id);
                return (
                  <tr key={id}>
                    <td><input type="checkbox" aria-label={`Select ${bugCodeOf(b)}`} checked={selected.has(id)} onChange={(e) => setSelected((cur) => { const nx = new Set(cur); if (e.target.checked) nx.add(id); else nx.delete(id); return nx; })} /></td>
                    <td><Link href={hrefFor(ws, `bugs/${encodeURIComponent(fileId)}/${encodeURIComponent(id)}`)}>{b.code ? s(b.code) : 'pending'}</Link></td>
                    <td>{tcLabel(b.test_case_id) || '-'}</td><td>{s(b.title)}</td><td>{s(b.module)}</td><td>{s(b.severity)}</td><td>{statusName(master, b.status_code)}</td>
                    <td>{s(b.tester) || '-'}</td><td>{s(b.report_date).slice(0, 10)}</td>
                    <td>
                      {c.canEdit ? <button type="button" onClick={() => setForm({ id, tcId: null })}>Edit</button> : null}
                      <button type="button" onClick={() => window.print()}>Print</button>
                      {c.can('bugreport_delete') ? <button type="button" onClick={() => void run(async () => { if (confirm(`Delete ${bugCodeOf(b)}?`)) await deleteBugs(app.ctx!, [id]); })}>Delete</button> : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {rows.length === 0 ? <p data-testid="bug-empty">{(all ?? []).length ? 'Data tidak ditemukan. Coba kata kunci atau filter lain.' : 'Belum ada Bug Report.'}</p> : null}
          <nav aria-label="Pages">
            <button type="button" disabled={pg.page <= 1} onClick={() => set({ page: pg.page - 1 })}>Previous</button>
            <span data-testid="page-info"> {pg.page} / {pg.pages} (Menampilkan {pg.items.length} dari {rows.length} bug) </span>
            <button type="button" disabled={pg.page >= pg.pages} onClick={() => set({ page: pg.page + 1 })}>Next</button>
          </nav>
        </>
      ) : (
        <Board ws={ws} fileId={fileId} rows={rows} master={master} tcLabel={tcLabel} onMove={(id, to, label) => void move([id], to, label)} />
      )}

      {form ? (
        <BugFormView key={form.id ?? `new-${form.tcId ?? ''}`} fileId={fileId} bugId={form.id} tcId={form.tcId} master={master} existing={all ?? []}
          onCancel={() => setForm(null)} onSaved={() => { setForm(null); setN((x) => x + 1); }} ask={ask} />
      ) : null}
    </section>
  );
}

function Board({ ws, fileId, rows, master, tcLabel, onMove }: { ws: string; fileId: string; rows: Row[]; master: ReturnType<typeof statusMaster>; tcLabel: (id: unknown) => string; onMove: (id: string, to: string, label: string) => void }) {
  const cols = boardColumns(master, rows);
  const [over, setOver] = useState<string | null>(null);
  if (!rows.length) return <p data-testid="bug-empty">Belum ada Bug Report.</p>;
  return (
    <div data-testid="board" style={{ display: 'flex', gap: 12, alignItems: 'flex-start', overflowX: 'auto' }}>
      {cols.map((col) => (
        <div key={col.code} data-status={col.code} data-testid={`col-${col.code}`} style={{ minWidth: 220, borderTop: `3px solid ${col.color ?? '#999'}`, background: over === col.code ? '#eef' : undefined }}
          onDragOver={(e) => { e.preventDefault(); setOver(col.code); }} onDragLeave={() => setOver(null)}
          onDrop={(e) => {
            e.preventDefault(); setOver(null);
            const id = e.dataTransfer.getData('text/plain');
            const b = rows.find((r) => String(r.id) === id);
            if (b && b.status_code !== col.code) onMove(id, col.code, `${bugCodeOf(b)}: ${statusName(master, b.status_code)} → ${col.name}`);
          }}>
          <h3>{col.name} <span data-testid={`count-${col.code}`}>{col.items.length}</span></h3>
          {col.items.map((b) => (
            <div key={String(b.id)} className="dragging-card" draggable data-id={String(b.id)} onDragStart={(e) => e.dataTransfer.setData('text/plain', String(b.id))}
              style={{ border: '1px solid #ccc', margin: '6px 0', padding: 6 }}>
              <Link href={hrefFor(ws, `bugs/${encodeURIComponent(fileId)}/${encodeURIComponent(String(b.id))}`)}>{b.code ? s(b.code) : 'pending'}</Link> {s(b.severity)}
              <div>{s(b.title)}</div>
              <div>{s(b.tester) || '-'} {tcLabel(b.test_case_id)}</div>
              <select aria-label={`Move ${bugCodeOf(b)}`} value="" onChange={(e) => { if (e.target.value) onMove(String(b.id), e.target.value, `${bugCodeOf(b)}: ${statusName(master, b.status_code)} → ${statusName(master, e.target.value)}`); }}>
                <option value="">Move to…</option>{master.filter((m) => m.code !== b.status_code).map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}
              </select>
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

function BugFormView({ fileId, bugId, tcId, master, existing, onSaved, onCancel, ask }: {
  fileId: string; bugId: string | null; tcId: string | null; master: ReturnType<typeof statusMaster>; existing: Row[];
  onSaved: () => void; onCancel: () => void; ask: (label: string) => Promise<StatusChange | null>;
}) {
  const app = useApp();
  const c = useBugCan();
  const me = app.config!.me;
  const editing = bugId ? existing.find((b) => b.id === bugId) ?? null : null;
  const limited = !!editing && !c.can('bugreport_update') && c.can('bugreport_updateStatusPriority');
  const creating = !editing;
  const tcs = useLive('SELECT * FROM testcases WHERE deleted_at IS NULL ORDER BY rowid', []);
  const file = useLive('SELECT workspace_id FROM files WHERE id = ?', [fileId]);
  const [f, setF] = useState<BugForm | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [ai, setAi] = useState<string | null>(null);
  const linkLocked = !!(editing ? editing.test_case_id : tcId);

  // Initial values once the test cases (for a prefill) have loaded.
  useEffect(() => {
    if (f || !tcs) return;
    if (editing) {
      const x = readExtra(editing);
      setF({
        test_case_id: s(editing.test_case_id) || null, module: s(editing.module), scenario: s(x.scenario), preconditions: s(x.preconditions), test_data: s(x.testData),
        steps: stepsHtmlToText(s(editing.steps)), expected_result: s(editing.expected_result), useTcSteps: !!x.useTcSteps, useTcExpected: !!x.useTcExpected,
        tester: s(editing.tester), title: s(editing.title), description: s(editing.description), actual_result: s(editing.actual_result),
        severity: s(editing.severity) || 'Medium', priority: s(editing.priority), status_code: s(editing.status_code), environment: s(editing.environment),
        build_version: s(editing.build_version), platform: inferPlatform(editing), os: s(x.os), browser: s(editing.browser), device: s(editing.device),
        attachments: s(editing.attachments), assignee: s(editing.assignee),
      });
      return;
    }
    const base = emptyBugForm(me.email, master[0]?.code ?? 'OPEN');
    const tc = tcId ? tcs.find((t) => t.id === tcId) : undefined;
    setF(tc ? { ...base, test_case_id: String(tc.id), ...tcPrefill(tc), useTcSteps: !!tcPrefill(tc).steps, useTcExpected: !!tcPrefill(tc).expected_result } : base);
  }, [tcs, f]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!f) return null;
  const set = (p: Partial<BugForm>) => setF({ ...f, ...p });
  const show = BUG_FORM.conditionalFields(f.platform);
  const tc = f.test_case_id ? (tcs ?? []).find((t) => t.id === f.test_case_id) : undefined;
  const lock = (name: string) => limited && !['status_code', 'priority'].includes(name);
  const wsId = s(file?.[0]?.workspace_id);
  // Assignee list = members of the file's workspace (all users when it has none), keeping a no-longer-listed current assignee selectable.
  const people = app.config!.users.filter((u) => !wsId || u.workspaceIds.includes(wsId) || me.role === 'admin' && u.role === 'admin').map((u) => u.email);
  if (f.assignee && !people.includes(f.assignee)) people.push(f.assignee);
  const similar = creating && f.title.trim().length >= 5 ? similarBugs(f.title, existing, bugId, master.filter((m) => m.code === 'CLOSED').map((m) => m.code)) : [];

  function pickTc(id: string) {
    const t = (tcs ?? []).find((x) => x.id === id);
    if (!t) { set({ test_case_id: null }); return; }
    const p = tcPrefill(t);
    // A test case fills what the tester has not typed yet; steps and expected result follow their "from test case" boxes.
    set({
      test_case_id: id, module: f!.module || p.module, scenario: f!.scenario || p.scenario, preconditions: f!.preconditions || p.preconditions, test_data: f!.test_data || p.test_data,
      steps: p.steps || f!.steps, useTcSteps: !!p.steps, expected_result: p.expected_result || f!.expected_result, useTcExpected: !!p.expected_result,
      actual_result: f!.actual_result || p.actual_result, attachments: f!.attachments || p.attachments,
    });
  }

  async function analyze() {
    if (!tc || !s(tc.actual_result).trim()) return;
    setAi('AI sedang menganalisa…');
    try {
      const p = tcPrefill(tc);
      const res = await fetch('/api/bug/analyze', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ testcase: {
        module: p.module, scenario: p.scenario, testCase: s(tc.test_case), preconditions: p.preconditions, steps: p.steps, testData: p.test_data, expectedResult: p.expected_result, actualResult: p.actual_result } }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Analisa gagal');
      setF((cur) => cur && ({ ...cur, title: cur.title.trim() ? cur.title : s(data.title), severity: s(data.severity) || cur.severity, description: cur.description.trim() ? cur.description : s(data.analysis) }));
      setAi('Draft bug dari AI terisi — cek lalu simpan.');
    } catch (e) { setAi(`Analisa AI gagal (${(e as Error).message}). Isi manual.`); }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return; // no double submit
    setErrors({}); setMsg(null); setBusy(true);
    try {
      const statusMoved = !!editing && f!.status_code !== s(editing.status_code);
      let change: StatusChange | null = null;
      if (statusMoved) {
        const rule = statusRule([editing!], f!.status_code, c.isQA);
        if (!rule.ok) { setMsg(QA_BLOCK_MESSAGE); return; }
        change = rule.needNote ? await ask(`${bugCodeOf(editing!)}: ${statusName(master, editing!.status_code)} → ${statusName(master, f!.status_code)}`) : { note: '', attachment: '' };
        if (!change) return; // the form stays open so nothing typed is lost
      }
      await saveBug(app.ctx!, { fileId, bugId: bugId ?? undefined, form: f!, limited, isQA: c.isQA, change, firstStatus: master[0]?.code ?? 'OPEN' });
      onSaved();
    } catch (x) {
      if (x instanceof BugFormError) setErrors(x.errors); else setMsg((x as Error).message);
    } finally { setBusy(false); }
  }

  const field = (name: keyof BugForm, label: string, opts: { area?: boolean; req?: boolean; errKey?: string } = {}) => (
    <label>{label}{opts.req ? ' *' : ''}{opts.area
      ? <textarea aria-label={label} value={String(f[name] ?? '')} disabled={lock(String(name))} onChange={(e) => set({ [name]: e.target.value } as Partial<BugForm>)} />
      : <input aria-label={label} value={String(f[name] ?? '')} disabled={lock(String(name))} onChange={(e) => set({ [name]: e.target.value } as Partial<BugForm>)} />}
      {errors[opts.errKey ?? String(name)] ? <span role="alert" data-error={opts.errKey ?? String(name)}> {errors[opts.errKey ?? String(name)]}</span> : null}</label>
  );
  const select = (name: keyof BugForm, label: string, options: { v: string; l: string }[], placeholder?: string) => (
    <label>{label}<select aria-label={label} value={String(f[name] ?? '')} disabled={lock(String(name))} onChange={(e) => set({ [name]: e.target.value } as Partial<BugForm>)}>
      {placeholder !== undefined ? <option value="">{placeholder}</option> : null}{options.map((o) => <option key={o.v} value={o.v}>{o.l}</option>)}</select>
      {errors[String(name)] ? <span role="alert" data-error={String(name)}> {errors[String(name)]}</span> : null}</label>
  );

  return (
    <form aria-label="Bug form" data-modal-open="bug-form" onSubmit={submit}>
      <h2>{editing ? `Edit Bug — ${bugCodeOf(editing)}` : 'Buat Bug Report'}</h2>
      {msg ? <p role="alert">{msg}</p> : null}
      <label>Test case
        <select aria-label="Test case" value={f.test_case_id ?? ''} disabled={linkLocked || limited} title={linkLocked ? 'Test case sudah terkait dan tidak bisa diganti' : ''} onChange={(e) => pickTc(e.target.value)}>
          <option value="">— Tidak terkait Test Case —</option>
          {(tcs ?? []).map((t) => <option key={String(t.id)} value={String(t.id)}>{s(t.code) || String(t.id)} — {s(t.scenario).slice(0, 60)}</option>)}
        </select>
      </label>
      {tc && s(tc.status) === 'Failed' && s(tc.actual_result).trim() && creating ? <button type="button" onClick={() => void analyze()} disabled={!app.sync.online}>{app.sync.online ? 'Analisa dengan AI' : 'AI needs a connection'}</button> : null}
      {ai ? <p data-testid="ai-status">{ai}</p> : null}
      {field('module', 'Module', { req: true })}{field('scenario', 'Scenario')}{field('preconditions', 'Pre-condition', { area: true })}{field('test_data', 'Test data')}
      {field('steps', 'Steps to Reproduce', { area: true, req: true })}
      {tc && s(tc.steps) ? <label><input type="checkbox" aria-label="Steps from test case" checked={f.useTcSteps} disabled={limited} onChange={(e) => set({ useTcSteps: e.target.checked, ...(e.target.checked ? { steps: tcPrefill(tc).steps } : {}) })} /> Dari test case</label> : null}
      {field('expected_result', 'Expected Result', { area: true, req: true })}
      {tc && s(tc.expected_result) ? <label><input type="checkbox" aria-label="Expected from test case" checked={f.useTcExpected} disabled={limited} onChange={(e) => set({ useTcExpected: e.target.checked, ...(e.target.checked ? { expected_result: tcPrefill(tc).expected_result } : {}) })} /> Dari test case</label> : null}
      {field('title', 'Bug Title', { req: true })}
      {similar.length ? <div data-testid="similar">{similar.map((b) => <p key={String(b.id)}>Bug serupa ditemukan: {bugCodeOf(b)} — {s(b.title)}</p>)}</div> : null}
      {field('actual_result', 'Actual Result', { area: true, req: true, errKey: 'actualResult' })}
      {f.description || editing ? field('description', 'Impact / Catatan Tambahan', { area: true }) : null}
      {select('severity', 'Severity', SEVERITIES.map((v) => ({ v, l: v })))}
      {select('priority', 'Priority', BUG_FORM.PRIORITIES.map((v) => ({ v, l: v })), '— Pilih Priority —')}
      <label>Status<select aria-label="Status" value={f.status_code} disabled={creating || false} title={creating ? 'Bug baru selalu mulai dari status ini' : ''} onChange={(e) => set({ status_code: e.target.value })}>
        {master.map((m) => <option key={m.code} value={m.code}>{m.name}</option>)}</select></label>
      {select('environment', 'Environment', BUG_FORM.ENVIRONMENTS.map((v) => ({ v, l: v })), '— Pilih Environment —')}
      {field('build_version', 'Build version')}
      {select('platform', 'Platform', BUG_FORM.PLATFORMS.map((v) => ({ v, l: v })), '— Pilih Platform —')}
      {field('os', 'OS')}
      {show.browser || (!creating && f.browser) ? field('browser', 'Browser') : null}
      {show.device || (!creating && f.device) ? field('device', 'Device') : null}
      {field('attachments', 'Attachments (URL per baris)', { area: true })}
      {errors.attachments ? <span role="alert" data-error="attachments">{errors.attachments}</span> : null}
      {field('tester', 'Tester')}
      <label>Assign ke<select aria-label="Assign ke" value={f.assignee} disabled={limited} onChange={(e) => set({ assignee: e.target.value })}><option value="">— Belum di-assign —</option>{people.map((p) => <option key={p}>{p}</option>)}</select></label>
      <button type="submit" disabled={busy}>{busy ? 'Menyimpan…' : 'Simpan Bug Report'}</button> <button type="button" onClick={onCancel}>Batal</button>
    </form>
  );
}

function BugDetail({ ws, fileId, bugId }: { ws: string; fileId: string; bugId: string }) {
  const app = useApp();
  const c = useBugCan();
  const [n, setN] = useState(0);
  const [tab, setTab] = useState<'comment' | 'activity' | 'all'>('comment');
  const [text, setText] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const bug = useLive('SELECT * FROM bugs WHERE id = ?', [bugId], n);
  const events = useLive('SELECT * FROM bug_events WHERE bug_id = ? ORDER BY at, id', [bugId], n);
  const tc = useLive('SELECT code FROM testcases WHERE id = (SELECT test_case_id FROM bugs WHERE id = ?)', [bugId], n);
  const master = useMaster(n);
  void bugTimeline;
  if (!bug || !events) return null;
  const b = bug[0];
  if (!b || b.deleted_at) return <p data-testid="bug-gone">This bug no longer exists. <Link href={hrefFor(ws, `bugs/${encodeURIComponent(fileId)}`)}>Back to the list</Link></p>;
  const x = readExtra(b);
  const feed = events
    .filter((e) => e.kind !== 'assignment')
    .filter((e) => tab === 'all' || (tab === 'comment' ? e.kind === 'comment' : e.kind === 'status'));
  const side = (l: string, v: unknown) => <p key={l}><strong>{l}:</strong> <span data-field={l}>{s(v) || '-'}</span></p>;
  const retests = reopenCount(events);
  const canComment = ['bugreport_create', 'bugreport_update', 'bugreport_updateStatusPriority', 'bugreport_statusQA'].some(c.can);

  return (
    <section aria-label="Bug detail">
      <p><Link href={hrefFor(ws, `bugs/${encodeURIComponent(fileId)}`)}>← Bug list</Link></p>
      <h2 data-testid="bug-title">{s(b.code) || 'pending'} — {s(b.title)}</h2>
      <div>
        {x.preconditions ? side('Pre-condition', x.preconditions) : null}{x.testData ? side('Test Data', x.testData) : null}
        <p><strong>Steps to Reproduce:</strong></p><pre style={{ whiteSpace: 'pre-wrap' }} data-testid="bug-steps">{stepsHtmlToText(s(b.steps)) || '-'}</pre>
        {side('Expected Result', b.expected_result)}{side('Actual Result', b.actual_result)}{b.description ? side('Impact / Catatan Tambahan', b.description) : null}
        {s(b.attachments).split('\n').map((l) => l.trim()).filter(Boolean).map((l) => (/^https?:\/\//i.test(l) ? <p key={l}><a href={l} target="_blank" rel="noopener noreferrer">{l}</a></p> : <p key={l}>{l}</p>))}
      </div>
      <aside>
        {side('Status', statusName(master, b.status_code))}{side('Severity', b.severity)}{side('Priority', b.priority)}{side('Module', b.module)}{side('Tester', b.tester)}{side('Assignee', b.assignee)}
        {side('Environment', [b.environment, b.build_version].filter(Boolean).join(' · '))}{side('Platform', [b.platform, x.os, b.browser, b.device].filter(Boolean).join(' · '))}
        {side('Test case', tc?.[0]?.code)}{side('Report Date', s(b.report_date) ? new Date(s(b.report_date)).toLocaleDateString() : '')}
        {side('Jumlah Retest', retests ? `${retests}x (Reopened)` : 'Belum pernah')}
      </aside>
      <nav aria-label="Timeline tabs">
        {(['comment', 'activity', 'all'] as const).map((t) => <button key={t} type="button" aria-pressed={tab === t} onClick={() => setTab(t)}>{t === 'comment' ? 'Comments' : t === 'activity' ? 'Activity' : 'All'}</button>)}
      </nav>
      <ul data-testid="timeline">
        {feed.length === 0 ? <li>{tab === 'comment' ? 'Belum ada komentar.' : tab === 'activity' ? 'Belum ada aktivitas.' : 'Belum ada aktivitas atau pesan.'}</li> : null}
        {(tab === 'comment' ? feed : [...feed].reverse()).map((e) => (
          <li key={String(e.id)} data-kind={s(e.kind)}>
            {e.kind === 'status'
              ? <>Status berubah <b>{statusName(master, e.from_status)}</b> → <b>{statusName(master, e.to_status)}</b>{e.email ? ` oleh ${s(e.email)}` : ''} · {when(e.at)}{e.note ? <> — {s(e.note)}</> : null}</>
              : <><strong>{s(e.email)}</strong> {when(e.at)}: <span style={{ whiteSpace: 'pre-wrap' }}>{s(e.text)}</span></>}
          </li>
        ))}
      </ul>
      {err ? <p role="alert">{err}</p> : null}
      {tab === 'comment' && canComment ? (
        <form aria-label="Add comment" onSubmit={(e) => { e.preventDefault(); const t = text; setText(''); addComment(app.ctx!, bugId, t).then(() => setN((v) => v + 1)).catch((x) => { setErr((x as Error).message); setText(t); }); }}>
          <textarea aria-label="Comment" id="bugChatInput" value={text} onChange={(e) => setText(e.target.value)} />
          <button type="submit">Kirim</button>
        </form>
      ) : null}
    </section>
  );
}
