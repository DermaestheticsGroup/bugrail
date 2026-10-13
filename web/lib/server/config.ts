import type { Db } from '../db-types';
import { DEFAULT_ROLES, DEFAULT_ROLE_PERMISSIONS, can, type RolePermissions } from '../domain/auth';
import type { User } from '../sync/users';

export interface ClientConfig {
  me: User;
  workspaces: { id: string; name: string }[];
  users: { id: string; email: string; name: string; role: string; workspaceIds: string[] }[];
  roles: { value: string; label: string }[];
  rolePermissions: RolePermissions;
}

const secret = async (db: Db, key: string) => (await db.get('SELECT value FROM secrets WHERE key = ?', key))?.value as string | undefined;
const json = <T,>(text: string | undefined, fallback: T): T => { try { return text ? JSON.parse(text) : fallback; } catch { return fallback; } };

// Everything the browser needs to draw the shell (nav, workspace picker, assignee lists) that is not a synced table.
// Filtered per user here, so a vendor never receives another workspace's name or members. No password hashes, versions or secrets.
export async function buildConfig(db: Db, user: User): Promise<ClientConfig> {
  const admin = user.role === 'admin';
  const roles = json(await secret(db, 'roles'), DEFAULT_ROLES);
  const saved = json<RolePermissions | null>(await secret(db, 'role_permissions'), null);
  const rolePermissions: RolePermissions = {};
  for (const r of roles) rolePermissions[r.value] = { ...(saved?.[r.value] ?? DEFAULT_ROLE_PERMISSIONS[r.value] ?? {}) };

  // Sharing a file needs the target workspace's name, so a user with that permission sees every workspace's id and name.
  const allNames = admin || can({ role: user.role }, 'testcase_fileShare', saved);
  const mine = new Set(user.workspaceIds);
  const workspaces = (await db.all('SELECT id, name FROM workspaces ORDER BY name')).filter((w) => allNames || mine.has(w.id));

  const users = (await db.all('SELECT id, email, name, role, workspace_ids FROM users ORDER BY email'))
    .map((u) => ({ id: u.id as string, email: u.email as string, name: (u.name ?? '') as string, role: u.role as string, workspaceIds: JSON.parse(u.workspace_ids || '[]') as string[] }))
    .filter((u) => admin || u.id === user.id || u.workspaceIds.some((w) => mine.has(w)))
    .map((u) => (admin ? u : { ...u, workspaceIds: u.workspaceIds.filter((w) => mine.has(w)) }));

  return { me: user, workspaces, users, roles, rolePermissions };
}
