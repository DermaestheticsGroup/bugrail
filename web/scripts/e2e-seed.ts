// Seeds a fresh server.db for the browser e2e. bun scripts/e2e-seed.ts <db path>
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createUser, createWorkspace } from '../lib/server/admin';
import type { Db } from '../lib/db-types';

const db = (await connect(process.argv[2])) as unknown as Db;
await applyMigrations(db, 'server');
const a = await createWorkspace(db, 'Alpha');
const v = await createWorkspace(db, 'Vendor');
if (!a.ok || !v.ok) throw new Error('workspace');
await createUser(db, { email: 'root@x.test', role: 'admin', password: 'rootpass123' });
await createUser(db, { email: 'qa@x.test', role: 'qa_internal', password: 'qapass1234', workspaceIds: [a.id] });
await createUser(db, { email: 'qa2@x.test', role: 'qa_internal', password: 'qapass1234', workspaceIds: [a.id] });
await createUser(db, { email: 'vendor@x.test', role: 'qa_vendor', password: 'vendorpass1', workspaceIds: [v.id] });
console.log(JSON.stringify({ alpha: a.id, vendor: v.id }));
