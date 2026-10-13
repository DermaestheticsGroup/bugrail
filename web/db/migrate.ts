import type { Db } from '../lib/db-types';
import { MIGRATIONS, SCHEMA_VERSION } from './schema/index';

// Runs the scope's scripts in file order and records SCHEMA_VERSION in sync_meta.schema_version (server) or
// meta.applied_version (local). Local meta.schema_version is what pull sends, so only a server reset writes it.
export async function applyMigrations(db: Db, scope: 'server' | 'local'): Promise<number> {
  const [meta, key] = scope === 'server' ? ['sync_meta', 'schema_version'] : ['meta', 'applied_version'];
  // One transaction: a failed script rolls back with the version write, so a retry never sees half a schema.
  const run = db.transactionAsync(async (tx) => {
    for (const [, , sql] of MIGRATIONS[scope]) await tx.exec(sql);
    await tx.run(`INSERT INTO ${meta} (key, value) VALUES ('${key}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SCHEMA_VERSION);
  });
  await run();
  return SCHEMA_VERSION;
}
