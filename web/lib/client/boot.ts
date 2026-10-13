// Render first, authenticate second: a device that already holds data opens straight from the stored snapshot, even offline.
import type { ClientConfig } from '../server/config';

export type Snapshot = ClientConfig['me'];
const USER_KEY = 'bugrail.currentUser';
const CONFIG_KEY = 'bugrail.config';

const store = (): Storage | null => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const read = <T,>(k: string): T | null => { try { const v = store()?.getItem(k); return v ? (JSON.parse(v) as T) : null; } catch { return null; } };

export const loadSnapshot = () => read<Snapshot>(USER_KEY);
export const saveSnapshot = (u: Snapshot) => store()?.setItem(USER_KEY, JSON.stringify(u));
export const clearSnapshot = () => { store()?.removeItem(USER_KEY); store()?.removeItem(CONFIG_KEY); };
export const loadConfig = () => read<ClientConfig>(CONFIG_KEY);
export const saveConfig = (c: ClientConfig) => store()?.setItem(CONFIG_KEY, JSON.stringify(c));

export type MeResult = { kind: 'ok'; config: ClientConfig } | { kind: 'unauthorized' } | { kind: 'offline' };

// 401 is the only answer that ends a session. A network failure or a 5xx keeps the device working from what it has.
export async function fetchConfig(f: typeof fetch = fetch): Promise<MeResult> {
  try {
    const res = await f('/api/config', { cache: 'no-store' });
    if (res.status === 401) return { kind: 'unauthorized' };
    if (!res.ok) return { kind: 'offline' };
    return { kind: 'ok', config: await res.json() };
  } catch {
    return { kind: 'offline' };
  }
}

export type BootPlan = 'render-then-verify' | 'login' | 'wait-for-server';
// With a snapshot we render now and verify in the background; without one we need the server (online) or the login page.
export function planBoot(snapshot: Snapshot | null, hasLocalData: boolean, online: boolean): BootPlan {
  if (snapshot && hasLocalData) return 'render-then-verify';
  if (snapshot) return online ? 'wait-for-server' : 'login';
  return 'login';
}

// Per-user local databases: a different user on the same device never opens, or inherits, the previous user's file.
export const dbName = (userId: string) => `bugrail-${userId}.db`;
export const previousUser = () => store()?.getItem('bugrail.lastUserId') ?? null;
export const rememberUser = (id: string) => store()?.setItem('bugrail.lastUserId', id);
