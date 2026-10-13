import type { Db } from '../db-types';

// shortcut: hard-coded users stand in for the session in the spike only; Phase 3 replaces this with iron-session + the users table.
export interface User { id: string; email: string; role: string; workspaceIds: string[] }

export const USERS: Record<string, User> = {
  admin: { id: 'admin', email: 'admin@bugrail.test', role: 'admin', workspaceIds: [] },
  alice: { id: 'alice', email: 'alice@bugrail.test', role: 'qa_internal', workspaceIds: ['ws-a'] },
  bob: { id: 'bob', email: 'bob@bugrail.test', role: 'qa_internal', workspaceIds: ['ws-a'] },
  pm: { id: 'pm', email: 'pm@bugrail.test', role: 'pm_ba', workspaceIds: ['ws-a'] },
  vendor: { id: 'vendor', email: 'qa@vendor.test', role: 'qa_vendor', workspaceIds: ['ws-v'] },
};

// Dev auth is opt-in so a missing NODE_ENV never opens it.
const devAuth = () => process.env.BUGRAIL_DEV_AUTH === '1' && process.env.NODE_ENV !== 'production';

export function userFromHeader(h: string | null): User | undefined {
  return devAuth() && h !== null && Object.hasOwn(USERS, h) ? USERS[h] : undefined;
}

// Dev users need users rows so access_version exists; dev auth only.
export async function seedUsers(db: Db): Promise<void> {
  if (!devAuth()) return;
  for (const u of Object.values(USERS)) {
    await db.run(
      'INSERT INTO users (id, email, role, workspace_ids, access_version) VALUES (?, ?, ?, ?, 0) ON CONFLICT(id) DO NOTHING',
      u.id, u.email, u.role, JSON.stringify(u.workspaceIds),
    );
  }
}
