// Migrates the remote Turso database and creates the first admin if it has no users.
// TURSO_DATABASE_URL=... TURSO_AUTH_TOKEN=... BUGRAIL_ADMIN_EMAIL=... BUGRAIL_ADMIN_PASSWORD=... bun scripts/bootstrap-turso.ts
import { applyMigrations } from '../db/migrate';
import { connectRemote } from '../lib/libsql-db';
import { createUser } from '../lib/server/admin';

const { TURSO_DATABASE_URL: url, TURSO_AUTH_TOKEN: token, BUGRAIL_ADMIN_EMAIL: email, BUGRAIL_ADMIN_PASSWORD: password } = process.env;
if (!url) throw new Error('TURSO_DATABASE_URL is required');
const db = connectRemote(url, token);
console.log('schema_version', await applyMigrations(db, 'server'));
if ((await db.get('SELECT 1 FROM users LIMIT 1'))) console.log('users exist; admin not created');
else {
  if (!email || !password) throw new Error('BUGRAIL_ADMIN_EMAIL and BUGRAIL_ADMIN_PASSWORD are required on an empty database');
  const r = await createUser(db, { email, role: 'admin', password });
  if (!r.ok) throw new Error(`admin not created: ${JSON.stringify(r)}`);
  console.log('admin created', email);
}
