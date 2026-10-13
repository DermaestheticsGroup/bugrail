// Browser-only: the wasm Turso build on OPFS. Imported dynamically so the server bundle never sees it.
import { applyMigrations } from '../../db/migrate';
import type { Db } from '../db-types';
import { dbName } from './boot';
import { serializeTx } from './serialize';

const opened = new Map<string, Promise<Db>>();

export function openLocalDb(userId: string): Promise<Db> {
  let p = opened.get(userId);
  if (!p) {
    p = (async () => {
      const { connect } = await import('@tursodatabase/database-wasm/turbopack');
      const db = serializeTx((await connect(dbName(userId))) as unknown as Db);
      await applyMigrations(db, 'local');
      return db;
    })();
    p.catch(() => opened.delete(userId)); // let the next call retry a failed open
    opened.set(userId, p);
  }
  return p;
}

export async function hasLocalData(db: Db): Promise<boolean> {
  return !!(await db.get("SELECT 1 AS x FROM meta WHERE key = 'since' LIMIT 1"));
}

export async function outboxSize(db: Db): Promise<number> {
  return Number((await db.get('SELECT count(*) AS n FROM outbox')).n);
}

// Removes the user's OPFS files (database, wal, journal). The caller closes nothing: we only drop our cached handle.
export async function wipeLocalDb(userId: string): Promise<void> {
  opened.delete(userId);
  const root = await navigator.storage.getDirectory();
  const prefix = dbName(userId);
  // for await over the directory handle: removing while iterating is allowed, but collect first to be safe.
  const names: string[] = [];
  for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) if (name.startsWith(prefix)) names.push(name);
  for (const n of names) await root.removeEntry(n).catch(() => undefined);
}

export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}
