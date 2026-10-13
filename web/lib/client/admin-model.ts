// Master status and custom field definitions: synced tables, so these are local writes like any other (offline works).
// Users, roles, workspaces and the Gemini key are server-side and go through /api/admin (see components/admin-screens.tsx).
import type { Row } from '../db-types';
import { DEFAULT_STATUS_MASTER, type StatusDef } from '../domain/status';
import { newId, softDelete, upsertRow, type Ctx } from './repo';
import { statusMaster } from './bug-model';

export class AdminError extends Error {}

// Legacy generateCode: upper-case the name, non-alphanumerics become "_", suffix _2, _3 on a clash. The code is the row id and never changes.
export function statusCode(name: string, taken: string[]): string {
  const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'STATUS';
  let code = base, n = 2;
  while (taken.includes(code)) code = `${base}_${n++}`;
  return code;
}

export interface StatusForm { name: string; color: string; order: number }

export function validateStatus(f: StatusForm, others: StatusDef[]): { name?: string; color?: string } {
  const e: { name?: string; color?: string } = {};
  if (!f.name.trim()) e.name = 'Nama Status wajib diisi.';
  else if (others.some((s) => s.name === f.name.trim())) e.name = 'Nama status sudah dipakai.';
  if (!/^#[0-9A-Fa-f]{6}$/.test(f.color.trim())) e.color = 'Warna Label harus format hex, contoh #2563EB.';
  return e;
}

// An empty master table means "the defaults". The first edit turns them into real rows so the change has something to apply to.
async function ensureSeeded(ctx: Ctx): Promise<StatusDef[]> {
  const rows = (await ctx.db.all('SELECT * FROM bug_status_master')) as Row[];
  const master = statusMaster(rows);
  if (!rows.some((r) => !r.deleted_at)) {
    for (const s of DEFAULT_STATUS_MASTER) await upsertRow(ctx, 'bug_status_master', s.code, { name: s.name, color: s.color, sort_order: s.order });
  }
  return master;
}

export async function saveStatus(ctx: Ctx, f: StatusForm, code?: string): Promise<string> {
  const master = await ensureSeeded(ctx);
  const errs = validateStatus(f, master.filter((s) => s.code !== code));
  if (errs.name || errs.color) throw Object.assign(new AdminError(errs.name ?? errs.color), { fields: errs });
  const id = code ?? statusCode(f.name, master.map((s) => s.code));
  await upsertRow(ctx, 'bug_status_master', id, { name: f.name.trim(), color: f.color.trim(), sort_order: Number(f.order) || 1 });
  return id;
}

export async function deleteStatus(ctx: Ctx, code: string): Promise<void> {
  const used = Number((await ctx.db.get('SELECT count(*) AS n FROM bugs WHERE status_code = ? AND deleted_at IS NULL', code)).n);
  if (used) throw new AdminError(`Status "${code}" masih dipakai ${used} bug report, tidak bisa dihapus.`);
  await ensureSeeded(ctx);
  await softDelete(ctx, 'bug_status_master', code);
}

export async function addCustomField(ctx: Ctx, label: string): Promise<void> {
  const l = label.trim();
  if (!l) throw new AdminError('Nama field wajib diisi.');
  const dup = await ctx.db.get('SELECT 1 AS x FROM custom_field_defs WHERE deleted_at IS NULL AND label = ?', l);
  if (dup) throw new AdminError('Field dengan nama itu sudah ada.');
  await upsertRow(ctx, 'custom_field_defs', newId('cf'), { label: l });
}

export const removeCustomField = (ctx: Ctx, id: string) => softDelete(ctx, 'custom_field_defs', id);
