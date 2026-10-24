// Migrates the remote Turso database and creates the first admin if it has no users.
// TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... BUGRAIL_ADMIN_EMAIL=... BUGRAIL_ADMIN_PASSWORD=... bun scripts/bootstrap-turso.ts
import { applyMigrations } from '../db/migrate';
import { connectRemote } from '../lib/libsql-db';
import { createUser } from '../lib/server/admin';
import type { Db } from '../lib/db-types';

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token, BUGRAIL_ADMIN_EMAIL: email, BUGRAIL_ADMIN_PASSWORD: password } = process.env;
if (!url) throw new Error('TURSO_DATABASE_URL is required');
const db = connectRemote(url, token);
console.log('schema_version', await applyMigrations(db, 'server'));
// Check and insert in one write transaction so two concurrent bootstraps cannot both create an admin.
const created = await db.transactionAsync(async (tx) => {
  if (await tx.get('SELECT 1 FROM users LIMIT 1')) return false;
  if (!email || !password) throw new Error('BUGRAIL_ADMIN_EMAIL and BUGRAIL_ADMIN_PASSWORD are required on an empty database');
  const r = await createUser(tx as Db, { email, role: 'admin', password });
  if (!r.ok) throw new Error(`admin not created: ${JSON.stringify(r)}`);
  return true;
})();
console.log(created ? `admin created ${email}` : 'users exist; admin not created');
