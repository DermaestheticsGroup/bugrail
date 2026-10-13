import { can, type RolePermissions } from '../domain/auth';

export interface NavItem { slug: string; title: string; sub: string; perm?: string; adminOnly?: boolean; onlineOnly?: boolean }

// Same pages and titles as qa-app/js/app.js (titles map and nav permissions); the path replaces the sessionStorage page.
export const NAV: NavItem[] = [
  { slug: 'dashboard', title: 'Dashboard', sub: 'Ringkasan status pengujian & bug secara realtime', perm: 'dashboard' },
  { slug: 'testcases', title: 'Test Case', sub: 'Kelola skenario pengujian', perm: 'testcase_read' },
  { slug: 'bugs', title: 'Bug Report', sub: 'Laporan bug terintegrasi dengan Test Case', perm: 'bugreport_read' },
  { slug: 'summary', title: 'Summary', sub: 'Rekap progres testing & bug', perm: 'summary' },
  { slug: 'report', title: 'Report', sub: 'Analisa kesiapan go-live untuk PM & BA', perm: 'report' },
  { slug: 'import-export', title: 'Import & Export', sub: 'Import Test Case, export data, backup & restore', perm: 'testcase_read' },
  { slug: 'activity', title: 'Activity Log', sub: 'Riwayat aktivitas user dari login sampai logout', perm: 'activitylog' },
  { slug: 'master/status', title: 'Status Bug Report', sub: 'Master data status bug report', perm: 'master' },
  { slug: 'users', title: 'User Management', sub: 'Kelola akun login (Admin & User)', perm: 'usermanagement', onlineOnly: true },
  { slug: 'roles', title: 'Role Permission', sub: 'Atur hak akses tiap role', adminOnly: true, onlineOnly: true },
  { slug: 'workspaces', title: 'Workspaces', sub: 'Kelola workspace', adminOnly: true, onlineOnly: true },
  { slug: 'settings', title: 'Settings', sub: 'Preferensi aplikasi & data', perm: 'settings' },
];

export const navFor = (role: string, saved: RolePermissions | null): NavItem[] =>
  NAV.filter((n) => (n.adminOnly ? role === 'admin' : !n.perm || can({ role }, n.perm, saved)));

export const navBySlug = (slug: string): NavItem | undefined => NAV.find((n) => n.slug === slug);
export const hrefFor = (ws: string, slug: string) => `/w/${encodeURIComponent(ws)}/${slug}`;

// "all" is the admin's "Semua workspace" view; everyone else must pick one of their own.
export const ALL_WS = 'all';
// `all` is every workspace the config lists (an admin need not belong to a workspace to open it); others get only their own.
export function allowedWorkspaces(role: string, workspaceIds: string[], all: string[] = workspaceIds): string[] {
  return role === 'admin' ? [ALL_WS, ...all] : workspaceIds;
}
