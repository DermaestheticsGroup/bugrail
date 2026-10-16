// Browser-side database: a Turso file in OPFS that the UI reads and writes directly
// (no network on the interaction path). Sync to Turso Cloud goes through /api/rewind/sync.
import { connect } from "@tursodatabase/sync-wasm/turbopack";
import { SCHEMA } from "./schema";

export type Snapshot = { jams: any[]; comments: any[]; kv: Record<string, unknown> };
export type LocalDb = Awaited<ReturnType<typeof connect>>;

export async function openLocalDb(syncEnabled: boolean): Promise<LocalDb> {
  const db = await connect({
    path: "rewind.db",
    // returning null pauses sync, so the app boots and writes while offline
    url: syncEnabled ? () => (navigator.onLine ? location.origin + "/api/rewind/sync" : null) : undefined,
    clientName: "rewind-web",
  });
  for (const sql of SCHEMA) await db.exec(sql);
  return db;
}

export async function loadSnapshot(db: LocalDb): Promise<Snapshot> {
  const rows = async (table: string) =>
    ((await (await db.prepare(`SELECT data FROM ${table} ORDER BY position`)).all()) as { data: string }[]).map((r) =>
      JSON.parse(r.data),
    );
  const kv: Record<string, unknown> = {};
  for (const r of (await (await db.prepare("SELECT key, value FROM kv")).all()) as { key: string; value: string }[])
    kv[r.key] = JSON.parse(r.value);
  return { jams: await rows("jams"), comments: await rows("comments"), kv };
}

export async function seedIfEmpty(db: LocalDb, seed: Snapshot) {
  const [{ n }] = (await (await db.prepare("SELECT count(*) AS n FROM jams")).all()) as { n: number }[];
  const [{ k }] = (await (await db.prepare("SELECT count(*) AS k FROM kv WHERE key = 'seeded'")).all()) as { k: number }[];
  if (n > 0 || k > 0) return;
  await saveDiff(db, { jams: [], comments: [], kv: {} }, { ...seed, kv: { ...seed.kv, seeded: true } });
}

// Writes only rows whose content or position changed since `prev`.
export async function saveDiff(db: LocalDb, prev: Snapshot, next: Snapshot) {
  const now = Date.now();
  const stmts: [string, unknown[]][] = [];
  for (const table of ["jams", "comments"] as const) {
    const before = new Map(prev[table].map((r, i) => [r.id, JSON.stringify(r) + "#" + i]));
    next[table].forEach((r, i) => {
      if (before.get(r.id) !== JSON.stringify(r) + "#" + i)
        stmts.push([`INSERT OR REPLACE INTO ${table} (id, data, position, updated_at) VALUES (?, ?, ?, ?)`, [r.id, JSON.stringify(r), i, now]]);
      before.delete(r.id);
    });
    for (const id of before.keys()) stmts.push([`DELETE FROM ${table} WHERE id = ?`, [id]]);
  }
  for (const [key, value] of Object.entries(next.kv)) {
    if (JSON.stringify(prev.kv[key]) !== JSON.stringify(value))
      stmts.push(["INSERT OR REPLACE INTO kv (key, value, updated_at) VALUES (?, ?, ?)", [key, JSON.stringify(value ?? null), now]]);
  }
  if (!stmts.length) return false;
  await db.exec("BEGIN");
  try {
    for (const [sql, args] of stmts) await (await db.prepare(sql)).run(...args);
    await db.exec("COMMIT");
  } catch (e) {
    await db.exec("ROLLBACK");
    throw e;
  }
  return true;
}
