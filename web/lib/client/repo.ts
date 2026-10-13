// Local writes: every change stamps a fresh HLC and lands in the outbox through localWrite. Screens call these, never the db.
import { TABLES, type SyncedTable } from '../../db/tables';
import type { Clock } from '../hlc';
import type { Db, Row } from '../db-types';
import { localWrite } from '../sync/client';

export interface Ctx {
  db: Db;
  clock: Clock;
  email: string;
  // Called after each write (the engine schedules a push). Optional so tests and scripts can write without an engine.
  afterWrite?: () => void;
  // Returns a reason when writes are not allowed right now (device clock too far off); throws before touching the db.
  writeBlock?: () => string | null;
}

export const newId = (prefix: string): string => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

// Insert or update one row. `patch` holds only the fields being changed. A status column in the patch also advances status_hlc,
// so a status move and a description edit made on different devices both survive (the per-column clocks in lww.ts).
export async function upsertRow(ctx: Ctx, tbl: SyncedTable, id: string, patch: Row): Promise<Row> {
  const blocked = ctx.writeBlock?.();
  if (blocked) throw new Error(blocked);
  const def = TABLES[tbl];
  const existing = (await ctx.db.get(`SELECT * FROM ${tbl} WHERE id = ?`, id)) as Row | undefined;
  const row: Row = { ...(existing ?? {}), ...patch, id };
  if (def.kind !== 'insert-only') {
    row.hlc = ctx.clock.now();
    if (def.kind === 'lww+status' && (!existing?.status_hlc || def.statusCols.some((c) => c in patch))) row.status_hlc = ctx.clock.now();
    row.updated_by = ctx.email;
  }
  await localWrite(ctx.db, tbl, row);
  ctx.afterWrite?.();
  return row;
}

// Tombstone, never DELETE: other devices learn about it through the merge.
export const softDelete = (ctx: Ctx, tbl: SyncedTable, id: string) => upsertRow(ctx, tbl, id, { deleted_at: new Date().toISOString() });

// bug_events are insert-only: a new comment, assignment or status entry is a new row.
export const addEvent = (ctx: Ctx, bugId: string, kind: 'comment' | 'status' | 'assignment', fields: Row) =>
  upsertRow(ctx, 'bug_events', newId('ev'), { bug_id: bugId, kind, at: new Date().toISOString(), email: ctx.email, ...fields });

export const createFile = (ctx: Ctx, workspaceId: string | null, name: string) =>
  upsertRow(ctx, 'files', newId('file'), { name, workspace_id: workspaceId, created_by: ctx.email, created_at: new Date().toISOString() });

// New rows start with a null code: the server assigns it on the next push.
export const createBug = (ctx: Ctx, fileId: string, fields: Row) =>
  upsertRow(ctx, 'bugs', newId('bug'), {
    file_id: fileId, status_code: 'OPEN', report_date: new Date().toISOString(), tester: ctx.email, ...fields,
  });

export const createTestcase = (ctx: Ctx, fileId: string, fields: Row) =>
  upsertRow(ctx, 'testcases', newId('tc'), {
    file_id: fileId, status: 'Open', created_by: ctx.email, created_at: new Date().toISOString(), ...fields,
  });

// Live (non-tombstoned) rows for a screen.
export const liveRows = (db: Db, tbl: SyncedTable, where = '1', ...params: unknown[]): Promise<Row[]> =>
  db.all(`SELECT * FROM ${tbl} WHERE deleted_at IS NULL AND (${where}) ORDER BY rowid`, ...params);
