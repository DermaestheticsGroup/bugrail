// Legacy kv_store blobs <-> server.db rows. Pure: no Mongo, no filesystem. The CLIs in scripts/ do the I/O.
import { createHash } from 'node:crypto';
import { TABLES, type SyncedTable } from '../../db/tables';
import { DEFAULT_ROLES, DEFAULT_ROLE_PERMISSIONS } from '../domain/auth';
import type { Db, Row, Tx } from '../db-types';

export type Rec = Record<string, any>;
export interface KvBlobs { qa_files?: Rec[]; qa_testcases?: Rec[]; qa_bugs?: Rec[]; qa_settings?: Rec; qa_activity_log?: Rec[]; [k: string]: unknown }

// A dump is either the GET /api/kv body or a mongoexport of kv_store ([{ _id, value }]).
export function blobsFromJson(text: string): KvBlobs {
  const j = JSON.parse(text);
  if (Array.isArray(j)) return Object.fromEntries(j.map((d: { _id: string; value: unknown }) => [d._id, d.value]));
  const { _revs, ...rest } = j;
  void _revs;
  return rest;
}

export const DEFAULT_FILE_ID = 'FILE-DEFAULT';
export const INTERNAL_WS_ID = 'ws-internal';
export const MIGRATE_DEVICE = 'migrate';
// Mirrors BugReportModule.DEFAULT_STATUS_MASTER, used when settings carry no master list.
export const DEFAULT_STATUS_MASTER = [
  { code: 'OPEN', name: 'Open', color: '#2563EB', order: 1 },
  { code: 'IN_PROGRESS', name: 'In Progress', color: '#F59E0B', order: 2 },
  { code: 'RETEST', name: 'Retest', color: '#06B6D4', order: 3 },
  { code: 'RESOLVED', name: 'Resolved', color: '#22C55E', order: 4 },
  { code: 'CLOSED', name: 'Closed', color: '#6B7280', order: 5 },
  { code: 'REJECTED', name: 'Rejected', color: '#EF4444', order: 6 },
];

// Order matters: it is the server_seq order.
export const TABLE_ORDER: SyncedTable[] = ['files', 'file_shares', 'bug_status_master', 'custom_field_defs', 'testcases', 'bugs', 'bug_events', 'activity_log'];

const FILE_KEYS: Record<string, string> = { id: 'id', name: 'name', workspaceId: 'workspace_id', createdBy: 'created_by', createdAt: 'created_at' };
const TC_KEYS: Record<string, string> = {
  id: 'id', code: 'code', fileId: 'file_id', module: 'module', roleUser: 'role_user', scenario: 'scenario', testCase: 'test_case',
  preconditions: 'preconditions', steps: 'steps', testData: 'test_data', expectedResult: 'expected_result', typeTest: 'type_test',
  status: 'status', actualResult: 'actual_result', evidence: 'evidence', executionDate: 'execution_date', customFields: 'custom_fields',
  createdBy: 'created_by', createdAt: 'created_at',
};
const BUG_KEYS: Record<string, string> = {
  id: 'id', code: 'code', fileId: 'file_id', testCaseId: 'test_case_id', title: 'title', module: 'module', severity: 'severity',
  priority: 'priority', status: 'status_code', description: 'description', steps: 'steps', expectedResult: 'expected_result',
  actualResult: 'actual_result', platform: 'platform', environment: 'environment', browser: 'browser', device: 'device',
  buildVersion: 'build_version', attachments: 'attachments', tester: 'tester', assignee: 'assignee', reportDate: 'report_date',
};
const BUG_EMBEDDED = ['activity', 'comments', 'assignments'];
const EMPTY_KEY = '__emptyArrays';
const LOG_KEYS: Record<string, string> = { id: 'id', ts: 'ts', actorEmail: 'actor_email', actorRole: 'actor_role', workspaceId: 'workspace_id', action: 'action', label: 'label' };

// Columns that hold JSON text (the legacy value is an object).
const JSON_COLS = new Set(['custom_fields']);
const invert = (m: Record<string, string>) => Object.fromEntries(Object.entries(m).map(([k, v]) => [v, k]));

export interface Report {
  counts: Record<string, number>;
  duplicateCodes: { table: string; scope: string; code: string; ids: string[] }[];
  movedToInternal: string[];
  internalWorkspaceCreated: boolean;
  usersHashed: number;
  usersWithoutPassword: string[];
  unknownStatusesAdded: { code: string; name: string }[];
  orphansToDefaultFile: { testcases: number; bugs: number };
  droppedKeys: string[];
  warnings: string[];
}

export interface Migrated {
  tables: Record<SyncedTable, Row[]>;
  users: Row[];
  workspaces: Row[];
  secrets: Record<string, string>;
  report: Report;
}

export interface TransformOpts {
  now?: number;
  hash: (plain: string) => Promise<string>;
}

// masterstatus.js generateCode: the code is the name upper-cased, non-alphanumerics to "_", de-duplicated with _2, _3.
export function statusCodeFromName(name: string, taken: Set<string>): string {
  const base = name.trim().toUpperCase().replace(/[^A-Z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'STATUS';
  let code = base, n = 2;
  while (taken.has(code)) code = `${base}_${n++}`;
  return code;
}

const str = (v: unknown) => (typeof v === 'string' ? v : null);
const pad = (i: number) => String(i).padStart(5, '0');
const emailId = (email: string) => `usr-${createHash('sha1').update(email.trim().toLowerCase()).digest('hex').slice(0, 12)}`;
const isObj = (v: unknown): v is Rec => !!v && typeof v === 'object' && !Array.isArray(v);

// Split a legacy record into mapped columns and `extra`. A known field whose value is not a string (or JSON column object)
// moves to extra under its legacy name, so no value is coerced and nothing is lost.
function mapRecord(rec: Rec, keys: Record<string, string>, skip: string[] = []): { cols: Row; extra: Rec } {
  const cols: Row = {};
  const extra: Rec = {};
  for (const [k, v] of Object.entries(rec)) {
    if (skip.includes(k)) continue;
    const col = keys[k];
    if (!col) { extra[k] = v; continue; }
    if (v === null || v === undefined) { cols[col] = null; continue; }
    if (JSON_COLS.has(col)) { if (isObj(v)) cols[col] = JSON.stringify(v); else { extra[k] = v; cols[col] = null; } continue; }
    if (typeof v === 'string') cols[col] = v;
    else { extra[k] = v; cols[col] = null; }
  }
  return { cols, extra };
}
const extraText = (e: Rec) => (Object.keys(e).length ? JSON.stringify(e) : null);

export async function transformKv(blobs: KvBlobs, opts: TransformOpts): Promise<Migrated> {
  const hlc = `${String(opts.now ?? Date.now()).padStart(15, '0')}-00000-${MIGRATE_DEVICE}`;
  const settings: Rec = isObj(blobs.qa_settings) ? blobs.qa_settings : {};
  const files = (blobs.qa_files ?? []).map((f) => ({ ...f }));
  const testcases = (blobs.qa_testcases ?? []).map((t) => ({ ...t }));
  const bugs = (blobs.qa_bugs ?? []).map((b) => ({ ...b }));
  const log = blobs.qa_activity_log ?? [];
  const report: Report = {
    counts: {}, duplicateCodes: [], movedToInternal: [], internalWorkspaceCreated: false, usersHashed: 0, usersWithoutPassword: [],
    unknownStatusesAdded: [], orphansToDefaultFile: { testcases: 0, bugs: 0 }, droppedKeys: [], warnings: [],
  };
  const tables = Object.fromEntries(TABLE_ORDER.map((t) => [t, [] as Row[]])) as Record<SyncedTable, Row[]>;
  const stamp = (cols: Row): Row => ({ ...cols, hlc, deleted_at: null, updated_by: MIGRATE_DEVICE });

  // Workspaces, and the Internal workspace for files that had none (they were visible to everyone).
  const workspaces: Row[] = (Array.isArray(settings.workspaces) ? settings.workspaces : []).map((w: Rec) => ({
    id: String(w.id), name: String(w.name ?? w.id), created_at: str(w.createdAt),
  }));
  for (const w of (settings.workspaces ?? []) as Rec[]) for (const k of Object.keys(w)) if (!['id', 'name', 'createdAt'].includes(k)) report.droppedKeys.push(`workspaces.${k}`);

  // Orphans first: both lists get FILE-DEFAULT, as ensureDefaultFile does.
  const needsDefault = testcases.some((t) => !t.fileId) || bugs.some((b) => !b.fileId);
  if (needsDefault && !files.some((f) => f.id === DEFAULT_FILE_ID)) files.unshift({ id: DEFAULT_FILE_ID, name: 'Default' });
  for (const t of testcases) if (!t.fileId) { t.fileId = DEFAULT_FILE_ID; report.orphansToDefaultFile.testcases++; }
  for (const b of bugs) if (!b.fileId) { b.fileId = DEFAULT_FILE_ID; report.orphansToDefaultFile.bugs++; }

  const homeless = files.filter((f) => !f.workspaceId);
  let internalId = INTERNAL_WS_ID;
  if (homeless.length) {
    const existing = workspaces.find((w) => w.name === 'Internal');
    if (existing) internalId = String(existing.id);
    else { workspaces.push({ id: internalId, name: 'Internal', created_at: null }); report.internalWorkspaceCreated = true; }
    for (const f of homeless) { f.workspaceId = internalId; report.movedToInternal.push(String(f.id)); }
  }

  // Status master: legacy list or the defaults, plus any status name used by a bug or its history that the list lacks.
  const master: { code: string; name: string; color: string | null; order: number }[] =
    (Array.isArray(settings.bugStatusMaster) && settings.bugStatusMaster.length ? settings.bugStatusMaster : DEFAULT_STATUS_MASTER)
      .map((s: Rec, i: number) => ({ code: String(s.code), name: String(s.name ?? s.code), color: str(s.color), order: Number(s.order ?? i + 1) }));
  const byName = new Map(master.map((s) => [s.name, s.code]));
  const taken = new Set(master.map((s) => s.code));
  const codeOf = (name: unknown): string | null => {
    if (typeof name !== 'string' || !name) return null;
    let code = byName.get(name);
    if (!code) {
      code = statusCodeFromName(name, taken);
      taken.add(code);
      byName.set(name, code);
      master.push({ code, name, color: null, order: master.length + 1 });
      report.unknownStatusesAdded.push({ code, name });
    }
    return code;
  };

  // files + file_shares
  for (const f of files) {
    const { cols, extra } = mapRecord(f, FILE_KEYS, ['sharedWith']);
    tables.files.push(stamp({ ...cols, id: String(f.id) }));
    if (Object.keys(extra).length) report.droppedKeys.push(...Object.keys(extra).map((k) => `files.${k}`)); // no extra column on files
    for (const ws of Array.isArray(f.sharedWith) ? f.sharedWith : []) {
      tables.file_shares.push(stamp({ id: `${f.id}:${ws}`, file_id: String(f.id), workspace_id: String(ws) }));
    }
  }
  // bug_status_master + custom_field_defs (the master is filled after bugs, once unknown names are known)
  const defs: Rec[] = Array.isArray(settings.customFieldDefs) ? settings.customFieldDefs : [];
  defs.forEach((d, i) => tables.custom_field_defs.push(stamp({ id: `cf-${pad(i + 1)}`, label: str(d?.label) ?? String(d?.label ?? '') })));

  for (const t of testcases) {
    const rec = { ...t, status: t.status === 'Not Run' ? 'Open' : t.status };
    const { cols, extra } = mapRecord(rec, TC_KEYS);
    tables.testcases.push(stamp({ ...cols, id: String(t.id), status_hlc: hlc, extra: extraText(extra) }));
  }

  bugs.forEach((b) => {
    const rec = { ...b, priority: b.priority === 'Highest' || b.priority === 'Critical' ? 'Urgent' : b.priority };
    const { cols, extra } = mapRecord(rec, BUG_KEYS, BUG_EMBEDDED);
    // An empty array is not the same as a missing key; remember which were present so the export can put them back.
    const emptied = BUG_EMBEDDED.filter((k) => Array.isArray(b[k]) && b[k].length === 0);
    if (emptied.length) extra[EMPTY_KEY] = emptied;
    cols.status_code = codeOf(b.status);
    if (typeof b.status !== 'string' && b.status != null) extra.status = b.status;
    tables.bugs.push(stamp({ ...cols, id: String(b.id), status_hlc: hlc, extra: extraText(extra) }));
    const ev = (kind: string, list: unknown, f: (e: Rec, i: number) => Row) => {
      if (!Array.isArray(list)) return;
      list.forEach((e, i) => {
        if (!isObj(e)) { report.warnings.push(`bug ${b.id}: ${kind} entry ${i} is not an object, skipped`); return; }
        tables.bug_events.push({ id: `${b.id}:${kind[0]}:${pad(i)}`, bug_id: String(b.id), kind, ...f(e, i) });
      });
    };
    ev('status', b.activity, (e) => ({ at: str(e.at), email: str(e.email), from_status: codeOf(e.from), to_status: codeOf(e.to), note: str(e.note), attachment: str(e.attachment) }));
    ev('comment', b.comments, (e) => ({ at: str(e.at), email: str(e.email), text: str(e.text) }));
    ev('assignment', b.assignments, (e) => ({ at: str(e.at), assignee: str(e.to), email: str(e.by) }));
  });

  master.forEach((s) => tables.bug_status_master.push(stamp({ id: s.code, name: s.name, color: s.color, sort_order: s.order })));

  log.forEach((l, i) => {
    const { cols } = mapRecord(l, LOG_KEYS);
    tables.activity_log.push({ ...cols, id: str(l.id) ?? `log-${pad(i + 1)}` });
  });

  // Duplicate codes per scope (owning workspace), reported and kept.
  const wsOfFile = new Map(files.map((f) => [String(f.id), String(f.workspaceId)]));
  for (const [table, rows] of [['bugs', tables.bugs], ['testcases', tables.testcases]] as const) {
    const seen = new Map<string, string[]>();
    for (const r of rows) {
      if (!r.code) continue;
      const k = `${wsOfFile.get(String(r.file_id)) ?? '?'}\u0000${r.code}`;
      seen.set(k, [...(seen.get(k) ?? []), String(r.id)]);
    }
    for (const [k, ids] of seen) if (ids.length > 1) { const [scope, code] = k.split('\u0000'); report.duplicateCodes.push({ table, scope, code, ids }); }
  }

  // Users: hash plaintext passwords; legacy single workspaceId becomes workspaceIds; non-vendors join Internal.
  const users: Row[] = [];
  const internalUsers: string[] = [];
  for (const u of Array.isArray(settings.users) ? settings.users : []) {
    const email = String(u.email ?? '').trim().toLowerCase();
    const ws: string[] = Array.isArray(u.workspaceIds) ? u.workspaceIds.map(String) : u.workspaceId ? [String(u.workspaceId)] : [];
    const id = emailId(email);
    if (homeless.length && u.role !== 'qa_vendor' && u.role !== 'admin' && !ws.includes(internalId)) { ws.push(internalId); internalUsers.push(id); }
    let password_hash: string | null = null;
    if (typeof u.password === 'string' && u.password) { password_hash = await opts.hash(u.password); report.usersHashed++; }
    else report.usersWithoutPassword.push(email);
    for (const k of Object.keys(u)) if (!['email', 'password', 'role', 'workspaceIds', 'workspaceId', 'name'].includes(k)) report.droppedKeys.push(`users.${k}`);
    users.push({ id, email, name: str(u.name) ?? '', role: str(u.role), workspace_ids: JSON.stringify(ws), password_hash, session_version: 0, access_version: 0, created_at: str(u.createdAt) });
  }

  // Secrets: Gemini key, the role list and the permission matrix (merged with defaults like ensureRolePermissions), migration notes.
  const secrets: Record<string, string> = {};
  if (typeof settings.geminiApiKey === 'string' && settings.geminiApiKey.trim()) secrets.gemini_api_key = settings.geminiApiKey.trim();
  if (Array.isArray(settings.roles)) secrets.roles = JSON.stringify(settings.roles);
  if (isObj(settings.rolePermissions)) {
    const roleList: Rec[] = Array.isArray(settings.roles) ? settings.roles : DEFAULT_ROLES;
    const merged: Rec = {};
    for (const r of roleList) merged[r.value] = { ...((DEFAULT_ROLE_PERMISSIONS as Rec)[r.value] ?? {}), ...(settings.rolePermissions[r.value] ?? {}) };
    for (const [role, map] of Object.entries(settings.rolePermissions)) if (!(role in merged)) merged[role] = map;
    secrets.role_permissions = JSON.stringify(merged);
  }
  secrets.migration = JSON.stringify({
    at: opts.now ?? Date.now(), internalWorkspaceId: homeless.length ? internalId : null, createdInternal: report.internalWorkspaceCreated,
    internalUsers, movedFiles: report.movedToInternal, orphanFiles: needsDefault ? [DEFAULT_FILE_ID] : [],
  });
  if ('theme' in settings) report.warnings.push('settings.theme dropped (becomes a per-browser setting)');
  for (const k of Object.keys(settings)) if (!['users', 'workspaces', 'roles', 'rolePermissions', 'bugStatusMaster', 'customFieldDefs', 'geminiApiKey', 'theme'].includes(k)) report.droppedKeys.push(`settings.${k}`);
  for (const k of ['qa_counters', 'qa_trash']) if (k in blobs) report.warnings.push(`${k} not migrated (legacy)`);

  let seq = 0;
  for (const t of TABLE_ORDER) for (const r of tables[t]) r.server_seq = ++seq;
  for (const t of TABLE_ORDER) report.counts[t] = tables[t].length;
  report.counts.users = users.length;
  report.counts.workspaces = workspaces.length;
  return { tables, users, workspaces, secrets, report };
}

const insert = (table: string, cols: string[]) => `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;

// Writes into an empty, migrated server.db in one transaction. Refuses a database that already holds data.
export async function writeServerDb(db: Db, m: Migrated): Promise<void> {
  const run = db.transactionAsync(async (tx: Tx) => {
    for (const t of [...TABLE_ORDER, 'users', 'workspaces']) {
      if ((await tx.get(`SELECT 1 AS x FROM ${t} LIMIT 1`))) throw new Error(`refusing to migrate into a non-empty database (${t} has rows)`);
    }
    let seq = 0;
    for (const t of TABLE_ORDER) {
      for (const r of m.tables[t]) {
        const cols = TABLES[t].columns;
        await tx.run(insert(t, cols), ...cols.map((c) => r[c] ?? null));
        seq = Math.max(seq, Number(r.server_seq));
      }
    }
    const ucols = ['id', 'email', 'name', 'role', 'workspace_ids', 'password_hash', 'session_version', 'access_version', 'created_at'];
    for (const u of m.users) await tx.run(insert('users', ucols), ...ucols.map((c) => u[c] ?? null));
    for (const w of m.workspaces) await tx.run(insert('workspaces', ['id', 'name', 'created_at']), w.id, w.name, w.created_at ?? null);
    for (const [k, v] of Object.entries(m.secrets)) await tx.run('INSERT INTO secrets (key, value) VALUES (?, ?)', k, v);
    await tx.run("UPDATE sync_meta SET value = ? WHERE key = 'seq'", seq);
  });
  await run();
}

export interface ExportOpts {
  // The untouched legacy qa_settings (still in kv_store until Mongo is retired): old plaintext passwords come from here.
  originalSettings?: Rec | null;
  tempPassword?: () => string;
}
export interface Exported { blobs: Required<Pick<KvBlobs, 'qa_files' | 'qa_testcases' | 'qa_bugs' | 'qa_settings' | 'qa_activity_log'>>; tempPasswords: Record<string, string> }

const fromCols = (row: Row, keys: Record<string, string>, extra: Rec): Rec => {
  const out: Rec = {};
  const rev = invert(keys);
  for (const [col, key] of Object.entries(rev)) {
    const v = row[col];
    if (v === null || v === undefined) continue;
    out[key] = JSON_COLS.has(col) && typeof v === 'string' ? JSON.parse(v) : v;
  }
  return { ...out, ...extra };
};
const parseExtra = (v: unknown): Rec => { try { return v ? JSON.parse(String(v)) : {}; } catch { return {}; } };

export async function exportKv(db: Db, opts: ExportOpts = {}): Promise<Exported> {
  const note: Rec = parseExtra((await db.get("SELECT value FROM secrets WHERE key = 'migration'"))?.value);
  const live = (t: string, order = 'rowid') => db.all(`SELECT * FROM ${t} WHERE deleted_at IS NULL ORDER BY ${order}`);
  const master = await db.all('SELECT * FROM bug_status_master WHERE deleted_at IS NULL ORDER BY sort_order, rowid');
  const nameOf = new Map(master.map((s) => [s.id, s.name]));
  const toName = (c: unknown) => (typeof c === 'string' ? nameOf.get(c) ?? c : c);

  const shares = await live('file_shares');
  const internal = note.internalWorkspaceId as string | null;
  const moved = new Set<string>(note.movedFiles ?? []);
  const qa_files = (await live('files')).map((f) => {
    const rec = fromCols(f, FILE_KEYS, {});
    // Files moved into Internal go back to having no workspace (visible to everyone, as before).
    if (internal && moved.has(f.id)) delete rec.workspaceId;
    const sw = shares.filter((s) => s.file_id === f.id).map((s) => s.workspace_id);
    if (sw.length) rec.sharedWith = sw;
    return rec;
  });
  const orphan = new Set<string>(note.orphanFiles ?? []);
  // Files created only to hold orphans stay: the old app recreates FILE-DEFAULT itself, and the rows still point at it.
  void orphan;

  const qa_testcases = (await live('testcases')).map((t) => fromCols(t, TC_KEYS, parseExtra(t.extra)));
  const events = await db.all('SELECT * FROM bug_events ORDER BY id');
  const qa_bugs = (await live('bugs')).map((b) => {
    const extra = parseExtra(b.extra);
    const emptied: string[] = extra[EMPTY_KEY] ?? [];
    delete extra[EMPTY_KEY];
    const rec = fromCols({ ...b, status_code: null }, BUG_KEYS, extra);
    const name = toName(b.status_code);
    if (name !== null && name !== undefined && !('status' in rec)) rec.status = name;
    const mine = events.filter((e) => e.bug_id === b.id);
    const pick = (kind: string, f: (e: Row) => Rec) => { const l = mine.filter((e) => e.kind === kind).map(f); return l.length ? l : undefined; };
    const activity = pick('status', (e) => clean({ at: e.at, from: toName(e.from_status), to: toName(e.to_status), note: e.note, attachment: e.attachment, email: e.email }));
    const comments = pick('comment', (e) => clean({ at: e.at, email: e.email, text: e.text }));
    const assignments = pick('assignment', (e) => clean({ at: e.at, to: e.assignee, by: e.email }));
    const back = Object.fromEntries(emptied.map((k) => [k, [] as Rec[]]));
    return { ...rec, ...back, ...(activity && { activity }), ...(comments && { comments }), ...(assignments && { assignments }) };
  });
  const qa_activity_log = (await db.all('SELECT * FROM activity_log ORDER BY server_seq')).map((l) => fromCols(l, LOG_KEYS, {}));

  const tempPasswords: Record<string, string> = {};
  const orig = (opts.originalSettings?.users ?? []) as Rec[];
  const origByEmail = new Map(orig.map((u) => [String(u.email ?? '').trim().toLowerCase(), u]));
  const mkTemp = opts.tempPassword ?? (() => Math.random().toString(36).slice(2, 10) + Math.random().toString(36).slice(2, 6));
  const users = (await db.all('SELECT * FROM users ORDER BY rowid')).map((u) => {
    const ws: string[] = JSON.parse(u.workspace_ids || '[]').filter((w: string) => !(note.internalUsers ?? []).includes(u.id) || w !== internal);
    const old = origByEmail.get(u.email);
    let password = old?.password;
    if (typeof password !== 'string') { password = mkTemp(); tempPasswords[u.email] = password; }
    return clean({ email: u.email, password, role: u.role, name: u.name || undefined, workspaceIds: ws });
  });
  let workspaces = (await db.all('SELECT * FROM workspaces ORDER BY rowid')).map((w) => clean({ id: w.id, name: w.name, createdAt: w.created_at }));
  if (note.createdInternal && internal) workspaces = workspaces.filter((w) => w.id !== internal);

  const secret = async (k: string) => (await db.get('SELECT value FROM secrets WHERE key = ?', k))?.value as string | undefined;
  const qa_settings: Rec = { users, workspaces };
  const roles = await secret('roles');
  if (roles) qa_settings.roles = JSON.parse(roles);
  const perms = await secret('role_permissions');
  if (perms) qa_settings.rolePermissions = JSON.parse(perms);
  qa_settings.bugStatusMaster = master.map((s) => clean({ code: s.id, name: s.name, color: s.color, order: s.sort_order }));
  const defs = (await live('custom_field_defs', 'id')).map((d) => ({ label: d.label }));
  if (defs.length) qa_settings.customFieldDefs = defs;
  const gem = await secret('gemini_api_key');
  if (gem) qa_settings.geminiApiKey = gem;
  if (opts.originalSettings && 'theme' in opts.originalSettings) qa_settings.theme = opts.originalSettings.theme;
  return { blobs: { qa_files, qa_testcases, qa_bugs, qa_settings, qa_activity_log }, tempPasswords };
}

function clean(o: Rec): Rec {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));
}

// Deep compare of two kv blob sets. null and a missing key count as equal. `ignore` lists dotted paths that may differ.
export interface Diff { path: string; a: unknown; b: unknown }
export function diffKv(a: KvBlobs, b: KvBlobs, ignorePaths: RegExp[] = []): Diff[] {
  const out: Diff[] = [];
  const walk = (x: any, y: any, path: string) => {
    if (ignorePaths.some((re) => re.test(path))) return;
    const nx = x === null ? undefined : x, ny = y === null ? undefined : y;
    if (Array.isArray(nx) && Array.isArray(ny)) {
      if (nx.length !== ny.length) { out.push({ path: `${path}.length`, a: nx.length, b: ny.length }); return; }
      nx.forEach((v, i) => walk(v, ny[i], `${path}[${i}]`));
      return;
    }
    if (isObj(nx) && isObj(ny)) {
      for (const k of new Set([...Object.keys(nx), ...Object.keys(ny)])) walk(nx[k], ny[k], `${path}.${k}`);
      return;
    }
    if (nx !== ny) out.push({ path, a: nx, b: ny });
  };
  for (const k of ['qa_files', 'qa_testcases', 'qa_bugs', 'qa_settings', 'qa_activity_log'] as const) walk(a[k], b[k], k);
  return out;
}
