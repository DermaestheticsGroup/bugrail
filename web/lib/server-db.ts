import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import type { Db } from './db-types';

const g = globalThis as unknown as { __bugrailDb?: Promise<Db> };

export function getServerDb(): Promise<Db> {
  g.__bugrailDb ??= (async () => {
    const db = (await connect(process.env.BUGRAIL_DB_PATH ?? 'data/server.db')) as unknown as Db;
    await applyMigrations(db, 'server');
    return db;
  })();
  return g.__bugrailDb;
}
