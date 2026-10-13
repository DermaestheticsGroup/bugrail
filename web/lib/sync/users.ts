// shortcut: hard-coded users stand in for the session in the spike only; Phase 3 replaces this with iron-session + the users table.
export interface User { id: string; email: string; role: 'admin' | 'user'; workspaceIds: string[] }

export const USERS: Record<string, User> = {
  admin: { id: 'admin', email: 'admin@bugrail.test', role: 'admin', workspaceIds: [] },
  alice: { id: 'alice', email: 'alice@bugrail.test', role: 'user', workspaceIds: ['ws-a'] },
  bob: { id: 'bob', email: 'bob@bugrail.test', role: 'user', workspaceIds: ['ws-a'] },
  vendor: { id: 'vendor', email: 'qa@vendor.test', role: 'user', workspaceIds: ['ws-v'] },
};

export function userFromHeader(h: string | null): User | undefined {
  return process.env.NODE_ENV !== 'production' && h !== null && Object.hasOwn(USERS, h) ? USERS[h] : undefined;
}
