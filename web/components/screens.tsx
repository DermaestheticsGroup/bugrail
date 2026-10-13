'use client';
import { ALL_WS } from '@/lib/client/nav';
import { useLive } from './use-live';

const scope = (ws: string) => ws === ALL_WS ? { sql: '1', params: [] as string[] } : { sql: 'file_id IN (SELECT id FROM files WHERE workspace_id = ?)', params: [ws] };

export function Dashboard({ ws }: { ws: string }) {
  const s = scope(ws);
  const bugs = useLive(`SELECT status_code AS k, count(*) AS n FROM bugs WHERE deleted_at IS NULL AND (${s.sql}) GROUP BY status_code`, s.params);
  const tcs = useLive(`SELECT status AS k, count(*) AS n FROM testcases WHERE deleted_at IS NULL AND (${s.sql}) GROUP BY status`, s.params);
  const list = (r: typeof bugs) => (r ?? []).map((x) => `${x.k ?? '?'}: ${x.n}`).join(', ') || 'none';
  return <section><p data-testid="bug-counts">Bugs — {list(bugs)}</p><p data-testid="tc-counts">Test cases — {list(tcs)}</p></section>;
}

export function Later({ title }: { title: string }) {
  return <p data-testid="later">{title} arrives with the feature-parity phase.</p>;
}
