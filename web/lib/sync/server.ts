import { TABLES, SYNCED_TABLES, isSyncedTable, type SyncedTable } from '../../db/tables';
import { mergeArgs, mergeSql } from '../lww';
import { nextInScope } from '../id-gen';
import type { Db, Row, Tx } from '../db-types';
import type { User } from './users';
import { can, type RolePermissions } from '../domain/auth';
import { statusTransitionRule } from '../domain/status';

export interface PushRow { tbl: SyncedTable; row: Row }
export interface PushResult { accepted: string[]; rejected: { id: string; tbl?: SyncedTable; reason: string }[]; server: PushRow[] }
export type PullResult = { rows: PushRow[]; next: number; more: boolean } | { reset: true; av: number; sv: number };

export const MAX_PUSH = 500;
export const MAX_PULL = 2000;

const HLC_RE = /^(\d{15})-\d{5}-[\w-]+$/;
const MAX_DRIFT_MS = 24 * 3600_000;
const badHlc = (v: unknown) => {
  const m = typeof v === 'string' ? HLC_RE.exec(v) : null;
  return !m || Number(m[1]) > Date.now() + MAX_DRIFT_MS;
};

const isAdmin = (u: User) => u.role === 'admin';
// Role permission matrix: admin edits it in `secrets.role_permissions`; a missing row falls back to the seed matrix.
const allowed = (u: User, perms: RolePermissions | null, key: string) => can({ role: u.role }, key, perms);
async function loadPerms(tx: Tx): Promise<RolePermissions | null> {
  const r = await tx.get("SELECT value FROM secrets WHERE key = 'role_permissions'");
  try { return r?.value ? JSON.parse(r.value) : null; } catch { return null; }
}
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
  // Global, non-secret config.
  if (tbl === 'bug_status_master' || tbl === 'custom_field_defs') return { sql: '1', params: [] };
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
    case 'activity_log': return { sql: `workspace_id IN (${inList(w.length)})`, params: w };
    case 'testcases': return { sql: `file_id IN (${vf.sql})`, params: vf.params };
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

// shortcut: the "note required" half of statusTransitionRule is not enforced (the note arrives as a separate bug_events row); only ok/not-ok is.
async function denyReason(tx: Tx, u: User, perms: RolePermissions | null, tbl: SyncedTable, row: Row): Promise<string | null> {
  const ok = (k: string) => allowed(u, perms, k);
  if (typeof row.id !== 'string' || !row.id) return 'missing id';
  if (TABLES[tbl].kind !== 'insert-only' && typeof row.hlc !== 'string') return 'missing hlc';
  if (TABLES[tbl].kind === 'lww+status' && typeof row.status_hlc !== 'string') return 'missing status_hlc';
  if (row.hlc !== undefined && badHlc(row.hlc)) return 'bad hlc';
  if (row.status_hlc !== undefined && badHlc(row.status_hlc)) return 'bad status_hlc';
  if (TABLES[tbl].kind === 'insert-only' && typeof row.bug_id === 'string') {
    const ev = await tx.get(`SELECT bug_id FROM ${tbl} WHERE id = ?`, row.id);
    if (ev && ev.bug_id !== row.bug_id) return 'id belongs to another bug';
  }
  if (tbl === 'file_shares' && row.id !== `${row.file_id}:${row.workspace_id}`) return 'bad share id';
  if (isAdmin(u)) return null;
  switch (tbl) {
    case 'files': {
      const existing = await tx.get('SELECT workspace_id FROM files WHERE id = ?', row.id);
      if (existing) {
        if (!u.workspaceIds.includes(existing.workspace_id)) return 'file belongs to another workspace';
        if (row.workspace_id !== existing.workspace_id) return 'only admin can move a file';
        if (row.deleted_at && !ok('testcase_delete') && !ok('bugreport_delete')) return 'not allowed to delete files';
        return null;
      }
      if (!ok('testcase_create') && !ok('bugreport_fileCreate')) return 'not allowed to create files';
      return u.workspaceIds.includes(row.workspace_id as string) ? null : 'cannot create a file in another workspace';
    }
    case 'file_shares': {
      if (typeof row.file_id !== 'string' || typeof row.workspace_id !== 'string') return 'bad share';
      if (!ok('testcase_fileShare')) return 'not allowed to share files';
      const existing = await tx.get('SELECT file_id, workspace_id FROM file_shares WHERE id = ?', row.id);
      if (existing) {
        if (row.file_id !== existing.file_id || row.workspace_id !== existing.workspace_id) return 'share file or workspace cannot change';
        return (await ownsFile(tx, u, existing.file_id)) ? null : 'only the owning workspace can share a file';
      }
      return (await ownsFile(tx, u, row.file_id)) ? null : 'only the owning workspace can share a file';
    }
    case 'testcases': {
      if (typeof row.file_id !== 'string') return 'bad file_id';
      const existing = await tx.get('SELECT file_id FROM testcases WHERE id = ?', row.id);
      if (existing && !(await fileVisible(tx, u, existing.file_id))) return 'test case not visible';
      if (existing && existing.file_id !== row.file_id) return 'only admin can move a test case';
      if (!(await fileVisible(tx, u, row.file_id))) return 'file not visible';
      const need = !existing ? 'testcase_create' : row.deleted_at ? 'testcase_delete' : 'testcase_update';
      return ok(need) ? null : `not allowed: ${need}`;
    }
    case 'bugs': {
      if (typeof row.file_id !== 'string') return 'bad file_id';
      const existing = await tx.get('SELECT * FROM bugs WHERE id = ?', row.id);
      if (existing && !(await fileVisible(tx, u, existing.file_id))) return 'bug not visible';
      if (existing && existing.file_id !== row.file_id) return 'only admin can move a bug';
      if (!(await fileVisible(tx, u, row.file_id))) return 'file not visible';
      if (!existing) {
        if (!ok('bugreport_create')) return 'not allowed: bugreport_create';
        return isAdmin(u) || row.status_code === 'OPEN' ? null : 'new bugs must start OPEN';
      }
      if (row.deleted_at && !existing.deleted_at) return ok('bugreport_delete') ? null : 'not allowed: bugreport_delete';
      const SP = new Set(['status_code', 'status_hlc', 'priority', 'hlc', 'updated_by', 'server_seq', 'code']);
      const onlySP = TABLES.bugs.columns.every((c) => SP.has(c) || (row[c] ?? null) === (existing[c] ?? null));
      if (!ok('bugreport_update') && !(onlySP && ok('bugreport_updateStatusPriority'))) return 'not allowed: bugreport_update';
      // Only a write that wins the status clock changes the status, so only that one needs the transition check.
      if (row.status_code !== existing.status_code && String(row.status_hlc) > String(existing.status_hlc ?? '')) {
        const t = statusTransitionRule(String(existing.status_code), String(row.status_code), ok('bugreport_statusQA'));
        if (!t.ok) return 'status transition not allowed';
      }
      return null;
    }
    case 'bug_events': {
      if (typeof row.bug_id !== 'string') return 'bad bug_id';
      if (!['bugreport_create', 'bugreport_update', 'bugreport_updateStatusPriority', 'bugreport_statusQA'].some(ok)) return 'not allowed to write bug events';
      const b = await tx.get('SELECT file_id FROM bugs WHERE id = ?', row.bug_id);
      return b && (await fileVisible(tx, u, b.file_id)) ? null : 'bug not visible';
    }
    case 'bug_status_master': return ok('master') ? null : 'not allowed: master';
    case 'custom_field_defs': return ok('settings') ? null : 'not allowed: settings';
    case 'activity_log':
      if (row.actor_email !== u.email) return 'actor is not you';
      return u.workspaceIds.includes(row.workspace_id as string) ? null : 'workspace not yours';
    default: return 'not allowed';
  }
}

const comparable = (tbl: SyncedTable, row: Row) =>
  JSON.stringify(TABLES[tbl].columns.filter((c) => c !== 'server_seq').map((c) => row[c] ?? null));

// `touched` (optional) collects the workspaces that can see a changed row, for the live-refresh poke.
export async function push(db: Db, user: User, input: unknown[], touched?: Set<string>): Promise<PushResult> {
  const rows = input.slice(0, MAX_PUSH);
  const overflow = input.slice(MAX_PUSH);
  const run = db.transactionAsync(async (tx: Tx) => {
    let seq = Number((await tx.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value);
    const result: PushResult = { accepted: [], rejected: [], server: [] };
    const sent = new Map<string, PushRow>();
    const moved = new Set<string>(); // workspaces whose visibility changed
    const perms = await loadPerms(tx);
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
      const reason = await denyReason(tx, user, perms, tbl, row);
      if (reason) { result.rejected.push({ id, tbl, reason }); continue; }
      if (TABLES[tbl].columns.includes('code')) row.code = null; // the server owns codes
      row.server_seq = seq + 1;
      const before = tbl === 'files' ? await tx.get('SELECT workspace_id FROM files WHERE id = ?', row.id)
        : tbl === 'bugs' ? await tx.get('SELECT f.workspace_id FROM bugs b JOIN files f ON f.id = b.file_id WHERE b.id = ?', row.id) : null;
      const r = await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
      if (r.changes > 0) {
        seq += 1;
        if (before) {
          const after = tbl === 'files' ? await tx.get('SELECT workspace_id FROM files WHERE id = ?', row.id)
            : await tx.get('SELECT f.workspace_id FROM bugs b JOIN files f ON f.id = b.file_id WHERE b.id = ?', row.id);
          if (after && after.workspace_id !== before.workspace_id) moved.add(before.workspace_id).add(after.workspace_id);
        }
        if (tbl === 'file_shares') {
          const sh = await tx.get('SELECT s.workspace_id, f.workspace_id AS owner FROM file_shares s LEFT JOIN files f ON f.id = s.file_id WHERE s.id = ?', row.id);
          for (const w of [sh.workspace_id, sh.owner]) if (w) moved.add(w);
        }
      }
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
         WHERE f.workspace_id = ? AND b.code IS NOT NULL`, // tombstoned codes count: a revived bug keeps its code
        p.workspace_id,
      );
      seq += 1;
      await tx.run('UPDATE bugs SET code = ?, server_seq = ? WHERE id = ? AND code IS NULL',
        nextInScope('BUG', codes.map((c) => c.code)), seq, p.id);
    }

    await tx.run("UPDATE sync_meta SET value = ? WHERE key = 'seq'", seq);
    if (touched) {
      for (const [, s] of sent) {
        const fid = s.tbl === 'files' ? s.row.id : s.tbl === 'bug_events' ? (await tx.get('SELECT file_id FROM bugs WHERE id = ?', s.row.bug_id))?.file_id : s.row.file_id;
        if (s.tbl === 'activity_log' && typeof s.row.workspace_id === 'string') touched.add(s.row.workspace_id);
        if (typeof fid !== 'string') continue;
        const f = await tx.get('SELECT workspace_id FROM files WHERE id = ?', fid);
        if (f?.workspace_id) touched.add(f.workspace_id);
        for (const sh of await tx.all('SELECT workspace_id FROM file_shares WHERE file_id = ? AND deleted_at IS NULL', fid)) touched.add(sh.workspace_id);
      }
      for (const w of moved) touched.add(w);
    }
    if (moved.size) {
      for (const u of await tx.all('SELECT id, workspace_ids FROM users')) {
        const ws: string[] = JSON.parse(u.workspace_ids || '[]');
        if (ws.some((w) => moved.has(w))) await bumpAccess(tx, u.id);
      }
    }

    for (const [, s] of sent) {
      const f = visibilityFilter(s.tbl, user);
      const current = await tx.get(`SELECT * FROM ${s.tbl} WHERE id = ? AND (${f.sql})`, s.row.id, ...f.params);
      if (current && comparable(s.tbl, current) !== comparable(s.tbl, s.row)) result.server.push({ tbl: s.tbl, row: current });
    }
    return result;
  });
  return run();
}

// Bump whenever the user's visibility can change; their next pull resets.
export async function bumpAccess(db: Tx, userId: string): Promise<number> {
  await db.run('UPDATE users SET access_version = COALESCE(access_version, 0) + 1 WHERE id = ?', userId);
  return Number((await db.get('SELECT access_version FROM users WHERE id = ?', userId))?.access_version ?? 0);
}

export async function pull(db: Db, user: User, since: number, av: number, sv: number, limit = MAX_PULL): Promise<PullResult> {
  const u = await db.get('SELECT access_version FROM users WHERE id = ?', user.id);
  // A missing row would silently skip resets, so fail loudly.
  if (!u) throw new Error(`pull: no users row for ${user.id}`);
  const cur = Number(u.access_version ?? 0);
  const schema = Number((await db.get("SELECT value FROM sync_meta WHERE key = 'schema_version'"))?.value ?? 0);
  if (av !== cur || sv < schema) return { reset: true, av: cur, sv: schema };
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
