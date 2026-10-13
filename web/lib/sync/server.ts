import { TABLES, SYNCED_TABLES, isSyncedTable, type SyncedTable } from '../../db/tables';
import { mergeArgs, mergeSql } from '../lww';
import { nextInScope } from '../id-gen';
import type { Db, Row, Tx } from '../db-types';
import type { User } from './users';

export interface PushRow { tbl: SyncedTable; row: Row }
export interface PushResult { accepted: string[]; rejected: { id: string; reason: string }[]; server: PushRow[] }
export interface PullResult { rows: PushRow[]; next: number; more: boolean }

export const MAX_PUSH = 500;
export const MAX_PULL = 2000;

const HLC_RE = /^(\d{15})-\d{5}-[\w-]+$/;
const MAX_DRIFT_MS = 24 * 3600_000;
const badHlc = (v: unknown) => {
  const m = typeof v === 'string' ? HLC_RE.exec(v) : null;
  return !m || Number(m[1]) > Date.now() + MAX_DRIFT_MS;
};

const isAdmin = (u: User) => u.role === 'admin';
const inList = (n: number) => Array(n).fill('?').join(', ');

// Files the user may see: owned by one of their workspaces or shared into one.
function visibleFilesSql(u: User): { sql: string; params: string[] } {
  if (isAdmin(u)) return { sql: 'SELECT id FROM files', params: [] };
  const w = u.workspaceIds;
  if (w.length === 0) return { sql: 'SELECT id FROM files WHERE 0', params: [] };
  return {
    sql: `SELECT id FROM files WHERE workspace_id IN (${inList(w.length)})
          UNION SELECT file_id FROM file_shares WHERE deleted_at IS NULL AND workspace_id IN (${inList(w.length)})`,
    params: [...w, ...w],
  };
}

function visibilityFilter(tbl: SyncedTable, u: User): { sql: string; params: string[] } {
  if (isAdmin(u)) return { sql: '1', params: [] };
  const vf = visibleFilesSql(u);
  const w = u.workspaceIds;
  if (w.length === 0) return { sql: '0', params: [] };
  switch (tbl) {
    case 'files': return { sql: `id IN (${vf.sql})`, params: vf.params };
    case 'bugs': return { sql: `file_id IN (${vf.sql})`, params: vf.params };
    case 'bug_events': return { sql: `bug_id IN (SELECT id FROM bugs WHERE file_id IN (${vf.sql}))`, params: vf.params };
    case 'file_shares':
      return {
        sql: `workspace_id IN (${inList(w.length)}) OR file_id IN (SELECT id FROM files WHERE workspace_id IN (${inList(w.length)}))`,
        params: [...w, ...w],
      };
    // shortcut: tables without rules yet are admin-only; Phase 3 adds their visibility rules.
    default: return { sql: '0', params: [] };
  }
}

async function fileVisible(tx: Tx, u: User, fileId: unknown): Promise<boolean> {
  if (isAdmin(u)) return true;
  const vf = visibleFilesSql(u);
  return !!(await tx.get(`SELECT 1 AS ok FROM (${vf.sql}) v WHERE v.id = ?`, ...vf.params, fileId));
}

async function ownsFile(tx: Tx, u: User, fileId: unknown): Promise<boolean> {
  if (isAdmin(u)) return true;
  const f = await tx.get('SELECT workspace_id FROM files WHERE id = ?', fileId);
  return !!f && u.workspaceIds.includes(f.workspace_id);
}

// shortcut: workspace membership only; the role permission matrix (can()) and status transition rules arrive in Phase 3.
async function denyReason(tx: Tx, u: User, tbl: SyncedTable, row: Row): Promise<string | null> {
  if (typeof row.id !== 'string' || !row.id) return 'missing id';
  if (TABLES[tbl].kind !== 'insert-only' && typeof row.hlc !== 'string') return 'missing hlc';
  if (TABLES[tbl].kind === 'lww+status' && typeof row.status_hlc !== 'string') return 'missing status_hlc';
  if (row.hlc !== undefined && badHlc(row.hlc)) return 'bad hlc';
  if (row.status_hlc !== undefined && badHlc(row.status_hlc)) return 'bad status_hlc';
  if (TABLES[tbl].kind === 'insert-only' && typeof row.bug_id === 'string') {
    const ev = await tx.get(`SELECT bug_id FROM ${tbl} WHERE id = ?`, row.id);
    if (ev && ev.bug_id !== row.bug_id) return 'id belongs to another bug';
  }
  if (isAdmin(u)) return null;
  switch (tbl) {
    case 'files': {
      const existing = await tx.get('SELECT workspace_id FROM files WHERE id = ?', row.id);
      if (existing) {
        if (!u.workspaceIds.includes(existing.workspace_id)) return 'file belongs to another workspace';
        if (row.workspace_id !== existing.workspace_id) return 'only admin can move a file';
        return null;
      }
      return u.workspaceIds.includes(row.workspace_id as string) ? null : 'cannot create a file in another workspace';
    }
    case 'file_shares': {
      if (typeof row.file_id !== 'string' || typeof row.workspace_id !== 'string') return 'bad share';
      const existing = await tx.get('SELECT file_id, workspace_id FROM file_shares WHERE id = ?', row.id);
      if (existing) {
        if (row.file_id !== existing.file_id || row.workspace_id !== existing.workspace_id) return 'share file or workspace cannot change';
        return (await ownsFile(tx, u, existing.file_id)) ? null : 'only the owning workspace can share a file';
      }
      return (await ownsFile(tx, u, row.file_id)) ? null : 'only the owning workspace can share a file';
    }
    case 'bugs': {
      if (typeof row.file_id !== 'string') return 'bad file_id';
      const existing = await tx.get('SELECT file_id FROM bugs WHERE id = ?', row.id);
      if (existing && !(await fileVisible(tx, u, existing.file_id))) return 'bug not visible';
      if (existing && existing.file_id !== row.file_id) return 'only admin can move a bug';
      return (await fileVisible(tx, u, row.file_id)) ? null : 'file not visible';
    }
    case 'bug_events': {
      if (typeof row.bug_id !== 'string') return 'bad bug_id';
      const b = await tx.get('SELECT file_id FROM bugs WHERE id = ?', row.bug_id);
      return b && (await fileVisible(tx, u, b.file_id)) ? null : 'bug not visible';
    }
    default: return 'admin only until Phase 3';
  }
}

const comparable = (tbl: SyncedTable, row: Row) =>
  JSON.stringify(TABLES[tbl].columns.filter((c) => c !== 'server_seq').map((c) => row[c] ?? null));

export async function push(db: Db, user: User, input: unknown[]): Promise<PushResult> {
  const rows = input.slice(0, MAX_PUSH);
  const overflow = input.slice(MAX_PUSH);
  const run = db.transactionAsync(async (tx: Tx) => {
    let seq = Number((await tx.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value);
    const result: PushResult = { accepted: [], rejected: [], server: [] };
    const sent = new Map<string, PushRow>();
    for (const item of overflow as { row?: Row }[]) result.rejected.push({ id: String(item?.row?.id ?? ''), reason: 'too many rows' });

    for (const item of rows as { tbl?: unknown; row?: Row }[]) {
      if (!item || typeof item.row !== 'object' || item.row === null || Array.isArray(item.row)) {
        result.rejected.push({ id: '', reason: 'bad row' });
        continue;
      }
      const row = { ...item.row };
      const id = String(row.id ?? '');
      const tbl = item?.tbl;
      if (!isSyncedTable(tbl)) { result.rejected.push({ id, reason: 'unknown table' }); continue; }
      const reason = await denyReason(tx, user, tbl, row);
      if (reason) { result.rejected.push({ id, reason }); continue; }
      if (TABLES[tbl].columns.includes('code')) row.code = null; // the server owns codes
      row.server_seq = seq + 1;
      const r = await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
      if (r.changes > 0) seq += 1;
      result.accepted.push(id);
      sent.set(`${tbl}:${id}`, { tbl, row });
    }

    // Assign display codes: scope = owning workspace of the bug's file.
    const pending = await tx.all(
      `SELECT b.id, f.workspace_id FROM bugs b JOIN files f ON f.id = b.file_id
       WHERE b.code IS NULL AND b.deleted_at IS NULL`,
    );
    for (const p of pending) {
      const codes = await tx.all(
        `SELECT b.code FROM bugs b JOIN files f ON f.id = b.file_id
         WHERE f.workspace_id = ? AND b.deleted_at IS NULL AND b.code IS NOT NULL`,
        p.workspace_id,
      );
      seq += 1;
      await tx.run('UPDATE bugs SET code = ?, server_seq = ? WHERE id = ? AND code IS NULL',
        nextInScope('BUG', codes.map((c) => c.code)), seq, p.id);
    }

    await tx.run("UPDATE sync_meta SET value = ? WHERE key = 'seq'", seq);

    for (const [, s] of sent) {
      const f = visibilityFilter(s.tbl, user);
      const current = await tx.get(`SELECT * FROM ${s.tbl} WHERE id = ? AND (${f.sql})`, s.row.id, ...f.params);
      if (current && comparable(s.tbl, current) !== comparable(s.tbl, s.row)) result.server.push({ tbl: s.tbl, row: current });
    }
    return result;
  });
  return run();
}

export async function pull(db: Db, user: User, since: number, limit = MAX_PULL): Promise<PullResult> {
  const pageSize = Math.max(1, Math.min(Math.floor(limit) || 1, MAX_PULL));
  const all: (PushRow & { seq: number })[] = [];
  for (const tbl of SYNCED_TABLES) {
    const f = visibilityFilter(tbl, user);
    const rows = await db.all(
      `SELECT * FROM ${tbl} WHERE server_seq > ? AND (${f.sql}) ORDER BY server_seq LIMIT ?`,
      since, ...f.params, pageSize + 1,
    );
    for (const row of rows) all.push({ tbl, row, seq: Number(row.server_seq) });
  }
  all.sort((a, b) => a.seq - b.seq);
  const page = all.slice(0, pageSize);
  const next = page.length ? page[page.length - 1].seq : since;
  return { rows: page.map(({ tbl, row }) => ({ tbl, row })), next, more: all.length > pageSize };
}
