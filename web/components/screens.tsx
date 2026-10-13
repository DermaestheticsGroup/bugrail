'use client';
import { useState } from 'react';
import { can } from '@/lib/domain/auth';
import { ALL_WS } from '@/lib/client/nav';
import { createBug, createFile, createTestcase } from '@/lib/client/repo';
import { useApp } from './app-provider';
import { useLive } from './use-live';

// The file a quick-add row goes into: the workspace's first live file, created on demand.
// Two quick adds must not each create a Default file, so concurrent callers share one in-flight lookup.
const inflight = new Map<string, Promise<string>>();
function ensureFile(app: ReturnType<typeof useApp>, ws: string): Promise<string> {
  let p = inflight.get(ws);
  if (!p) {
    p = (async () => {
      const f = await app.db!.get('SELECT id FROM files WHERE workspace_id = ? AND deleted_at IS NULL ORDER BY rowid LIMIT 1', ws);
      return f ? String(f.id) : String((await createFile(app.ctx!, ws, 'Default')).id);
    })().finally(() => inflight.delete(ws));
    inflight.set(ws, p);
  }
  return p;
}

const scope = (ws: string) => ws === ALL_WS ? { sql: '1', params: [] as string[] } : { sql: 'file_id IN (SELECT id FROM files WHERE workspace_id = ?)', params: [ws] };

export function Dashboard({ ws }: { ws: string }) {
  const s = scope(ws);
  const bugs = useLive(`SELECT status_code AS k, count(*) AS n FROM bugs WHERE deleted_at IS NULL AND (${s.sql}) GROUP BY status_code`, s.params);
  const tcs = useLive(`SELECT status AS k, count(*) AS n FROM testcases WHERE deleted_at IS NULL AND (${s.sql}) GROUP BY status`, s.params);
  const list = (r: typeof bugs) => (r ?? []).map((x) => `${x.k ?? '?'}: ${x.n}`).join(', ') || 'none';
  return <section><p data-testid="bug-counts">Bugs — {list(bugs)}</p><p data-testid="tc-counts">Test cases — {list(tcs)}</p></section>;
}

export function Bugs({ ws }: { ws: string }) {
  const app = useApp();
  const [n, setN] = useState(0);
  const [title, setTitle] = useState('');
  const [module, setModule] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const s = scope(ws);
  const rows = useLive(`SELECT id, code, title, status_code FROM bugs WHERE deleted_at IS NULL AND (${s.sql}) ORDER BY rowid DESC`, s.params, n);
  const role = app.config!.me.role;
  const canCreate = ws !== ALL_WS && can({ role }, 'bugreport_create', app.config!.rolePermissions);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const fields = { title, module };
    setTitle(''); // clear before the await: whatever is typed while the write runs belongs to the next bug
    try {
      await createBug(app.ctx!, await ensureFile(app, ws), fields);
      setN((x) => x + 1);
    } catch (x) { setErr((x as Error).message); setTitle(fields.title); }
  }
  return (
    <section>
      {canCreate ? (
        <form onSubmit={add} aria-label="Add bug">
          <input aria-label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
          <input aria-label="Module" value={module} onChange={(e) => setModule(e.target.value)} />
          <button type="submit">Add bug</button>
        </form>
      ) : null}
      {err ? <p role="alert">{err}</p> : null}
      <ul data-testid="bug-list">
        {(rows ?? []).map((b) => <li key={String(b.id)} data-code={String(b.code ?? '')}>{String(b.code ?? 'pending')} — {String(b.title)} [{String(b.status_code)}]</li>)}
      </ul>
    </section>
  );
}

export function Testcases({ ws }: { ws: string }) {
  const app = useApp();
  const [n, setN] = useState(0);
  const [scenario, setScenario] = useState('');
  const [module, setModule] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const s = scope(ws);
  const rows = useLive(`SELECT id, code, module, scenario, status FROM testcases WHERE deleted_at IS NULL AND (${s.sql}) ORDER BY rowid DESC`, s.params, n);
  const canCreate = ws !== ALL_WS && can({ role: app.config!.me.role }, 'testcase_create', app.config!.rolePermissions);
  async function add(e: React.FormEvent) {
    e.preventDefault();
    setErr(null);
    const fields = { scenario, module };
    setScenario('');
    try {
      await createTestcase(app.ctx!, await ensureFile(app, ws), fields);
      setN((x) => x + 1);
    } catch (x) { setErr((x as Error).message); setScenario(fields.scenario); }
  }
  return (
    <section>
      {canCreate ? (
        <form onSubmit={add} aria-label="Add test case">
          <input aria-label="Scenario" value={scenario} onChange={(e) => setScenario(e.target.value)} required />
          <input aria-label="Test module" value={module} onChange={(e) => setModule(e.target.value)} />
          <button type="submit">Add test case</button>
        </form>
      ) : null}
      {err ? <p role="alert">{err}</p> : null}
      <ul data-testid="tc-list">
        {(rows ?? []).map((t) => <li key={String(t.id)}>{String(t.code ?? 'pending')} — {String(t.scenario)} [{String(t.status)}]</li>)}
      </ul>
    </section>
  );
}

export function Later({ title }: { title: string }) {
  return <p data-testid="later">{title} arrives with the feature-parity phase.</p>;
}
