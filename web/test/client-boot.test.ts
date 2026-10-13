import { describe, expect, test } from 'bun:test';
import { ALL_WS, NAV, allowedWorkspaces, hrefFor, navFor } from '../lib/client/nav';
import { dbName, fetchConfig, planBoot } from '../lib/client/boot';

const snap = { id: 'u', email: 'u@x.test', role: 'qa_internal', workspaceIds: ['ws-a'] };
const res = (status: number, body?: unknown) => (async () => new Response(body === undefined ? null : JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('planBoot', () => {
  test('a device with a snapshot and local data opens at once, online or not', () => {
    expect(planBoot(snap, true, false)).toBe('render-then-verify');
    expect(planBoot(snap, true, true)).toBe('render-then-verify');
  });
  test('a snapshot without local data needs the server; offline it can only go to login', () => {
    expect(planBoot(snap, false, true)).toBe('wait-for-server');
    expect(planBoot(snap, false, false)).toBe('login');
  });
  test('no snapshot always goes to login', () => {
    expect(planBoot(null, true, true)).toBe('login');
    expect(planBoot(null, false, false)).toBe('login');
  });
});

describe('fetchConfig', () => {
  test('401 ends the session; network failure and 5xx do not', async () => {
    expect(await fetchConfig(res(401))).toEqual({ kind: 'unauthorized' });
    expect(await fetchConfig(res(500))).toEqual({ kind: 'offline' });
    expect(await fetchConfig((async () => { throw new TypeError('Failed to fetch'); }) as unknown as typeof fetch)).toEqual({ kind: 'offline' });
  });
  test('200 returns the config', async () => {
    const config = { me: snap, workspaces: [], users: [], roles: [], rolePermissions: {} };
    expect(await fetchConfig(res(200, config))).toEqual({ kind: 'ok', config });
  });
});

describe('nav', () => {
  test('admin-only pages are hidden from everyone else, even with every permission saved', () => {
    const all = Object.fromEntries(['dashboard', 'summary', 'report', 'testcase_read', 'bugreport_read', 'activitylog', 'master', 'usermanagement', 'settings'].map((k) => [k, true]));
    const slugs = navFor('qa_internal', { qa_internal: all }).map((n) => n.slug);
    expect(slugs).not.toContain('roles');
    expect(slugs).not.toContain('workspaces');
    expect(navFor('admin', null).map((n) => n.slug)).toEqual(NAV.map((n) => n.slug));
  });
  test('a vendor sees only what the matrix allows', () => {
    expect(navFor('qa_vendor', null).map((n) => n.slug).sort()).toEqual(['bugs', 'import-export', 'testcases']);
    expect(navFor('qa_vendor', { qa_vendor: { report: true } }).map((n) => n.slug)).toEqual(['report']);
  });
  test('user, role and workspace admin pages are online-only', () => {
    expect(NAV.filter((n) => n.onlineOnly).map((n) => n.slug).sort()).toEqual(['roles', 'users', 'workspaces']);
  });
  test('only the admin may pick "all workspaces"', () => {
    expect(allowedWorkspaces('admin', ['a'])).toEqual([ALL_WS, 'a']);
    expect(allowedWorkspaces('qa_vendor', ['v'])).toEqual(['v']);
  });
  test('hrefs encode the workspace', () => {
    expect(hrefFor('ws a/b', 'bugs')).toBe('/w/ws%20a%2Fb/bugs');
  });
  test('database files are per user', () => {
    expect(dbName('usr-1')).not.toBe(dbName('usr-2'));
  });
});
