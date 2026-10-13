import type { Db } from '../lib/db-types';
import { MIGRATIONS, SCHEMA_VERSION } from './schema/index';

// Runs the scope's scripts in file order and records SCHEMA_VERSION in sync_meta (server) or meta (local).
export async function applyMigrations(db: Db, scope: 'server' | 'local'): Promise<number> {
  for (const [, , sql] of MIGRATIONS[scope]) await db.exec(sql);
  const meta = scope === 'server' ? 'sync_meta' : 'meta';
  await db.run(`INSERT INTO ${meta} (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SCHEMA_VERSION);
  return SCHEMA_VERSION;
}
