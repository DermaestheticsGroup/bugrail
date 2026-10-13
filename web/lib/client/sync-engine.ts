// Drives push and pull for one signed-in device. Everything time- or network-related is injected, so bun tests run it with fake timers.
import type { Clock } from '../hlc';
import type { Db } from '../db-types';
import { pullAll, pushOutbox, type Transport } from '../sync/client';
import { HttpError } from './transport';

export const PUSH_DELAY_MS = 1000;
export const POKE_DEBOUNCE_MS = 500;
export const POLL_MS = 30_000;
export const CLOCK_LIMIT_MS = 5 * 60_000;

export interface SyncState {
  online: boolean;
  pending: number;
  lastPullAt: number | null;
  syncing: boolean;
  // 'expired' after a 401: the UI sends the user to /login; the outbox stays in OPFS for the same user's next login.
  auth: 'ok' | 'expired';
  error: string | null;
  skewMs: number;
}

export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(h: unknown): void;
}

export interface EngineDeps {
  db: Db;
  transport: Transport;
  clock?: Clock;
  timers?: Timers;
  isOnline?: () => boolean;
  now?: () => number;
  onState?: (s: SyncState) => void;
  // Fired after a pull applied rows or a push settled server rows: screens re-query (deferred while the user is busy).
  // 'push' = our own writes settled (codes arrived): show at once. 'pull' = someone else's changes: may wait while the user is busy.
  onDbChanged?: (source: 'push' | 'pull') => void;
}

export class SyncEngine {
  state: SyncState = { online: true, pending: 0, lastPullAt: null, syncing: false, auth: 'ok', error: null, skewMs: 0 };
  private d: Required<Omit<EngineDeps, 'clock' | 'onState' | 'onDbChanged'>> & Pick<EngineDeps, 'clock' | 'onState' | 'onDbChanged'>;
  private pushTimer: unknown; private pullTimer: unknown; private poll: unknown;
  private chain: Promise<unknown> = Promise.resolve();
  private stopped = false; // only stop() sets it

  constructor(deps: EngineDeps) {
    this.d = {
      timers: globalThis as unknown as Timers,
      // Only an explicit false counts as offline: some runtimes expose navigator without onLine.
      isOnline: () => (typeof navigator === 'undefined' ? true : navigator.onLine !== false),
      now: Date.now,
      ...deps,
    };
    this.state.online = this.d.isOnline();
  }

  private set(p: Partial<SyncState>) { this.state = { ...this.state, ...p }; this.d.onState?.(this.state); }

  // Writes are refused while the device clock is far from the server's: a fast clock would win every conflict.
  writeBlock = (): string | null =>
    Math.abs(this.state.skewMs) > CLOCK_LIMIT_MS ? 'Device clock is more than 5 minutes off the server. Fix the clock to keep editing.' : null;

  observeServerDate = (serverMs: number) => {
    const skew = this.d.now() - serverMs;
    if (skew !== this.state.skewMs) this.set({ skewMs: skew });
  };

  async refreshPending() {
    const n = Number((await this.d.db.get('SELECT count(*) AS n FROM outbox')).n);
    if (n !== this.state.pending) this.set({ pending: n });
  }

  // One network operation at a time: push and pull never interleave, and a failure never breaks the chain.
  private enqueue<T>(fn: () => Promise<T>): Promise<T | undefined> {
    const next = this.chain.then(fn, fn).catch(() => undefined) as Promise<T | undefined>;
    this.chain = next;
    return next;
  }

  private async guarded(what: () => Promise<void>) {
    if (this.stopped || !this.d.isOnline() || this.state.auth === 'expired') { await this.refreshPending(); return; }
    this.set({ syncing: true, error: null });
    try {
      await what();
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) this.set({ auth: 'expired' });
      else this.set({ error: (e as Error).message });
    } finally {
      this.set({ syncing: false });
      await this.refreshPending();
    }
  }

  push = () => this.enqueue(() => this.guarded(async () => {
    for (;;) {
      const r = await pushOutbox(this.d.db, this.d.transport);
      if (!r) return;
      if (r.server.length || r.rejected.length) this.d.onDbChanged?.('push');
      if ((await this.pendingCount()) === 0) return;
      if (r.accepted.length === 0 && r.rejected.length === 0) return; // nothing settled: stop instead of spinning
    }
  }));

  pull = () => this.enqueue(() => this.guarded(async () => {
    const applied = await pullAll(this.d.db, this.d.transport, this.d.clock);
    this.set({ lastPullAt: this.d.now() });
    if (applied > 0) this.d.onDbChanged?.('pull');
  }));

  private async pendingCount() { return Number((await this.d.db.get('SELECT count(*) AS n FROM outbox')).n); }

  // A local write: show it in the badge right away, push one second after the last write.
  notifyWrite = () => {
    void this.refreshPending();
    this.d.timers.clearTimeout(this.pushTimer);
    this.pushTimer = this.d.timers.setTimeout(() => void this.push(), PUSH_DELAY_MS);
  };

  // An SSE `sync` poke: debounced so a burst becomes one pull.
  poke = () => {
    this.d.timers.clearTimeout(this.pullTimer);
    this.pullTimer = this.d.timers.setTimeout(() => void this.pull(), POKE_DEBOUNCE_MS);
  };

  // Reconnect, tab visible, or the 30 s poll: push what is queued, then pull.
  syncNow = async () => { await this.push(); await this.pull(); };

  setOnline(online: boolean) {
    this.set({ online });
    if (online) void this.syncNow();
  }

  start() {
    this.stopped = false;
    void this.refreshPending();
    void this.syncNow();
    this.poll = this.d.timers.setInterval(() => void this.syncNow(), POLL_MS);
  }

  stop() {
    this.stopped = true;
    this.d.timers.clearTimeout(this.pushTimer);
    this.d.timers.clearTimeout(this.pullTimer);
    this.d.timers.clearInterval(this.poll);
  }
}
