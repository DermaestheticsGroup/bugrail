// Legacy kv_store -> server.db. The app must be stopped; the target must be empty. Read-only on the source.
// bun scripts/migrate-kv-to-turso.ts --from-json dump.json --db /var/lib/bugrail/server.db [--dry-run]
// bun scripts/migrate-kv-to-turso.ts --mongo --db /var/lib/bugrail/server.db      (MONGO_URI, DB_NAME; needs `bun add mongodb`)
// dump.json: either the GET /api/kv body ({ qa_bugs: [...], ... }) or mongoexport of kv_store ([{ _id, value }, ...]).
import { connect } from '@tursodatabase/database';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { applyMigrations } from '../db/migrate';
import { blobsFromJson, transformKv, writeServerDb, type KvBlobs } from '../lib/migrate/kv';
import { hashPassword } from '../lib/server/password';
import type { Db } from '../lib/db-types';

const { values: a } = parseArgs({ options: { 'from-json': { type: 'string' }, mongo: { type: 'boolean' }, db: { type: 'string' }, 'dry-run': { type: 'boolean' } } });

async function fromMongo(): Promise<KvBlobs> {
  const mod = 'mongodb'; // not a dependency of web/: install it only on the machine that runs the migration
  const { MongoClient } = await import(mod).catch(() => { throw new Error('mongodb driver missing: run `bun add mongodb`, or use --from-json'); });
  const client = new MongoClient(process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017');
  try {
    await client.connect();
    const rows = await client.db(process.env.DB_NAME ?? 'bugrail').collection('kv_store').find().toArray();
    return Object.fromEntries(rows.map((r: { _id: string; value: unknown }) => [r._id, r.value]));
  } finally { await client.close(); }
}

const blobs = a.mongo ? await fromMongo() : a['from-json'] ? blobsFromJson(readFileSync(a['from-json'], 'utf8')) : null;
if (!blobs) { console.error('give --from-json <file> or --mongo'); process.exit(2); }
const m = await transformKv(blobs, { hash: hashPassword });
console.log(JSON.stringify(m.report, null, 2));
if (a['dry-run']) { console.log('dry run: nothing written'); process.exit(0); }
if (!a.db) { console.error('give --db <server.db path>'); process.exit(2); }

const db = (await connect(a.db)) as unknown as Db;
await applyMigrations(db, 'server');
await writeServerDb(db, m);
console.log(`wrote ${a.db}`);
