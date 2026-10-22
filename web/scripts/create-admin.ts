// Creates the first admin on a server.db. bun scripts/create-admin.ts <db path> <email>
// A random password is generated and printed once.
import { randomBytes } from 'node:crypto';
import { statSync } from 'node:fs';
import { connect } from '@tursodatabase/database';
import { createUser } from '../lib/server/admin';
import type { Db } from '../lib/db-types';

const args = process.argv.slice(2);
const [path, email] = args;
if (args.length !== 2 || !path || !email) {
  console.error('usage: bun scripts/create-admin.ts <db path> <email>');
  process.exit(2);
}
// connect() would create a new empty file for a mistyped path (and ':memory:' keeps nothing)
if (!statSync(path, { throwIfNoEntry: false })?.isFile()) {
  console.error(`not an existing database file: ${path}`);
  process.exit(2);
}
const password = randomBytes(15).toString('base64url');
const db = (await connect(path)) as unknown as Db;
// must already be migrated (cutover migration, or the app's first start): never build a schema here
if (!(await db.get("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'users'"))) {
  console.error(`${path} has no users table: migrate it first`);
  process.exit(2);
}
// first-admin bootstrap only: an existing admin (e.g. migrated from the old app) uses the admin screen instead
if (await db.get("SELECT 1 FROM users WHERE role = 'admin' LIMIT 1")) {
  console.error('an admin already exists: use the admin screen to add users');
  process.exit(2);
}
const r = await createUser(db, { email, role: 'admin', password });
if (!r.ok) {
  console.error('failed:', r.error);
  process.exit(1);
}
console.log(`admin created\nemail:    ${email}\npassword: ${password}`);
