// Local writes for bugs: create, edit, status moves, comments, delete. Each is a few outbox entries; the server has the final say.
import { BUG_FORM } from '../domain/forms';
import { normalizeEmail } from '../domain/auth';
import { textToStepsHtml } from '../domain/steps';
import type { Row } from '../db-types';
import { QA_BLOCK_MESSAGE, readExtra, statusRule, type BugExtra } from './bug-model';
import { addEvent, logActivity, newId, softDelete, upsertRow, type Ctx } from './repo';

export interface BugForm {
  test_case_id: string | null; module: string; scenario: string; preconditions: string; test_data: string;
  steps: string; expected_result: string; useTcSteps: boolean; useTcExpected: boolean; tester: string;
  title: string; description: string; actual_result: string; severity: string; priority: string; status_code: string;
  environment: string; build_version: string; platform: string; os: string; browser: string; device: string;
  attachments: string; assignee: string;
}
export const emptyBugForm = (tester: string, status: string): BugForm => ({
  test_case_id: null, module: '', scenario: '', preconditions: '', test_data: '', steps: '', expected_result: '', useTcSteps: false, useTcExpected: false,
  tester, title: '', description: '', actual_result: '', severity: 'Medium', priority: '', status_code: status,
  environment: '', build_version: '', platform: '', os: '', browser: '', device: '', attachments: '', assignee: '',
});

export class BugFormError extends Error {
  constructor(public errors: Record<string, string>) { super(Object.values(errors)[0] ?? 'Invalid bug'); }
}
export interface StatusChange { note: string; attachment: string }
export interface SaveOpts {
  fileId: string; bugId?: string; form: BugForm;
  // Only status and priority may change: the user holds bugreport_updateStatusPriority but not bugreport_update.
  limited?: boolean; isQA: boolean; change?: StatusChange | null; firstStatus: string;
}

const ws = async (ctx: Ctx, fileId: string) => (((await ctx.db.get('SELECT workspace_id FROM files WHERE id = ?', fileId)) as Row | undefined)?.workspace_id as string | null) ?? null;
const text = (v: unknown) => (typeof v === 'string' ? v : '');

export async function saveBug(ctx: Ctx, o: SaveOpts): Promise<Row> {
  const creating = !o.bugId;
  const f = o.form;
  const prev = creating ? undefined : ((await ctx.db.get('SELECT * FROM bugs WHERE id = ? AND deleted_at IS NULL', o.bugId)) as Row | undefined);
  if (!creating && !prev) throw new Error('This bug no longer exists');
  const wsId = await ws(ctx, o.fileId);

  if (o.limited && prev) {
    // Status and priority only: everything else is left exactly as stored.
    const to = f.status_code;
    if (to !== prev.status_code) await changeStatus(ctx, [String(prev.id)], to, o.change ?? null, o.isQA);
    if (f.priority !== text(prev.priority)) await upsertRow(ctx, 'bugs', String(prev.id), { priority: f.priority });
    return (await ctx.db.get('SELECT * FROM bugs WHERE id = ?', prev.id)) as Row;
  }

  const show = BUG_FORM.conditionalFields(f.platform);
  const errors = BUG_FORM.errors({ ...f, actualResult: f.actual_result, expectedResult: f.expected_result }, creating);
  if (Object.keys(errors).length) throw new BugFormError(errors);

  const extra: BugExtra = { ...readExtra(prev), os: f.os.trim(), scenario: f.scenario.trim(), preconditions: f.preconditions.trim(), testData: f.test_data.trim(), useTcSteps: !!f.test_case_id && f.useTcSteps, useTcExpected: !!f.test_case_id && f.useTcExpected };
  const cols: Row = {
    test_case_id: f.test_case_id, module: f.module.trim(), steps: textToStepsHtml(f.steps), expected_result: f.expected_result.trim(), tester: f.tester.trim(),
    title: f.title.trim(), description: f.description.trim(), actual_result: f.actual_result.trim(), severity: f.severity, priority: f.priority,
    environment: f.environment, build_version: f.build_version.trim(), platform: f.platform,
    // A new bug does not keep Browser / Device its platform does not use.
    browser: show.browser || !creating ? f.browser.trim() : '', device: show.device || !creating ? f.device.trim() : '',
    attachments: f.attachments.trim(), assignee: f.assignee, extra: JSON.stringify(extra),
  };

  if (creating) {
    const row = await upsertRow(ctx, 'bugs', newId('bug'), { ...cols, file_id: o.fileId, status_code: o.firstStatus, report_date: new Date().toISOString() });
    if (f.assignee) await addEvent(ctx, String(row.id), 'assignment', { assignee: f.assignee, email: ctx.email });
    await logActivity(ctx, wsId, 'bugreport_create', `Bug "${cols.title}" dibuat`);
    return row;
  }

  const id = String(prev!.id);
  const from = text(prev!.status_code);
  const statusMoved = f.status_code !== from;
  if (statusMoved) {
    const rule = statusRule([prev!], f.status_code, o.isQA);
    if (!rule.ok) throw new Error(QA_BLOCK_MESSAGE);
    if (rule.needNote && !o.change?.note.trim()) throw new Error('A note is required for this status change');
  }
  const row = await upsertRow(ctx, 'bugs', id, { ...cols, ...(statusMoved ? { status_code: f.status_code } : {}) });
  if (statusMoved) await addEvent(ctx, id, 'status', { from_status: from, to_status: f.status_code, note: o.change?.note ?? '', attachment: o.change?.attachment ?? '' });
  if (normalizeEmail(prev!.assignee) !== normalizeEmail(f.assignee)) await addEvent(ctx, id, 'assignment', { assignee: f.assignee, email: ctx.email });
  await logActivity(ctx, wsId, 'bugreport_update', `Bug ${text(prev!.code) || id} diperbarui${statusMoved ? ` (status ${from} → ${f.status_code}${o.change?.note ? `: ${o.change.note}` : ''})` : ''}`);
  return row;
}

// One status move for one or many bugs (board drop, form, bulk). The rule is checked for all of them before any is written.
export async function changeStatus(ctx: Ctx, ids: string[], toCode: string, change: StatusChange | null, isQA: boolean): Promise<number> {
  const rows: Row[] = [];
  for (const id of ids) { const r = (await ctx.db.get('SELECT * FROM bugs WHERE id = ? AND deleted_at IS NULL', id)) as Row | undefined; if (r) rows.push(r); }
  const moving = rows.filter((b) => b.status_code !== toCode);
  if (!moving.length) return 0;
  const rule = statusRule(moving, toCode, isQA);
  if (!rule.ok) throw new Error(QA_BLOCK_MESSAGE);
  if (rule.needNote && !change?.note.trim()) throw new Error('A note is required for this status change');
  for (const b of moving) {
    await upsertRow(ctx, 'bugs', String(b.id), { status_code: toCode });
    await addEvent(ctx, String(b.id), 'status', { from_status: b.status_code, to_status: toCode, note: change?.note ?? '', attachment: change?.attachment ?? '' });
  }
  const first = moving[0];
  await logActivity(ctx, await ws(ctx, String(first.file_id)), 'bugreport_update',
    moving.length === 1 ? `Bug ${text(first.code) || first.id} status diubah dari ${first.status_code} ke ${toCode}${change?.note ? `: ${change.note}` : ''}` : `${moving.length} bug status diubah menjadi ${toCode} (bulk)${change?.note ? `: ${change.note}` : ''}`);
  return moving.length;
}

export async function addComment(ctx: Ctx, bugId: string, body: string): Promise<boolean> {
  const t = body.trim();
  if (!t) return false;
  if (!(await ctx.db.get('SELECT 1 AS x FROM bugs WHERE id = ? AND deleted_at IS NULL', bugId))) throw new Error('This bug no longer exists');
  await addEvent(ctx, bugId, 'comment', { text: t });
  return true;
}

// Missing and already-deleted ids are skipped, so the count is what changed and no stray tombstone row is created.
export async function deleteBugs(ctx: Ctx, ids: string[]): Promise<number> {
  let n = 0, last: Row | undefined;
  for (const id of ids) {
    const r = (await ctx.db.get('SELECT code, file_id FROM bugs WHERE id = ? AND deleted_at IS NULL', id)) as Row | undefined;
    if (!r) continue;
    await softDelete(ctx, 'bugs', id);
    last = r; n++;
  }
  if (last) await logActivity(ctx, await ws(ctx, String(last.file_id)), 'bugreport_delete', n === 1 ? `Bug ${text(last.code) || ids[0]} dihapus` : `${n} bug dihapus (bulk)`);
  return n;
}

export async function bugTimeline(ctx: Pick<Ctx, 'db'>, bugId: string): Promise<Row[]> {
  return ctx.db.all("SELECT * FROM bug_events WHERE bug_id = ? ORDER BY at, id", bugId);
}
