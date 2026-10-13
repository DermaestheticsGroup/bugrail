'use client';
import Link from 'next/link';
import { useMemo, useState } from 'react';
import { can } from '@/lib/domain/auth';
import { ALL_WS, hrefFor } from '@/lib/client/nav';
import { createFile } from '@/lib/client/repo';
import {
  bulkTestcaseDelete, bulkTestcaseStatus, countInFile, deleteFileCascade, duplicateTestcase, executeTestcase,
  renameFile, saveTestcase, setFileShares, type TcForm,
} from '@/lib/client/files-testcase';
import { TC_STATUSES, TC_TYPES, defaultTcUi, effectiveSelection, filterTestcases, paginate, tcCodeOf, uniqueValues } from '@/lib/client/testcase-model';
import type { Row } from '@/lib/db-types';
import { useApp } from './app-provider';
import { useLive } from './use-live';

const s = (v: unknown) => (typeof v === 'string' ? v : '');

export default function TestcaseScreen({ ws, fileId }: { ws: string; fileId: string | null }) {
  return fileId ? <FileView ws={ws} fileId={fileId} /> : <FileList ws={ws} />;
}

function useCan() {
  const app = useApp();
  const role = app.config!.me.role;
  const perms = app.config!.rolePermissions;
  return { role, can: (k: string) => can({ role }, k, perms), isAdmin: role === 'admin' };
}

function FileList({ ws }: { ws: string }) {
  const app = useApp();
  const c = useCan();
  const [n, setN] = useState(0);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const where = ws === ALL_WS ? '1' : `f.workspace_id = ? OR f.id IN (SELECT s.file_id FROM file_shares s WHERE s.workspace_id = ? AND s.deleted_at IS NULL)`;
  const params = ws === ALL_WS ? [] : [ws, ws];
  const files = useLive(
    `SELECT f.id, f.name, f.workspace_id, (SELECT count(*) FROM testcases t WHERE t.file_id = f.id AND t.deleted_at IS NULL) AS n
     FROM files f WHERE f.deleted_at IS NULL AND (${where}) ORDER BY f.rowid`, params, n,
  );
  const canCreate = ws !== ALL_WS && (c.can('testcase_create') || c.can('bugreport_fileCreate'));
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); setN((x) => x + 1); } catch (e) { setErr((e as Error).message); } };

  return (
    <section>
      {canCreate ? (
        <form aria-label="Add file" onSubmit={(e) => { e.preventDefault(); const v = name; setName(''); void run(() => createFile(app.ctx!, ws, v.trim())); }}>
          <input aria-label="File name" value={name} onChange={(e) => setName(e.target.value)} required />
          <button type="submit">Add file</button>
        </form>
      ) : null}
      {err ? <p role="alert">{err}</p> : null}
      <ul data-testid="file-list">
        {(files ?? []).map((f) => {
          const owned = f.workspace_id === ws || ws === ALL_WS;
          return (
            <li key={String(f.id)} data-file={String(f.name)}>
              <Link href={hrefFor(ws, `testcases/${encodeURIComponent(String(f.id))}`)}>{String(f.name)}</Link> ({String(f.n)} test cases){!owned ? ' — shared with you' : ''}{' '}
              {owned ? <button type="button" onClick={() => setEditing(String(f.id))}>Edit</button> : null}
              {c.isAdmin ? <button type="button" onClick={() => void run(async () => {
                const k = await countInFile(app.ctx!, String(f.id));
                if (confirm(`Delete "${f.name}" with ${k.testcases} test cases and ${k.bugs} bugs?`)) await deleteFileCascade(app.ctx!, String(f.id));
              })}>Delete</button> : null}
            </li>
          );
        })}
      </ul>
      {files && files.length === 0 ? <p data-testid="no-files">No files yet.</p> : null}
      {editing ? <FileEditor fileId={editing} onDone={() => { setEditing(null); setN((x) => x + 1); }} /> : null}
    </section>
  );
}

function FileEditor({ fileId, onDone }: { fileId: string; onDone: () => void }) {
  const app = useApp();
  const c = useCan();
  const file = useLive('SELECT name, workspace_id FROM files WHERE id = ?', [fileId]);
  const current = useLive('SELECT workspace_id FROM file_shares WHERE file_id = ? AND deleted_at IS NULL', [fileId]);
  const [name, setName] = useState<string | null>(null);
  const [picked, setPicked] = useState<string[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  if (!file?.[0] || !current) return null;
  const row = file[0];
  const shared = picked ?? current.map((r) => String(r.workspace_id));
  const canShare = c.can('testcase_fileShare') && (c.isAdmin || app.config!.me.workspaceIds.includes(String(row.workspace_id)));
  const others = app.config!.workspaces.filter((w) => w.id !== row.workspace_id);
  async function save(e: React.FormEvent) {
    e.preventDefault();
    try {
      await renameFile(app.ctx!, fileId, name ?? s(row.name));
      if (canShare && picked) await setFileShares(app.ctx!, fileId, picked);
      onDone();
    } catch (x) { setErr((x as Error).message); }
  }
  return (
    <form onSubmit={save} aria-label="Edit file">
      <input aria-label="Name" value={name ?? s(row.name)} onChange={(e) => setName(e.target.value)} required />
      {canShare ? (
        <fieldset><legend>Share with</legend>
          {others.map((w) => (
            <label key={w.id}><input type="checkbox" checked={shared.includes(w.id)} onChange={(e) => setPicked(e.target.checked ? [...shared, w.id] : shared.filter((x) => x !== w.id))} /> {w.name}</label>
          ))}
        </fieldset>
      ) : null}
      {err ? <p role="alert">{err}</p> : null}
      <button type="submit">Save</button> <button type="button" onClick={onDone}>Cancel</button>
    </form>
  );
}

function FileView({ ws, fileId }: { ws: string; fileId: string }) {
  const app = useApp();
  const c = useCan();
  const [n, setN] = useState(0);
  const [ui, setUi] = useState(defaultTcUi);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<{ kind: 'none' } | { kind: 'form'; id: string | null } | { kind: 'run'; id: string } | { kind: 'detail'; id: string }>({ kind: 'none' });
  const [err, setErr] = useState<string | null>(null);
  const file = useLive('SELECT id, name FROM files WHERE id = ? AND deleted_at IS NULL', [fileId], n);
  const all = useLive('SELECT * FROM testcases WHERE file_id = ? AND deleted_at IS NULL ORDER BY rowid', [fileId], n);
  const defs = useLive("SELECT label FROM custom_field_defs WHERE deleted_at IS NULL ORDER BY server_seq, rowid", [], n);
  const rows = useMemo(() => filterTestcases(all ?? [], ui), [all, ui]);
  const pg = paginate(rows, ui.page, ui.pageSize);
  const sel = effectiveSelection(selected, rows);
  const run = async (fn: () => Promise<unknown>) => { setErr(null); try { await fn(); setN((x) => x + 1); } catch (e) { setErr((e as Error).message); } };
  const set = (p: Partial<typeof ui>) => setUi((u) => ({ ...u, ...p, page: 'page' in p ? p.page! : 1 }));
  if (file && file.length === 0) return <p data-testid="file-gone">This file no longer exists. <Link href={hrefFor(ws, 'testcases')}>Back to files</Link></p>;
  const ids = pg.items.map((r) => String(r.id));
  const editing = mode.kind === 'form' && mode.id ? (all ?? []).find((r) => r.id === mode.id) ?? null : null;

  return (
    <section>
      <p><Link href={hrefFor(ws, 'testcases')}>← Files</Link> <strong>{s(file?.[0]?.name)}</strong></p>
      {err ? <p role="alert">{err}</p> : null}
      <div role="search">
        <input aria-label="Search" value={ui.search} onChange={(e) => set({ search: e.target.value })} />
        <select aria-label="Module filter" value={ui.module} onChange={(e) => set({ module: e.target.value })}><option value="">All modules</option>{uniqueValues(all ?? [], 'module').map((m) => <option key={m}>{m}</option>)}</select>
        <select aria-label="Type filter" value={ui.typeTest} onChange={(e) => set({ typeTest: e.target.value })}><option value="">All types</option>{TC_TYPES.map((m) => <option key={m}>{m}</option>)}</select>
        <select aria-label="Status filter" value={ui.status} onChange={(e) => set({ status: e.target.value })}><option value="">All statuses</option>{TC_STATUSES.map((m) => <option key={m}>{m}</option>)}</select>
        <button type="button" onClick={() => setUi(defaultTcUi())}>Reset filters</button>
        <select aria-label="Sort" value={`${ui.sortKey}:${ui.sortDir}`} onChange={(e) => { const [k, d] = e.target.value.split(':'); set({ sortKey: k, sortDir: d as 'asc' | 'desc' }); }}>
          {['id', 'module', 'scenario', 'status'].flatMap((k) => (['asc', 'desc'] as const).map((d) => <option key={`${k}:${d}`} value={`${k}:${d}`}>{k} {d}</option>))}
        </select>
      </div>
      {c.can('testcase_create') ? <button type="button" onClick={() => setMode({ kind: 'form', id: null })}>New test case</button> : null}
      {sel.length > 0 ? (
        <div data-testid="bulk-bar">
          {sel.length} selected{' '}
          {c.can('testcase_update') ? <select aria-label="Bulk status" value="" onChange={(e) => { const v = e.target.value; if (v) void run(async () => { await bulkTestcaseStatus(app.ctx!, sel, v); setSelected(new Set()); }); }}><option value="">Set status…</option>{TC_STATUSES.map((m) => <option key={m}>{m}</option>)}</select> : null}
          {c.can('testcase_delete') ? <button type="button" onClick={() => void run(async () => { if (confirm(`Delete ${sel.length} test cases?`)) { await bulkTestcaseDelete(app.ctx!, sel); setSelected(new Set()); } })}>Delete selected</button> : null}
        </div>
      ) : null}
      <table data-testid="tc-table">
        <thead><tr>
          <th><input type="checkbox" aria-label="Select page" checked={ids.length > 0 && ids.every((i) => selected.has(i))} onChange={(e) => setSelected((cur) => { const nx = new Set(cur); ids.forEach((i) => (e.target.checked ? nx.add(i) : nx.delete(i))); return nx; })} /></th>
          <th>ID</th><th>Module</th><th>Scenario</th><th>Type</th><th>Status</th><th>Actions</th>
        </tr></thead>
        <tbody>
          {pg.items.map((r) => {
            const id = String(r.id);
            return (
              <tr key={id}>
                <td><input type="checkbox" aria-label={`Select ${tcCodeOf(r)}`} checked={selected.has(id)} onChange={(e) => setSelected((cur) => { const nx = new Set(cur); if (e.target.checked) nx.add(id); else nx.delete(id); return nx; })} /></td>
                <td>{r.code ? s(r.code) : 'pending'}</td><td>{s(r.module)}</td><td>{s(r.scenario)}</td><td>{s(r.type_test)}</td><td>{s(r.status)}</td>
                <td>
                  <button type="button" onClick={() => setMode({ kind: 'detail', id })}>View</button>
                  {c.can('testcase_update') ? <button type="button" onClick={() => setMode({ kind: 'run', id })}>Run</button> : null}
                  {c.can('testcase_update') ? <button type="button" onClick={() => setMode({ kind: 'form', id })}>Edit</button> : null}
                  {c.can('testcase_create') ? <button type="button" onClick={() => void run(() => duplicateTestcase(app.ctx!, id))}>Duplicate</button> : null}
                  {c.can('testcase_delete') ? <button type="button" onClick={() => void run(async () => { if (confirm(`Delete ${tcCodeOf(r)}?`)) await bulkTestcaseDelete(app.ctx!, [id]); })}>Delete</button> : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length === 0 ? <p data-testid="tc-empty">{(all ?? []).length ? 'No test cases match the filters.' : 'No test cases in this file yet.'}</p> : null}
      <nav aria-label="Pages">
        <button type="button" disabled={pg.page <= 1} onClick={() => set({ page: pg.page - 1 })}>Previous</button>
        <span data-testid="page-info"> {pg.page} / {pg.pages} ({rows.length} rows) </span>
        <button type="button" disabled={pg.page >= pg.pages} onClick={() => set({ page: pg.page + 1 })}>Next</button>
      </nav>

      {mode.kind === 'form' ? <TcFormView key={mode.id ?? 'new'} row={editing} modules={uniqueValues(all ?? [], 'module')} customFields={(defs ?? []).map((d) => s(d.label))} onCancel={() => setMode({ kind: 'none' })}
        onSave={(f) => run(async () => { await saveTestcase(app.ctx!, fileId, f, mode.id ?? undefined); setMode({ kind: 'none' }); })} /> : null}
      {mode.kind === 'run' ? <RunView row={(all ?? []).find((r) => r.id === mode.id)} onCancel={() => setMode({ kind: 'none' })}
        onSave={(r) => run(async () => { await executeTestcase(app.ctx!, mode.id, r); setMode({ kind: 'none' }); })} /> : null}
      {mode.kind === 'detail' ? <DetailView row={(all ?? []).find((r) => r.id === mode.id)} onClose={() => setMode({ kind: 'none' })} /> : null}
    </section>
  );
}

function TcFormView({ row, modules, customFields, onSave, onCancel }: { row: Row | null; modules: string[]; customFields: string[]; onSave: (f: TcForm) => void; onCancel: () => void }) {
  const [f, setF] = useState<TcForm>(() => ({
    module: s(row?.module), role_user: s(row?.role_user), scenario: s(row?.scenario), test_case: s(row?.test_case), preconditions: s(row?.preconditions),
    steps: s(row?.steps), test_data: s(row?.test_data), expected_result: s(row?.expected_result), type_test: s(row?.type_test) || 'Positive',
    custom_fields: (() => { try { return JSON.parse(s(row?.custom_fields) || '{}'); } catch { return {}; } })(),
  }));
  const text = (k: keyof TcForm, label: string, area = false) => (
    <label>{label}{area
      ? <textarea value={(f[k] as string) ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />
      : <input value={(f[k] as string) ?? ''} onChange={(e) => setF({ ...f, [k]: e.target.value })} />}</label>
  );
  return (
    <form aria-label="Test case form" onSubmit={(e) => { e.preventDefault(); onSave(f); }}>
      <label>Module <input list="tc-modules" value={f.module} onChange={(e) => setF({ ...f, module: e.target.value })} required /></label>
      <datalist id="tc-modules">{modules.map((m) => <option key={m} value={m} />)}</datalist>
      {text('role_user', 'Role / user')}{text('scenario', 'Scenario')}{text('test_case', 'Test case', true)}{text('preconditions', 'Preconditions', true)}
      {text('steps', 'Steps', true)}{text('test_data', 'Test data')}{text('expected_result', 'Expected result', true)}
      <label>Type <select value={f.type_test} onChange={(e) => setF({ ...f, type_test: e.target.value })}>{TC_TYPES.map((t) => <option key={t}>{t}</option>)}</select></label>
      {customFields.map((l) => <label key={l}>{l} <input value={f.custom_fields?.[l] ?? ''} onChange={(e) => setF({ ...f, custom_fields: { ...f.custom_fields, [l]: e.target.value } })} /></label>)}
      <button type="submit">Save</button> <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function RunView({ row, onSave, onCancel }: { row?: Row; onSave: (r: { status: string; actual_result: string; evidence: string }) => void; onCancel: () => void }) {
  const [r, setR] = useState({ status: s(row?.status) || 'Open', actual_result: s(row?.actual_result), evidence: s(row?.evidence) });
  if (!row) return null;
  return (
    <form aria-label="Execute" onSubmit={(e) => { e.preventDefault(); onSave(r); }}>
      <p>Execute — {tcCodeOf(row)}: {s(row.scenario)}</p><p>Expected: {s(row.expected_result) || '-'}</p>
      <label>Actual result <textarea value={r.actual_result} onChange={(e) => setR({ ...r, actual_result: e.target.value })} /></label>
      <label>Evidence <input value={r.evidence} onChange={(e) => setR({ ...r, evidence: e.target.value })} /></label>
      <label>Status <select value={r.status} onChange={(e) => setR({ ...r, status: e.target.value })}>{TC_STATUSES.map((t) => <option key={t}>{t}</option>)}</select></label>
      <button type="submit">Save result</button> <button type="button" onClick={onCancel}>Cancel</button>
    </form>
  );
}

function DetailView({ row, onClose }: { row?: Row; onClose: () => void }) {
  if (!row) return null;
  const f = (l: string, v: unknown) => <p key={l}><strong>{l}:</strong> {s(v) || '-'}</p>;
  return (
    <aside aria-label="Test case detail">
      {f('ID', row.code ?? 'pending')}{f('Module', row.module)}{f('Scenario', row.scenario)}{f('Role / user', row.role_user)}{f('Test case', row.test_case)}
      {f('Preconditions', row.preconditions)}{f('Test data', row.test_data)}{f('Expected', row.expected_result)}{f('Type', row.type_test)}
      {f('Status', row.status)}{f('Actual result', row.actual_result)}{f('Evidence', row.evidence)}{f('Executed', row.execution_date)}
      <button type="button" onClick={onClose}>Close</button>
    </aside>
  );
}
