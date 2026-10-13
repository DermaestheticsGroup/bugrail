// Browser-only: the wasm Turso build on OPFS. Imported dynamically so the server bundle never sees it.
import { applyMigrations } from '../../db/migrate';
import type { Db } from '../db-types';
import { dbName } from './boot';
import { serializeTx } from './serialize';

const opened = new Map<string, Promise<Db>>();
const closers = new Map<string, () => Promise<void>>();

export function openLocalDb(userId: string): Promise<Db> {
  let p = opened.get(userId);
  if (!p) {
    p = (async () => {
      const { connect } = await import('@tursodatabase/database-wasm/turbopack');
      const raw = (await connect(dbName(userId))) as unknown as Db & { close?: () => Promise<void> | void };
      const db = serializeTx(raw);
      closers.set(userId, async () => { await raw.close?.(); });
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

// Releases the OPFS handles so the files can be removed.
export async function closeLocalDb(userId: string): Promise<void> {
  const p = opened.get(userId);
  const close = closers.get(userId);
  opened.delete(userId);
  closers.delete(userId);
  if (p) await p.catch(() => undefined);
  await close?.();
}

// Removes the user's OPFS files (database, wal, journal); throws naming every file that could not be removed.
export async function wipeLocalDb(userId: string): Promise<void> {
  opened.delete(userId);
  const root = await navigator.storage.getDirectory();
  const prefix = dbName(userId);
  // for await over the directory handle: removing while iterating is allowed, but collect first to be safe.
  const names: string[] = [];
  for await (const [name] of (root as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) if (name.startsWith(prefix)) names.push(name);
  const failed: string[] = [];
  for (const n of names) await root.removeEntry(n).catch(() => { failed.push(n); });
  if (failed.length) throw new Error(`could not remove local data: ${failed.join(', ')}`);
}

export async function requestPersistence(): Promise<boolean> {
  return (await navigator.storage?.persist?.()) ?? false;
}
