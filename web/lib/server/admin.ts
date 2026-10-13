import type { Db } from '../db-types';
import { DEFAULT_ROLES, PERMISSION_KEYS, isValidEmail, normalizeEmail, type RolePermissions } from '../domain/auth';
import { IdGen } from '../domain/ids';
import { hashPassword } from './password';
import { bumpAccess } from '../sync/server';

export type AdminResult<T = object> = ({ ok: true } & T) | { ok: false; status: 400 | 404 | 409; error: string };
const bad = (error: string, status: 400 | 404 | 409 = 400) => ({ ok: false as const, status, error });

const ROLE_VALUES = new Set(['admin', ...DEFAULT_ROLES.map((r) => r.value)]);
const MIN_PASSWORD = 8;
const isUnique = (e: unknown) => /UNIQUE constraint/i.test(String((e as Error)?.message));
// Every entry must be a string: silently dropping a bad one would save a different assignment than requested.
const parseWorkspaceIds = (v: unknown): string[] | null =>
  v === undefined ? [] : Array.isArray(v) && v.every((x) => typeof x === 'string') ? (v as string[]) : null;

async function workspacesExist(db: Pick<Db, 'get'>, ids: string[]): Promise<boolean> {
  for (const id of ids) if (!(await db.get('SELECT 1 FROM workspaces WHERE id = ?', id))) return false;
  return true;
}
const otherAdmins = async (db: Pick<Db, 'get'>, exceptId: string) =>
  Number((await db.get("SELECT count(*) AS n FROM users WHERE role = 'admin' AND id != ?", exceptId)).n);

export async function listUsers(db: Db) {
  const rows = await db.all('SELECT id, email, name, role, workspace_ids, created_at FROM users ORDER BY email');
  return rows.map((r) => ({ ...r, workspace_ids: JSON.parse(r.workspace_ids || '[]') }));
}

export interface NewUser { email?: unknown; name?: unknown; role?: unknown; workspaceIds?: unknown; password?: unknown }

export async function createUser(db: Db, u: NewUser): Promise<AdminResult<{ id: string }>> {
  if (!isValidEmail(u.email)) return bad('invalid email');
  if (typeof u.role !== 'string' || !ROLE_VALUES.has(u.role)) return bad('invalid role');
  if (typeof u.password !== 'string' || u.password.length < MIN_PASSWORD) return bad(`password needs ${MIN_PASSWORD}+ characters`);
  const ws = parseWorkspaceIds(u.workspaceIds);
  if (!ws || !(await workspacesExist(db, ws))) return bad('unknown workspace');
  const email = normalizeEmail(u.email);
  if (await db.get('SELECT 1 FROM users WHERE lower(email) = ?', email)) return bad('email already used', 409);
  const id = IdGen.uid('usr');
  const hash = await hashPassword(u.password);
  try {
    await db.run(
      'INSERT INTO users (id, email, name, role, workspace_ids, password_hash, session_version, access_version, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?)',
      id, email, typeof u.name === 'string' ? u.name : '', u.role, JSON.stringify(ws), hash, new Date().toISOString(),
    );
  } catch (e) {
    if (isUnique(e)) return bad('email already used', 409);
    throw e;
  }
  return { ok: true, id };
}

export async function updateUser(db: Db, id: string, patch: NewUser): Promise<AdminResult> {
  const run = db.transactionAsync(async (tx) => {
    const cur = await tx.get('SELECT role FROM users WHERE id = ?', id);
    if (!cur) return bad('no such user', 404);
    // Validate everything before writing: a refusal must leave the row untouched.
    if (patch.role !== undefined) {
      if (typeof patch.role !== 'string' || !ROLE_VALUES.has(patch.role)) return bad('invalid role');
      if (cur.role === 'admin' && patch.role !== 'admin' && (await otherAdmins(tx, id)) === 0) return bad('cannot demote the last admin', 409);
    }
    const ws = patch.workspaceIds === undefined ? undefined : parseWorkspaceIds(patch.workspaceIds);
    if (ws === null || (ws && !(await workspacesExist(tx, ws)))) return bad('unknown workspace');
    if (patch.password !== undefined && (typeof patch.password !== 'string' || patch.password.length < MIN_PASSWORD)) return bad(`password needs ${MIN_PASSWORD}+ characters`);

    if (patch.role !== undefined) { await tx.run('UPDATE users SET role = ? WHERE id = ?', patch.role, id); await bumpAccess(tx, id); }
    if (ws) { await tx.run('UPDATE users SET workspace_ids = ? WHERE id = ?', JSON.stringify(ws), id); await bumpAccess(tx, id); }
    if (typeof patch.name === 'string') await tx.run('UPDATE users SET name = ? WHERE id = ?', patch.name, id);
    if (typeof patch.password === 'string') {
      // New hash and a new session_version: every existing cookie stops working.
      await tx.run('UPDATE users SET password_hash = ?, session_version = COALESCE(session_version, 0) + 1 WHERE id = ?', await hashPassword(patch.password), id);
    }
    return { ok: true as const };
  });
  return run();
}

export async function deleteUser(db: Db, id: string): Promise<AdminResult> {
  // Lookup, last-admin check and delete in one transaction, so two admins deleting each other cannot both pass the check.
  const run = db.transactionAsync(async (tx) => {
    const cur = await tx.get('SELECT role FROM users WHERE id = ?', id);
    if (!cur) return bad('no such user', 404);
    if (cur.role === 'admin' && (await otherAdmins(tx, id)) === 0) return bad('cannot delete the last admin', 409);
    await tx.run('DELETE FROM users WHERE id = ?', id); // a deleted row ends its sessions (userFromSession finds no user)
    return { ok: true as const };
  });
  return run();
}

export async function getPermissions(db: Db): Promise<RolePermissions | null> {
  const r = await db.get("SELECT value FROM secrets WHERE key = 'role_permissions'");
  try { return r?.value ? JSON.parse(r.value) : null; } catch { return null; }
}

export async function savePermissions(db: Db, perms: unknown): Promise<AdminResult> {
  if (!perms || typeof perms !== 'object' || Array.isArray(perms)) return bad('invalid permissions');
  const keys = new Set(PERMISSION_KEYS.map((k) => k.key));
  const clean: RolePermissions = {};
  for (const [role, map] of Object.entries(perms as Record<string, unknown>)) {
    // Admin is hardcoded full-access, so a saved admin row is refused to avoid implying otherwise.
    if (role === 'admin' || !ROLE_VALUES.has(role) || !map || typeof map !== 'object') return bad(`invalid role: ${role}`);
    clean[role] = {};
    for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
      if (!keys.has(k) || typeof v !== 'boolean') return bad(`invalid permission: ${k}`);
      clean[role][k] = v;
    }
  }
  await db.run("INSERT INTO secrets (key, value) VALUES ('role_permissions', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", JSON.stringify(clean));
  return { ok: true };
}

export const listWorkspaces = (db: Db) => db.all('SELECT id, name FROM workspaces ORDER BY name');

export async function createWorkspace(db: Db, name: unknown): Promise<AdminResult<{ id: string }>> {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return bad('name required');
  const id = IdGen.uid('ws');
  try {
    await db.run('INSERT INTO workspaces (id, name, created_at) VALUES (?, ?, ?)', id, n, new Date().toISOString());
  } catch (e) {
    if (isUnique(e)) return bad('name already used', 409);
    throw e;
  }
  return { ok: true, id };
}

export async function renameWorkspace(db: Db, id: string, name: unknown): Promise<AdminResult> {
  const n = typeof name === 'string' ? name.trim() : '';
  if (!n) return bad('name required');
  try {
    const r = await db.run('UPDATE workspaces SET name = ? WHERE id = ?', n, id);
    return r.changes ? { ok: true } : bad('no such workspace', 404);
  } catch (e) {
    if (isUnique(e)) return bad('name already used', 409);
    throw e;
  }
}

export async function deleteWorkspace(db: Db, id: string): Promise<AdminResult> {
  if (!(await db.get('SELECT 1 FROM workspaces WHERE id = ?', id))) return bad('no such workspace', 404);
  if (await db.get('SELECT 1 FROM files WHERE workspace_id = ? AND deleted_at IS NULL', id)) return bad('workspace still has files', 409);
  if ((await db.all('SELECT workspace_ids FROM users')).some((u) => JSON.parse(u.workspace_ids || '[]').includes(id))) return bad('workspace still has users', 409);
  await db.run('DELETE FROM workspaces WHERE id = ?', id);
  return { ok: true };
}

export async function setSecret(db: Db, key: 'gemini_api_key', value: unknown): Promise<AdminResult> {
  if (typeof value !== 'string') return bad('value must be a string');
  if (!value.trim()) await db.run('DELETE FROM secrets WHERE key = ?', key);
  else await db.run('INSERT INTO secrets (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value.trim());
  return { ok: true };
}
