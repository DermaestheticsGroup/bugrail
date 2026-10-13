'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { createClock } from '@/lib/hlc';
import type { Db } from '@/lib/db-types';
import type { ClientConfig } from '@/lib/server/config';
import { clearSnapshot, fetchConfig, loadConfig, loadSnapshot, planBoot, previousUser, rememberUser, saveConfig, saveSnapshot, switchUser } from '@/lib/client/boot';
import { closeLocalDb, hasLocalData, openLocalDb, outboxSize, requestPersistence, wipeLocalDb } from '@/lib/client/db';
import { SyncEngine, type SyncState } from '@/lib/client/sync-engine';
import { cookieTransport } from '@/lib/client/transport';
import type { Ctx } from '@/lib/client/repo';

export type Phase = 'booting' | 'ready' | 'anon' | 'error';
export interface AppValue {
  phase: Phase;
  error: string | null;
  config: ClientConfig | null;
  db: Db | null;
  ctx: Ctx | null;
  sync: SyncState;
  // Bumped when a pull or push settle changed rows, deferred while the user is typing or dragging.
  version: number;
  offlineSince: boolean;
  // Pull now (used after dismissing a parked rejection, which resets the cursor).
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

// Stable per browser profile so two tabs and later sessions never share an HLC device id with another device.
function deviceId(): string {
  const k = 'bugrail.deviceId';
  let id = localStorage.getItem(k);
  if (!id) { id = `d${Math.random().toString(36).slice(2, 10)}`; localStorage.setItem(k, id); }
  return id;
}

const initialSync: SyncState = { online: true, pending: 0, lastPullAt: null, syncing: false, auth: 'ok', error: null, skewMs: 0 };
const Ctx_ = createContext<AppValue | null>(null);
export const useApp = () => { const v = useContext(Ctx_); if (!v) throw new Error('useApp outside AppProvider'); return v; };

// Port of isUserBusy (qa-app/js/app.js): never redraw under someone who is typing or dragging.
export function isUserBusy(doc: Document = document): boolean {
  if (doc.querySelector('.dragging')) return true;
  if ([...doc.querySelectorAll('[data-modal-open]')].some((m) => (m as HTMLElement).dataset.modalOpen !== 'detail')) return true;
  const el = doc.activeElement as HTMLInputElement | null;
  const typing = el && (el.isContentEditable || el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && !/^(checkbox|radio|button|submit|file|range|color)$/.test(el.type)));
  return !!typing && el!.id !== 'bugChatInput';
}

export default function AppProvider({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('booting');
  const [error, setError] = useState<string | null>(null);
  const [config, setConfig] = useState<ClientConfig | null>(null);
  const [db, setDb] = useState<Db | null>(null);
  const [sync, setSync] = useState<SyncState>(initialSync);
  const [version, setVersion] = useState(0);
  const engineRef = useRef<SyncEngine | null>(null);
  const [ctx, setCtx] = useState<Ctx | null>(null);
  const pendingChange = useRef(false);
  // Stops the engine, listeners and event stream of the user loaded at boot; set once they exist.
  const teardownRef = useRef<(() => void) | null>(null);
  const activeUserRef = useRef<string | null>(null);
  const configStale = useRef(false);

  const bump = useCallback((source: 'push' | 'pull' = 'pull') => {
    // Our own settled writes are what the user is waiting to see (the assigned code); only other people's changes wait.
    if (source === 'push') { setVersion((v) => v + 1); return; }
    configStale.current = true; // roles or workspaces can only have moved because of someone else's change
    pendingChange.current = true;
    const flush = () => {
      if (!pendingChange.current) return;
      if (isUserBusy()) { setTimeout(flush, 1000); return; }
      pendingChange.current = false;
      setVersion((v) => v + 1);
    };
    flush();
  }, []);

  useEffect(() => {
    let cancelled = false;
    let es: EventSource | null = null;
    const cleanups: (() => void)[] = [];

    (async () => {
      const snapshot = loadSnapshot();
      const online = navigator.onLine !== false;
      // Decide from the snapshot alone whether we can render before the server answers.
      let plan = planBoot(snapshot, false, online);
      let db0: Db | null = null;
      if (snapshot) {
        try { db0 = await openLocalDb(snapshot.id); plan = planBoot(snapshot, await hasLocalData(db0), online); } catch (e) { setError((e as Error).message); setPhase('error'); return; }
      }
      if (cancelled) return;
      if (plan === 'login') { setPhase('anon'); return; }

      let cfg = loadConfig();
      if (plan === 'wait-for-server') {
        const r = await fetchConfig();
        if (r.kind !== 'ok') { if (r.kind === 'unauthorized') clearSnapshot(); setPhase('anon'); return; }
        cfg = r.config; saveConfig(cfg); saveSnapshot(cfg.me);
      }
      if (!snapshot || !db0 || !cfg) { setPhase('anon'); return; }

      // One clock for reads and writes: HLCs observed on pull must advance the stamps of later local writes.
      const clock = createClock(deviceId());
      const engine = new SyncEngine({
        db: db0,
        transport: cookieTransport('', (ms) => engineRef.current?.observeServerDate(ms)),
        clock,
        onState: setSync,
        onDbChanged: bump,
      });
      engineRef.current = engine;
      activeUserRef.current = snapshot.id;
      setDb(db0); setConfig(cfg); setCtx({ db: db0, clock, email: snapshot.email, role: snapshot.role, memberOf: snapshot.role === 'admin' ? undefined : snapshot.workspaceIds, afterWrite: engine.notifyWrite, writeBlock: engine.writeBlock });

      const onOnline = () => engine.setOnline(true);
      const onOffline = () => engine.setOnline(false);
      const onVisible = () => { if (document.visibilityState === 'visible') void engine.syncNow(); };
      window.addEventListener('online', onOnline);
      window.addEventListener('offline', onOffline);
      document.addEventListener('visibilitychange', onVisible);
      cleanups.push(() => { window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline); document.removeEventListener('visibilitychange', onVisible); engine.stop(); });

      // Live refresh pokes. EventSource reconnects by itself; a 401 closes it for good, which the next sync notices.
      es = new EventSource('/api/events');
      es.addEventListener('sync', () => engine.poke());
      cleanups.push(() => es?.close());
      // Registered before the verify await below, so a refresh that finds a different user can tear this session down at any point.
      const stopAll = () => { cleanups.splice(0).forEach((c) => c()); };
      teardownRef.current = stopAll;
      setPhase('ready'); // only now: every cleanup above is registered, so nothing can run against a session that cannot be torn down
      void requestPersistence();
      engine.start();

      // Verify in the background: only a 401 ends the session (the outbox stays in OPFS for the same user's next login).
      if (plan === 'render-then-verify') {
        const r = await fetchConfig();
        if (cancelled) return;
        if (r.kind === 'ok') {
          if (r.config.me.id !== snapshot.id) {
            // The cookie belongs to someone else. Keep the old user's outbox on disk (their next login pushes it), but release it,
            // and do not store the new user's config here: their own login does that.
            clearSnapshot(); stopAll(); await closeLocalDb(snapshot.id); setPhase('anon');
          } else { saveConfig(r.config); saveSnapshot(r.config.me); setConfig(r.config); }
        } else if (r.kind === 'unauthorized') { stopAll(); setPhase('anon'); }
      }
    })().catch((e) => { setError((e as Error).message); setPhase('error'); });

    return () => { cancelled = true; cleanups.forEach((c) => c()); es?.close(); };
  }, [bump]);

  // Refresh the shell config after a pull that changed rows; our own settled writes do not need it.
  useEffect(() => {
    if (phase !== 'ready' || version === 0 || !configStale.current) return;
    configStale.current = false;
    // A later refresh supersedes an earlier one: if this effect re-runs (or the provider unmounts) before the response lands, drop it.
    let current = true;
    void fetchConfig().then(async (r) => {
      if (!current || r.kind !== 'ok') return;
      // Another tab may have signed in as someone else. Their config must never meet this user's database and engine:
      // same cleanup as the boot-time mismatch (the old user's outbox stays on disk for their own next login).
      if (activeUserRef.current && r.config.me.id !== activeUserRef.current) {
        const old = activeUserRef.current;
        activeUserRef.current = null;
        clearSnapshot(); teardownRef.current?.(); await closeLocalDb(old); setPhase('anon');
        return;
      }
      saveConfig(r.config); setConfig(r.config);
    });
    return () => { current = false; };
  }, [version, phase]);

  const logout = useCallback(async () => {
    engineRef.current?.stop();
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    clearSnapshot();
    location.href = '/login';
  }, []);

  const refresh = useCallback(async () => { await engineRef.current?.pull(); setVersion((v) => v + 1); }, []);
  const value = useMemo<AppValue>(() => ({ phase, error, config, db, ctx, sync, version, offlineSince: !sync.online, refresh, logout }), [phase, error, config, db, ctx, sync, version, refresh, logout]);
  return <Ctx_.Provider value={value}>{children}</Ctx_.Provider>;
}

// Exposed for the login page: wipe the previous user's local data when a different user signs in.
export function prepareLoginFor(userId: string, confirmFn: (m: string) => boolean = (m) => confirm(m)): Promise<boolean> {
  return switchUser(userId, { previous: previousUser(), open: openLocalDb, outboxSize: (db) => outboxSize(db as Db), close: closeLocalDb, wipe: wipeLocalDb, confirm: confirmFn, alert: (m) => alert(m), remember: rememberUser });
}
