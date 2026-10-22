// Creates the first admin on a server.db. bun scripts/create-admin.ts <db path> <email>
// A random password is generated and printed once.
import { randomBytes } from 'node:crypto';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createUser } from '../lib/server/admin';
import type { Db } from '../lib/db-types';

const [path, email] = process.argv.slice(2);
if (!path || !email) {
  console.error('usage: bun scripts/create-admin.ts <db path> <email>');
  process.exit(2);
}
const password = randomBytes(15).toString('base64url');
const db = (await connect(path)) as unknown as Db;
await applyMigrations(db, 'server');
const r = await createUser(db, { email, role: 'admin', password });
if (!r.ok) {
  console.error('failed:', r.error);
  process.exit(1);
}
console.log(`admin created\nemail:    ${email}\npassword: ${password}`);
