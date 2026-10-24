import { connect } from '@tursodatabase/database';
import { connectRemote } from './libsql-db';
import { applyMigrations } from '../db/migrate';
import type { Db } from './db-types';
import { seedUsers } from './sync/users';

const g = globalThis as unknown as { __bugrailDb?: Promise<Db> };

export function getServerDb(): Promise<Db> {
  if (g.__bugrailDb) return g.__bugrailDb;
  const p = (async () => {
    const db = process.env.TURSO_DATABASE_URL
      ? connectRemote(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN)
      : ((await connect(process.env.BUGRAIL_DB_PATH ?? 'data/server.db')) as unknown as Db);
    await applyMigrations(db, 'server');
    await seedUsers(db);
    return db;
  })();
  // A failed init (e.g. Turso briefly unreachable) must not stick for the life of a warm instance.
  p.catch(() => { if (g.__bugrailDb === p) g.__bugrailDb = undefined; });
  return (g.__bugrailDb = p);
}
