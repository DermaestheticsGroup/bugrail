import type { Db } from '../lib/db-types';
import { MIGRATIONS, SCHEMA_VERSION } from './schema/index';

// Runs the scope's scripts in file order and records SCHEMA_VERSION in sync_meta.schema_version (server) or
// meta.applied_version (local). Local meta.schema_version is what pull sends, so only a server reset writes it.
// The unique email index would fail the whole migration on a database that already holds duplicates; say which ones.
// Merging accounts is a human decision, so this refuses instead of picking a winner.
async function refuseDuplicateEmails(tx: Pick<Db, 'get' | 'all'>): Promise<void> {
  if (!(await tx.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'"))) return;
  const dups = await tx.all('SELECT lower(email) AS e, count(*) AS n FROM users GROUP BY lower(email) HAVING count(*) > 1');
  if (dups.length) throw new Error(`migration refused: duplicate user emails (case-insensitive): ${dups.map((d) => d.e).join(', ')}. Merge or rename them, then restart.`);
}

export async function applyMigrations(db: Db, scope: 'server' | 'local'): Promise<number> {
  const [meta, key] = scope === 'server' ? ['sync_meta', 'schema_version'] : ['meta', 'applied_version'];
  // One transaction: a failed script rolls back with the version write, so a retry never sees half a schema.
  const run = db.transactionAsync(async (tx) => {
    if (scope === 'server') await refuseDuplicateEmails(tx);
    for (const [, , sql] of MIGRATIONS[scope]) await tx.exec(sql);
    await tx.run(`INSERT INTO ${meta} (key, value) VALUES ('${key}', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`, SCHEMA_VERSION);
  });
  await run();
  return SCHEMA_VERSION;
}
