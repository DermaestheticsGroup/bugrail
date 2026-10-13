// server.db -> legacy kv blobs, for rollback. Writes a JSON file; --to-mongo --yes also writes kv_store (rev + 1).
// bun scripts/export-turso-to-kv.ts --db /var/lib/bugrail/server.db --original original-kv.json --out exported-kv.json
// --original is the untouched legacy dump (or the live kv_store): cutover users get their old plaintext password back from it.
// Users created after cutover get a temporary password, printed once here.
import { connect } from '@tursodatabase/database';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { exportKv } from '../lib/migrate/kv';
import type { Db } from '../lib/db-types';

const { values: a } = parseArgs({ options: { db: { type: 'string' }, original: { type: 'string' }, out: { type: 'string' }, 'to-mongo': { type: 'boolean' }, yes: { type: 'boolean' } } });
if (!a.db) { console.error('give --db <server.db path>'); process.exit(2); }

const original = a.original ? JSON.parse(readFileSync(a.original, 'utf8')) : null;
const originalSettings = Array.isArray(original) ? original.find((d: { _id: string }) => d._id === 'qa_settings')?.value : original?.qa_settings ?? null;
const db = (await connect(a.db)) as unknown as Db;
const { blobs, tempPasswords } = await exportKv(db, { originalSettings });

if (a.out) writeFileSync(a.out, JSON.stringify(blobs, null, 2));
if (Object.keys(tempPasswords).length) console.log('temporary passwords (give to each user, then they reset):\n' + JSON.stringify(tempPasswords, null, 2));

if (a['to-mongo']) {
  if (!a.yes) { console.error('--to-mongo overwrites kv_store; add --yes to confirm'); process.exit(2); }
  const mod = 'mongodb';
  const { MongoClient } = await import(mod).catch(() => { throw new Error('mongodb driver missing: run `bun add mongodb`'); });
  const client = new MongoClient(process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017');
  try {
    await client.connect();
    const kv = client.db(process.env.DB_NAME ?? 'bugrail').collection('kv_store');
    for (const [key, value] of Object.entries(blobs)) await kv.updateOne({ _id: key }, { $set: { value }, $inc: { rev: 1 } }, { upsert: true });
    console.log('wrote kv_store');
  } finally { await client.close(); }
}
