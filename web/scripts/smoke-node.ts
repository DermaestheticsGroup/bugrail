// Node 24 smoke, run via node-smoke.mjs (it resolves the extensionless lib/ imports): binding loads, push/pull round trips.
import assert from 'node:assert/strict';
import { connect } from '@tursodatabase/database';
import { applySchema } from '../lib/schema';
import { pull, push } from '../lib/sync/server';
import { USERS } from '../lib/sync/users';
import type { Db } from '../lib/db-types';

const db = (await connect(':memory:')) as unknown as Db;
await applySchema(db, ['schema', 'server']);
const hlc = `${String(1).padStart(15, '0')}-00000-smoke`;
const res = await push(db, USERS.admin, [{ tbl: 'files', row: { id: 'f1', name: 'smoke', workspace_id: 'ws-a', hlc } }]);
assert.deepEqual(res.accepted, ['f1']);
const page = await pull(db, USERS.alice, 0);
const got = page.rows.find((r) => r.tbl === 'files' && r.row.id === 'f1');
assert.equal(got?.row.name, 'smoke');
assert.equal(got?.row.workspace_id, 'ws-a');
console.log('ok');
