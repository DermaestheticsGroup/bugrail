import type { Db } from './db-types';
import { LOCAL_SQL, SCHEMA_SQL, SERVER_SQL } from '../db/sql';

const FILES = { schema: SCHEMA_SQL, server: SERVER_SQL, local: LOCAL_SQL } as const;

export async function applySchema(db: Db, files: (keyof typeof FILES)[]): Promise<void> {
  for (const f of files) await db.exec(FILES[f]);
}
