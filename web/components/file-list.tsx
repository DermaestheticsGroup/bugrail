'use client';
import Link from 'next/link';
import { useState } from 'react';
import { can } from '@/lib/domain/auth';
import { ALL_WS, hrefFor } from '@/lib/client/nav';
import { createFile } from '@/lib/client/repo';
import { countInFile, deleteFileCascade, renameFile, setFileShares } from '@/lib/client/files-testcase';
import { useApp } from './app-provider';
import { useLive } from './use-live';

const s = (v: unknown) => (typeof v === 'string' ? v : '');

function useCan() {
  const app = useApp();
  const role = app.config!.me.role;
  const perms = app.config!.rolePermissions;
  return { role, can: (k: string) => can({ role }, k, perms), isAdmin: role === 'admin' };
}

// Test Case and Bug Report share one file list; `area` picks the screen a file opens in and which rows are counted.
export type FileArea = 'testcases' | 'bugs';

export function FileList({ ws, area }: { ws: string; area: FileArea }) {
  const app = useApp();
  const c = useCan();
  const [n, setN] = useState(0);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const where = ws === ALL_WS ? '1' : `f.workspace_id = ? OR f.id IN (SELECT s.file_id FROM file_shares s WHERE s.workspace_id = ? AND s.deleted_at IS NULL)`;
  const params = ws === ALL_WS ? [] : [ws, ws];
  const files = useLive(
    `SELECT f.id, f.name, f.workspace_id, (SELECT count(*) FROM ${area === 'bugs' ? 'bugs' : 'testcases'} t WHERE t.file_id = f.id AND t.deleted_at IS NULL) AS n
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
              <Link href={hrefFor(ws, `${area}/${encodeURIComponent(String(f.id))}`)}>{String(f.name)}</Link> ({String(f.n)} {area === 'bugs' ? 'bugs' : 'test cases'}){!owned ? ' — shared with you' : ''}{' '}
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

