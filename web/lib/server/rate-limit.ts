// shortcut: in-memory per process, fine for the single Node process the spec runs; use a table if that changes.
const hits = new Map<string, number[]>();

const MAX_KEYS = 10_000;

export function rateLimited(key: string, max = 10, windowMs = 15 * 60_000, now = Date.now()): boolean {
  if (hits.size > MAX_KEYS) for (const [k, ts] of hits) if (now - ts[ts.length - 1] >= windowMs) hits.delete(k);
  const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);
  if (recent.length >= max) { hits.set(key, recent); return true; }
  recent.push(now);
  hits.set(key, recent);
  return false;
}

export const rateLimitSize = () => hits.size;

export function resetRateLimit() { hits.clear(); }
