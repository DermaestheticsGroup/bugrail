// Ported from qa-app/js/auth.js. The permission matrix and the pure parts of Auth only;
// session state (sessionStorage) is passed in as a `Session` so this runs on server and client.
import { WorkspaceCalc } from './workspace';

export type Session = { role?: string | null; workspaceId?: string | null };
export type RolePermissions = Record<string, Record<string, boolean>>;

/* Seed roles. 'admin' is not stored here: it is a fixed, undeletable role (see can). */
export const DEFAULT_ROLES: { value: string; label: string }[] = [
  { value: 'pm_ba', label: 'PM & BA' },
  { value: 'qa_internal', label: 'QA Internal' },
  { value: 'qa_vendor', label: 'QA Vendor' },
  { value: 'user_umum', label: 'User Umum' }
];

/* Checklist rows shown on the Role Permission matrix page. */
export const PERMISSION_KEYS: { key: string; label: string }[] = [
  { key: 'dashboard', label: 'Dashboard (lihat)' },
  { key: 'summary', label: 'Summary (lihat)' },
  { key: 'report', label: 'Report Go-Live (lihat & export)' },
  { key: 'testcase_create', label: 'Test Case — Tambah' },
  { key: 'testcase_read', label: 'Test Case — Lihat' },
  { key: 'testcase_update', label: 'Test Case — Edit' },
  { key: 'testcase_delete', label: 'Test Case — Hapus' },
  { key: 'testcase_fileShare', label: 'Test Case — Share File antar Workspace' },
  { key: 'activitylog', label: 'Activity Log (lihat)' },
  { key: 'bugreport_fileCreate', label: 'Bug Report — Buat File' },
  { key: 'bugreport_create', label: 'Bug Report — Tambah' },
  { key: 'bugreport_read', label: 'Bug Report — Lihat' },
  { key: 'bugreport_update', label: 'Bug Report — Edit (semua field)' },
  { key: 'bugreport_updateStatusPriority', label: 'Bug Report — Edit Status/Priority saja' },
  { key: 'bugreport_delete', label: 'Bug Report — Hapus' },
  { key: 'bugreport_board', label: 'Bug Report — Board (drag & drop)' },
  { key: 'bugreport_statusQA', label: 'Bug Report — Status QA (hanya dari Retest ke Open/Blocked/Resolved/Closed, wajib keterangan)' },
  { key: 'master', label: 'Master — Status Bug Report' },
  { key: 'usermanagement', label: 'User Management — Daftar User' },
  { key: 'settings', label: 'Settings' }
];

/* Seed permissions per role. Admin is always full-access and never goes through this
   matrix (see can, hardcoded to avoid self-lockout). */
export const DEFAULT_ROLE_PERMISSIONS: RolePermissions = {
  pm_ba: { dashboard: true, summary: true, report: true, bugreport_read: true, bugreport_updateStatusPriority: true },
  qa_internal: { testcase_create: true, testcase_read: true, testcase_update: true, testcase_fileShare: true, bugreport_fileCreate: true, bugreport_create: true, bugreport_read: true, bugreport_update: true, bugreport_statusQA: true },
  qa_vendor: { testcase_create: true, testcase_read: true, testcase_update: true, bugreport_read: true, bugreport_update: true, bugreport_board: true, bugreport_statusQA: true },
  user_umum: { testcase_read: true, bugreport_read: true }
};

// 'user' is a legacy role value from before the permission matrix.
export const normalizeRole = (raw?: string | null): string | null | undefined => (raw === 'user' ? 'user_umum' : raw);
export const isAdmin = (s: Session): boolean => normalizeRole(s.role) === 'admin';

// Active workspace id, or null for none / admin's "Semua workspace".
export const currentWorkspaceId = (s: Session): string | null =>
  s.workspaceId && s.workspaceId !== WorkspaceCalc.ALL ? s.workspaceId : null;

/* True when nothing should be filtered by workspace: admin on "Semua workspace"
   (or an admin with no workspace chosen). */
export const seesAllWorkspaces = (s: Session): boolean => isAdmin(s) && !currentWorkspaceId(s);

/* `saved` is settings.rolePermissions: a saved row for the role replaces the seed row. */
export function can(s: Session, permKey: string, saved?: RolePermissions | null): boolean {
  if (isAdmin(s)) return true;
  const role = normalizeRole(s.role) as string;
  const map = (saved && saved[role]) || DEFAULT_ROLE_PERMISSIONS[role] || {};
  return !!map[permKey];
}

type FileRef = { workspaceId?: string; sharedWith?: string[] };

/* Files with no workspaceId are shared with everyone (legacy data, or created by a
   workspace-less admin); `sharedWith` shares one with other workspaces. Admin sees every
   file on "Semua workspace", otherwise the active workspace's. */
export function visibleFiles<F extends FileRef>(allFiles: F[], s: Session): F[] {
  if (seesAllWorkspaces(s)) return allFiles;
  const ws = currentWorkspaceId(s);
  return allFiles.filter(f => !f.workspaceId || f.workspaceId === ws || (f.sharedWith || []).includes(ws as string));
}

/* Only the owning workspace (or admin) may change sharing, and only with testcase_fileShare. */
export function canShareFile(file: FileRef, s: Session, saved?: RolePermissions | null): boolean {
  if (isAdmin(s)) return can(s, 'testcase_fileShare', saved);
  if (!file.workspaceId) return false; // shared/legacy files have no single owner
  return file.workspaceId === currentWorkspaceId(s) && can(s, 'testcase_fileShare', saved);
}

export const normalizeEmail = (email: unknown): string => String(email || '').trim().toLowerCase();
export const isValidEmail = (email: unknown): boolean => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email || '').trim());
