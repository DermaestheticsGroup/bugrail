import type { Transport } from '../sync/client';

export class HttpError extends Error {
  constructor(public status: number, what: string) { super(`${what} ${status}`); }
}

// Same-origin fetch: the session cookie rides along. Every /api response carries a Date header; `onDate` feeds the clock guard.
export function cookieTransport(base: string, onDate?: (serverMs: number) => void): Transport {
  const seen = (res: Response) => { const d = Date.parse(res.headers.get('date') ?? ''); if (!Number.isNaN(d)) onDate?.(d); };
  return {
    async push(rows) {
      const res = await fetch(`${base}/api/sync/push`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rows }) });
      seen(res);
      if (!res.ok) throw new HttpError(res.status, 'push');
      return res.json();
    },
    async pull(since, av, sv) {
      const res = await fetch(`${base}/api/sync/pull?since=${since}&av=${av}&sv=${sv}`);
      seen(res);
      if (!res.ok) throw new HttpError(res.status, 'pull');
      return res.json();
    },
  };
}
