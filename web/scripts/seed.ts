// Build a production-sized server.db. Usage:
// bun scripts/seed.ts --db data/server.db --files 150 --rows 6000 --events 18000
// Workspaces: file-0 is ws-v (the vendor's), file-1, file-5, … are ws-a (alice/bob), the rest ws-2/ws-3/ws-0.
import { connect } from '@tursodatabase/database';
import { statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { applySchema } from '../lib/schema';
import { TABLES } from '../db/tables';
import { mergeArgs, mergeSql } from '../lib/lww';
import type { Db } from '../lib/db-types';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'data/server.db' },
    files: { type: 'string', default: '150' },
    rows: { type: 'string', default: '6000' },
    events: { type: 'string', default: '18000' },
  },
});
const n = (k: keyof typeof values) => Number(values[k]);
const db = (await connect(values.db!)) as unknown as Db;
await applySchema(db, ['schema', 'server']);

const hlc = '000000000000001-00000-migrate';
const text = (len: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(len / 27)).slice(0, len);
let seq = 0;
const insert = (tbl: keyof typeof TABLES, row: Record<string, unknown>) =>
  db.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], { ...row, server_seq: ++seq }));

const wsOf = (fileIndex: number) => (fileIndex === 0 ? 'ws-v' : fileIndex % 4 === 1 ? 'ws-a' : `ws-${fileIndex % 4}`);
const fileIds: string[] = [];
for (let i = 0; i < n('files'); i++) {
  const id = `file-${i}`;
  fileIds.push(id);
  await insert('files', { id, name: `File ${i}`, workspace_id: wsOf(i), hlc });
}
const bugIds: string[] = [];
const perScope = new Map<string, number>();
for (let i = 0; i < n('rows'); i++) {
  const id = `bug-${i}`;
  const fileId = fileIds[i % fileIds.length];
  const scope = wsOf(i % fileIds.length);
  const next = (perScope.get(scope) ?? 0) + 1;
  perScope.set(scope, next);
  bugIds.push(id);
  await insert('bugs', {
    id, code: `BUG-${String(next).padStart(4, '0')}`, file_id: fileId, title: text(60), module: 'Login',
    severity: 'Major', priority: 'High', status_code: 'OPEN', status_hlc: hlc, description: text(400),
    steps: text(600), expected_result: text(150), actual_result: text(150), hlc,
  });
}
for (let i = 0; i < n('events'); i++) {
  await insert('bug_events', { id: `ev-${i}`, bug_id: bugIds[i % bugIds.length], kind: 'comment', at: '2026-10-01T00:00:00Z', text: text(200) });
}
await db.run("UPDATE sync_meta SET value = ? WHERE key = 'seq'", seq);
await db.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
console.log(JSON.stringify({ seeded: seq, bytes: statSync(values.db!).size }));
