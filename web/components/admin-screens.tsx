'use client';
// Master status, Settings (custom fields, Gemini key, theme), User Management, Role Permission, Workspaces.
// Master status and custom fields are synced tables (local writes, work offline). Users, roles, workspaces and the key live on the
// server: those screens call /api/admin and are online-only (the shell already says "needs a connection" when offline).
import { useEffect, useState } from 'react';
import { AdminError, addCustomField, deleteStatus, removeCustomField, saveStatus } from '@/lib/client/admin-model';
import { statusMaster } from '@/lib/client/bug-model';
import { DEFAULT_ROLE_PERMISSIONS, PERMISSION_KEYS, can, type RolePermissions } from '@/lib/domain/auth';
import { useApp } from './app-provider';
import { useLive } from './use-live';

const NO_ACCESS = <p data-testid="no-access">Anda tidak punya akses ke halaman ini.</p>;

function useCan(perm: string) {
  const { config } = useApp();
  return !!config && can({ role: config.me.role }, perm, config.rolePermissions);
}

// One call shape for every admin route: JSON in, { ok, error } out.
async function admin(method: string, url: string, body?: unknown): Promise<{ ok: boolean; error?: string; data?: unknown }> {
  const res = await fetch(url, { method, headers: { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out = await res.json().catch(() => ({}));
  return res.ok ? { ok: true, data: out } : { ok: false, error: out.error ?? `HTTP ${res.status}` };
}

function useRun() {
  const [err, setErr] = useState<string | null>(null);
  const [n, setN] = useState(0);
  const run = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setErr(null);
    try { await fn(); setN((x) => x + 1); return true; } catch (e) { setErr((e as Error).message); return false; }
  };
  return { err, n, run, alert: err ? <p role="alert">{err}</p> : null };
}

export function MasterStatus() {
  const app = useApp();
  const allowed = useCan('master');
  const { n, run, alert } = useRun();
  const rows = useLive('SELECT * FROM bug_status_master', [], n);
  const [form, setForm] = useState<{ code: string | null; name: string; color: string; order: number } | null>(null);
  const [fields, setFields] = useState<{ name?: string; color?: string }>({});
  if (!allowed) return NO_ACCESS;
  const list = statusMaster(rows);
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    setFields({});
    await run(async () => {
      try { await saveStatus(app.ctx!, form, form.code ?? undefined); setForm(null); }
      catch (x) { if (x instanceof AdminError && 'fields' in x) setFields((x as AdminError & { fields: typeof fields }).fields); else throw x; }
    });
  };
  return (
    <section>
      {alert}
      <button type="button" onClick={() => { setFields({}); setForm({ code: null, name: '', color: '#2563EB', order: list.length + 1 }); }}>Tambah status</button>
      <table data-testid="status-table">
        <thead><tr><th>#</th><th>Kode</th><th>Status</th><th>Warna</th><th>Urutan</th><th></th></tr></thead>
        <tbody>{list.map((s, i) => (
          <tr key={s.code} data-code={s.code}>
            <td>{i + 1}</td><td>{s.code}</td><td>{s.name}</td><td><span style={{ color: s.color ?? undefined }}>●</span> {s.color}</td><td>{s.order}</td>
            <td>
              <button type="button" onClick={() => { setFields({}); setForm({ code: s.code, name: s.name, color: s.color ?? '#2563EB', order: s.order }); }}>Edit</button>
              <button type="button" onClick={() => void run(async () => { if (confirm(`Hapus status "${s.name}"?`)) await deleteStatus(app.ctx!, s.code); })}>Hapus</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
      {form ? (
        <form aria-label="Status form" onSubmit={(e) => void submit(e)}>
          <label>Nama Status<input aria-label="Nama Status" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          {fields.name ? <p role="alert" data-error="name">{fields.name}</p> : null}
          <label>Warna Label<input aria-label="Warna Label" value={form.color} onChange={(e) => setForm({ ...form, color: e.target.value })} /></label>
          {fields.color ? <p role="alert" data-error="color">{fields.color}</p> : null}
          <label>Urutan<input aria-label="Urutan" type="number" value={form.order} onChange={(e) => setForm({ ...form, order: Number(e.target.value) })} /></label>
          <button type="submit">Simpan</button> <button type="button" onClick={() => setForm(null)}>Batal</button>
        </form>
      ) : null}
    </section>
  );
}

export function Settings() {
  const app = useApp();
  const allowed = useCan('settings');
  const { n, run, alert } = useRun();
  const defs = useLive('SELECT id, label FROM custom_field_defs WHERE deleted_at IS NULL ORDER BY rowid', [], n);
  const counts = useLive('SELECT (SELECT count(*) FROM testcases WHERE deleted_at IS NULL) AS tc, (SELECT count(*) FROM bugs WHERE deleted_at IS NULL) AS bugs', [], n);
  const [label, setLabel] = useState('');
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [theme, setTheme] = useState(() => { try { return localStorage.getItem('qa_theme') || 'light'; } catch { return 'light'; } });
  if (!allowed || !app.config) return NO_ACCESS;
  const isAdmin = app.config.me.role === 'admin';
  const pickTheme = (t: string) => {
    setTheme(t);
    try { localStorage.setItem('qa_theme', t); } catch { /* private mode: applies to this page only */ }
    document.documentElement.dataset.theme = t;
  };
  return (
    <section>
      {alert}
      <p data-testid="data-counts">Test case: {String(counts?.[0]?.tc ?? 0)}, Bug: {String(counts?.[0]?.bugs ?? 0)} (di perangkat ini)</p>
      <h3>Custom field Test Case</h3>
      <ul data-testid="custom-fields">{(defs ?? []).map((d) => (
        <li key={String(d.id)}>{String(d.label)} <button type="button" onClick={() => void run(() => removeCustomField(app.ctx!, String(d.id)))}>Hapus</button></li>
      ))}</ul>
      <form aria-label="Custom field" onSubmit={(e) => { e.preventDefault(); void run(() => addCustomField(app.ctx!, label)).then((ok) => { if (ok) setLabel(''); }); }}>
        <input aria-label="Custom field name" value={label} onChange={(e) => setLabel(e.target.value)} /><button type="submit">Tambah field</button>
      </form>
      <h3>Tema (per browser)</h3>
      <select aria-label="Theme" value={theme} onChange={(e) => pickTheme(e.target.value)}><option value="light">Terang</option><option value="dark">Gelap</option></select>
      {isAdmin ? (
        <form aria-label="Gemini key" onSubmit={(e) => { e.preventDefault(); void admin('PUT', '/api/admin/settings', { geminiApiKey: key.trim() }).then((r) => { setMsg(r.ok ? 'API Key TestForge disimpan.' : String(r.error)); if (r.ok) setKey(''); }); }}>
          <h3>API Key Gemini (TestForge, disimpan di server)</h3>
          <input aria-label="Gemini API key" type="password" autoComplete="off" value={key} onChange={(e) => setKey(e.target.value)} />
          <button type="submit">Simpan key</button> <span data-testid="key-status">{msg}</span>
        </form>
      ) : null}
    </section>
  );
}

interface UserRow { id: string; email: string; name: string; role: string; workspace_ids: string[] }

export function Users() {
  const app = useApp();
  const allowed = useCan('usermanagement');
  const { n, run, alert } = useRun();
  const [users, setUsers] = useState<UserRow[] | null>(null);
  const [form, setForm] = useState<{ id: string | null; email: string; name: string; role: string; workspaceIds: string[]; password: string } | null>(null);
  useEffect(() => {
    let alive = true;
    void admin('GET', '/api/admin/users').then((r) => { if (alive) setUsers(Array.isArray(r.data) ? (r.data as UserRow[]) : null); });
    return () => { alive = false; };
  }, [n]);
  if (!allowed || !app.config) return NO_ACCESS;
  const cfg = app.config;
  const call = (method: string, url: string, body?: unknown) => run(async () => { const r = await admin(method, url, body); if (!r.ok) throw new Error(r.error); await app.refresh(); });
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form) return;
    const body = { email: form.email, name: form.name, role: form.role, workspaceIds: form.workspaceIds, ...(form.password ? { password: form.password } : {}) };
    if (await call(form.id ? 'PATCH' : 'POST', form.id ? `/api/admin/users/${encodeURIComponent(form.id)}` : '/api/admin/users', body)) setForm(null);
  };
  return (
    <section>
      {alert}
      <button type="button" onClick={() => setForm({ id: null, email: '', name: '', role: cfg.roles[0]?.value ?? 'qa_internal', workspaceIds: [], password: '' })}>Tambah user</button>
      <table data-testid="user-table">
        <thead><tr><th>Email</th><th>Nama</th><th>Role</th><th>Workspace</th><th></th></tr></thead>
        <tbody>{(users ?? []).map((u) => (
          <tr key={u.id} data-email={u.email}>
            <td>{u.email}</td><td>{u.name}</td><td>{u.role}</td><td>{u.workspace_ids.map((w) => cfg.workspaces.find((x) => x.id === w)?.name ?? w).join(', ')}</td>
            <td>
              <button type="button" onClick={() => setForm({ id: u.id, email: u.email, name: u.name ?? '', role: u.role, workspaceIds: u.workspace_ids, password: '' })}>Edit</button>
              <button type="button" onClick={() => { if (confirm(`Hapus user ${u.email}?`)) void call('DELETE', `/api/admin/users/${encodeURIComponent(u.id)}`); }}>Hapus</button>
            </td>
          </tr>
        ))}</tbody>
      </table>
      {form ? (
        <form aria-label="User form" onSubmit={(e) => void submit(e)}>
          <label>Email<input aria-label="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
          <label>Nama<input aria-label="Nama" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
          <label>Role<select aria-label="Role" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
            <option value="admin">Admin</option>{cfg.roles.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
          </select></label>
          <fieldset><legend>Workspace</legend>{cfg.workspaces.map((w) => (
            <label key={w.id}><input type="checkbox" checked={form.workspaceIds.includes(w.id)} onChange={(e) => setForm({ ...form, workspaceIds: e.target.checked ? [...form.workspaceIds, w.id] : form.workspaceIds.filter((x) => x !== w.id) })} />{w.name}</label>
          ))}</fieldset>
          <label>Password{form.id ? ' (kosongkan = tidak diubah)' : ''}<input aria-label="Password" type="password" autoComplete="new-password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /></label>
          <button type="submit">Simpan</button> <button type="button" onClick={() => setForm(null)}>Batal</button>
        </form>
      ) : null}
    </section>
  );
}

export function Roles() {
  const app = useApp();
  const { run, alert } = useRun();
  const [draft, setDraft] = useState<RolePermissions | null>(null);
  const [saved, setSaved] = useState(false);
  if (!app.config || app.config.me.role !== 'admin') return NO_ACCESS;
  const cfg = app.config;
  const base: RolePermissions = Object.fromEntries(cfg.roles.map((r) => [r.value, { ...(cfg.rolePermissions[r.value] ?? DEFAULT_ROLE_PERMISSIONS[r.value] ?? {}) }]));
  const perms = draft ?? base;
  const toggle = (role: string, key: string, v: boolean) => { setSaved(false); setDraft({ ...perms, [role]: { ...perms[role], [key]: v } }); };
  return (
    <section>
      {alert}
      <p>Admin selalu punya akses penuh.</p>
      <table data-testid="role-matrix">
        <thead><tr><th>Izin</th>{cfg.roles.map((r) => <th key={r.value}>{r.label}</th>)}</tr></thead>
        <tbody>{PERMISSION_KEYS.map((k) => (
          <tr key={k.key}><td>{k.label}</td>{cfg.roles.map((r) => (
            <td key={r.value}><input type="checkbox" aria-label={`${r.value} ${k.key}`} checked={!!perms[r.value]?.[k.key]} onChange={(e) => toggle(r.value, k.key, e.target.checked)} /></td>
          ))}</tr>
        ))}</tbody>
      </table>
      <button type="button" disabled={!draft} onClick={() => void run(async () => { const r = await admin('PUT', '/api/admin/roles', draft); if (!r.ok) throw new Error(r.error); await app.refresh(); setDraft(null); setSaved(true); })}>Simpan</button>
      {saved ? <span data-testid="roles-saved"> Tersimpan.</span> : null}
    </section>
  );
}

export function Workspaces() {
  const app = useApp();
  const { n, run, alert } = useRun();
  const [name, setName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);
  if (!app.config || app.config.me.role !== 'admin') return NO_ACCESS;
  void n;
  const call = (method: string, url: string, body?: unknown) => run(async () => { const r = await admin(method, url, body); if (!r.ok) throw new Error(r.error); await app.refresh(); });
  return (
    <section>
      {alert}
      <form aria-label="Add workspace" onSubmit={(e) => { e.preventDefault(); void call('POST', '/api/admin/workspaces', { name }).then((ok) => { if (ok) setName(''); }); }}>
        <input aria-label="Workspace name" value={name} onChange={(e) => setName(e.target.value)} /><button type="submit">Tambah workspace</button>
      </form>
      <ul data-testid="workspace-list">{app.config.workspaces.map((w) => (
        <li key={w.id} data-ws={w.name}>
          {editing?.id === w.id ? (
            <form aria-label="Rename workspace" onSubmit={(e) => { e.preventDefault(); void call('PATCH', `/api/admin/workspaces/${encodeURIComponent(w.id)}`, { name: editing.name }).then((ok) => { if (ok) setEditing(null); }); }}>
              <input aria-label="New name" value={editing.name} onChange={(e) => setEditing({ id: w.id, name: e.target.value })} /><button type="submit">Simpan</button>
            </form>
          ) : <>{w.name} <button type="button" onClick={() => setEditing({ id: w.id, name: w.name })}>Edit</button></>}
          <button type="button" onClick={() => { if (confirm(`Hapus workspace "${w.name}"?`)) void call('DELETE', `/api/admin/workspaces/${encodeURIComponent(w.id)}`); }}>Hapus</button>
        </li>
      ))}</ul>
    </section>
  );
}
