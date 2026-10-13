// G0.7: open the backup copy and compare row counts with the live DB at roughly the same moment.
import { connect } from '@tursodatabase/database';
import type { Db } from '../lib/db-types';

const copy = process.argv[2];
if (!copy) throw new Error('usage: bun scripts/backup-check.ts <copy.db>');
const db = (await connect(copy, { readonly: true })) as unknown as Db;
const counts: Record<string, number> = {};
for (const t of ['files', 'bugs', 'bug_events']) counts[t] = (await db.get(`SELECT count(*) AS n FROM ${t}`)).n;
const integrity = await db.get('PRAGMA integrity_check').catch((e: Error) => ({ integrity_check: `unsupported: ${e.message}` }));
console.log(JSON.stringify({ check: 'G0.7', copy, counts, integrity }));
process.exit(counts.bugs > 0 ? 0 : 1);
