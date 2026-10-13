// Local writes for files and test cases. Each call is a handful of outbox entries; the server decides what it accepts.
import type { Row } from '../db-types';
import { logActivity, newId, softDelete, upsertRow, type Ctx } from './repo';

export const todayISO = () => new Date().toISOString().slice(0, 10);

export async function renameFile(ctx: Ctx, fileId: string, name: string): Promise<void> {
  const n = name.trim();
  if (!n) throw new Error('Name is required');
  const f = (await ctx.db.get('SELECT name, workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined;
  if (!f) throw new Error('No such file');
  if (f.name === n) return;
  await upsertRow(ctx, 'files', fileId, { name: n });
  await logActivity(ctx, f.workspace_id as string | null, 'tc_file_rename', `File "${f.name}" diganti nama jadi "${n}"`);
}

// Workspaces the file is shared into right now (tombstoned shares do not count).
export async function fileShares(ctx: Pick<Ctx, 'db'>, fileId: string): Promise<string[]> {
  return (await ctx.db.all('SELECT workspace_id FROM file_shares WHERE file_id = ? AND deleted_at IS NULL ORDER BY workspace_id', fileId)).map((r) => String(r.workspace_id));
}

// Makes the live shares equal `workspaceIds`: new ones are inserted (or revived), removed ones are tombstoned. Share ids are
// "<file>:<workspace>", the only form the server accepts, so a re-share revives the same row instead of making a second one.
export async function setFileShares(ctx: Ctx, fileId: string, workspaceIds: string[]): Promise<{ added: number; removed: number }> {
  const f = (await ctx.db.get('SELECT name, workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined;
  if (!f) throw new Error('No such file');
  const want = [...new Set(workspaceIds)].filter((w) => w !== f.workspace_id); // sharing a file into its own workspace means nothing
  const have = await fileShares(ctx, fileId);
  const add = want.filter((w) => !have.includes(w)), drop = have.filter((w) => !want.includes(w));
  for (const w of add) await upsertRow(ctx, 'file_shares', `${fileId}:${w}`, { file_id: fileId, workspace_id: w, deleted_at: null });
  for (const w of drop) await softDelete(ctx, 'file_shares', `${fileId}:${w}`);
  if (add.length || drop.length) {
    await logActivity(ctx, f.workspace_id as string | null, 'tc_file_share', want.length ? `File "${f.name}" dibagikan ke ${want.length} workspace` : `Sharing File "${f.name}" dihapus`);
  }
  return { added: add.length, removed: drop.length };
}

export async function countInFile(ctx: Pick<Ctx, 'db'>, fileId: string): Promise<{ testcases: number; bugs: number }> {
  const n = async (t: string) => Number((await ctx.db.get(`SELECT count(*) AS n FROM ${t} WHERE file_id = ? AND deleted_at IS NULL`, fileId)).n);
  return { testcases: await n('testcases'), bugs: await n('bugs') };
}

// Deleting a file removes its test cases and bugs (tombstones, so every device learns). Bug events stay but become unreachable,
// because visibility of an event follows its bug's file.
export async function deleteFileCascade(ctx: Ctx, fileId: string): Promise<{ testcases: number; bugs: number }> {
  const f = (await ctx.db.get('SELECT name, workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined;
  if (!f) throw new Error('No such file');
  const counts = await countInFile(ctx, fileId);
  for (const t of await ctx.db.all('SELECT id FROM testcases WHERE file_id = ? AND deleted_at IS NULL', fileId)) await softDelete(ctx, 'testcases', String(t.id));
  for (const b of await ctx.db.all('SELECT id FROM bugs WHERE file_id = ? AND deleted_at IS NULL', fileId)) await softDelete(ctx, 'bugs', String(b.id));
  await softDelete(ctx, 'files', fileId);
  await logActivity(ctx, f.workspace_id as string | null, 'tc_file_delete', `File "${f.name}" dihapus`);
  return counts;
}

export interface TcForm {
  module: string; role_user?: string; scenario: string; test_case?: string; preconditions?: string; steps?: string;
  test_data?: string; expected_result?: string; type_test?: string; custom_fields?: Record<string, string>;
}
const formCols = (f: Partial<TcForm>): Row => {
  const { custom_fields, ...rest } = f;
  return { ...rest, ...(custom_fields ? { custom_fields: JSON.stringify(custom_fields) } : {}) };
};

export async function saveTestcase(ctx: Ctx, fileId: string, f: TcForm, id?: string): Promise<Row> {
  if (!f.module.trim()) throw new Error('Module is required');
  if (!f.scenario.trim()) throw new Error('Scenario is required');
  const ws = ((await ctx.db.get('SELECT workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined)?.workspace_id as string | null ?? null;
  if (id) {
    const row = await upsertRow(ctx, 'testcases', id, formCols(f));
    await logActivity(ctx, ws, 'testcase_update', `Test Case ${row.code ?? id} diubah`);
    return row;
  }
  const row = await upsertRow(ctx, 'testcases', newId('tc'), {
    ...formCols(f), file_id: fileId, status: 'Open', created_by: ctx.email, created_at: new Date().toISOString(),
  });
  await logActivity(ctx, ws, 'testcase_create', `Test Case "${f.scenario}" dibuat`);
  return row;
}

export async function executeTestcase(ctx: Ctx, id: string, r: { status: string; actual_result: string; evidence: string }): Promise<void> {
  const cur = (await ctx.db.get('SELECT code, status, file_id FROM testcases WHERE id = ?', id)) as Row | undefined;
  if (!cur) throw new Error('No such test case');
  await upsertRow(ctx, 'testcases', id, { status: r.status, actual_result: r.actual_result.trim(), evidence: r.evidence.trim(), execution_date: todayISO() });
  if (cur.status !== r.status) {
    const ws = ((await ctx.db.get('SELECT workspace_id FROM files WHERE id = ?', cur.file_id)) as Row | undefined)?.workspace_id as string | null ?? null;
    await logActivity(ctx, ws, 'testcase_update', `Test Case ${cur.code ?? id} status diubah dari ${cur.status} ke ${r.status} (Run)`);
  }
}

// A copy starts Open with no result, and no code: the server numbers it on the next push like any new test case.
export async function duplicateTestcase(ctx: Ctx, id: string): Promise<Row> {
  const tc = (await ctx.db.get('SELECT * FROM testcases WHERE id = ?', id)) as Row | undefined;
  if (!tc) throw new Error('No such test case');
  const { id: _i, code: _c, hlc: _h, status_hlc: _s, server_seq: _q, deleted_at: _d, updated_by: _u, ...keep } = tc;
  void [_i, _c, _h, _s, _q, _d, _u];
  return upsertRow(ctx, 'testcases', newId('tc'), {
    ...keep, code: null, status: 'Open', actual_result: '', evidence: '', execution_date: '', created_by: ctx.email, created_at: new Date().toISOString(),
  });
}

export async function bulkTestcaseStatus(ctx: Ctx, ids: string[], status: string): Promise<number> {
  let n = 0;
  for (const id of ids) {
    const cur = (await ctx.db.get('SELECT status FROM testcases WHERE id = ? AND deleted_at IS NULL', id)) as Row | undefined;
    if (cur && cur.status !== status) { await upsertRow(ctx, 'testcases', id, { status }); n++; }
  }
  return n;
}

export async function bulkTestcaseDelete(ctx: Ctx, ids: string[]): Promise<number> {
  for (const id of ids) await softDelete(ctx, 'testcases', id);
  return ids.length;
}
