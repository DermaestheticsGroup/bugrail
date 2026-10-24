import { connect } from '@tursodatabase/database';
import { connectRemote } from './libsql-db';
import { applyMigrations } from '../db/migrate';
import type { Db } from './db-types';
import { seedUsers } from './sync/users';

const g = globalThis as unknown as { __bugrailDb?: Promise<Db> };

export function getServerDb(): Promise<Db> {
  g.__bugrailDb ??= (async () => {
    const db = process.env.TURSO_DATABASE_URL
      ? connectRemote(process.env.TURSO_DATABASE_URL, process.env.TURSO_AUTH_TOKEN)
      : ((await connect(process.env.BUGRAIL_DB_PATH ?? 'data/server.db')) as unknown as Db);
    await applyMigrations(db, 'server');
    await seedUsers(db);
    return db;
  })();
  return g.__bugrailDb;
}
