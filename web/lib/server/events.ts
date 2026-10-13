// Live refresh pokes. Data never travels here; clients pull after a poke.
type Sub = { admin: boolean; workspaceIds: Set<string>; send: () => void };
const g = globalThis as unknown as { __bugrailSubs?: Set<Sub> };
const subs = () => (g.__bugrailSubs ??= new Set<Sub>());

export function subscribe(admin: boolean, workspaceIds: string[], send: () => void): () => void {
  const s: Sub = { admin, workspaceIds: new Set(workspaceIds), send };
  subs().add(s);
  return () => subs().delete(s);
}

export function broadcast(workspaceIds: Iterable<string>): void {
  const ws = new Set(workspaceIds);
  for (const s of subs()) {
    if (s.admin || [...ws].some((w) => s.workspaceIds.has(w))) s.send();
  }
}
