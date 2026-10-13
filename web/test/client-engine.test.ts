import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { addEvent, createBug, createFile, createTestcase, liveRows, softDelete, upsertRow, type Ctx } from '../lib/client/repo';
import { CLOCK_LIMIT_MS, POKE_DEBOUNCE_MS, POLL_MS, PUSH_DELAY_MS, SyncEngine, type Timers } from '../lib/client/sync-engine';
import { HttpError } from '../lib/client/transport';
import { pull, push } from '../lib/sync/server';
import { seedUsers, USERS } from '../lib/sync/users';
import type { Transport } from '../lib/sync/client';
import type { Db } from '../lib/db-types';

// Fake timers: nothing runs until the test advances the clock.
function fakeTimers() {
  let t = 0, id = 0;
  const q = new Map<number, { at: number; fn: () => void; every?: number }>();
  const timers: Timers = {
    setTimeout: (fn, ms) => { q.set(++id, { at: t + ms, fn }); return id; },
    clearTimeout: (h) => { q.delete(h as number); },
    setInterval: (fn, ms) => { q.set(++id, { at: t + ms, fn, every: ms }); return id; },
    clearInterval: (h) => { q.delete(h as number); },
  };
  const advance = async (ms: number) => {
    const end = t + ms;
    for (;;) {
      const due = [...q.entries()].filter(([, x]) => x.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [k, x] = due;
      t = x.at;
      if (x.every) x.at += x.every; else q.delete(k);
      x.fn();
      await new Promise((r) => setTimeout(r, 15)); // let the async work the callback started finish
    }
    t = end;
  };
  return { timers, advance, now: () => t };
}

let server: Db, local: Db, online: boolean, calls: string[], failWith: number | null;
const transport = (userKey: keyof typeof USERS): Transport => ({
  push: async (rows) => { calls.push('push'); if (failWith) throw new HttpError(failWith, 'push'); return push(server, USERS[userKey], rows); },
  pull: async (since, av, sv) => { calls.push('pull'); if (failWith) throw new HttpError(failWith, 'pull'); return pull(server, USERS[userKey], since, av, sv); },
});
const pendingRows = async () => Number((await local.get('SELECT count(*) AS n FROM outbox')).n);

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(server, 'server');
  await seedUsers(server);
  local = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(local, 'local');
  online = true; calls = []; failWith = null;
  await push(server, USERS.admin, [{ tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: '000000000000001-00000-s' } }]);
});

function make() {
  const ft = fakeTimers();
  const states: number[] = [];
  let changed = 0;
  const engine = new SyncEngine({
    db: local, transport: transport('alice'), clock: createClock('dev1'), timers: ft.timers, isOnline: () => online, now: ft.now,
    onState: (s) => states.push(s.pending), onDbChanged: () => { changed++; },
  });
  const ctx: Ctx = { db: local, clock: createClock('dev1'), email: 'alice@bugrail.test', afterWrite: engine.notifyWrite, writeBlock: engine.writeBlock };
  return { ft, engine, ctx, changed: () => changed, states };
}

describe('repo', () => {
  test('a create is queued with a null code and stamps hlc, status_hlc and the author', async () => {
    const { ctx } = make();
    const b = await createBug(ctx, 'fa', { title: 'T', module: 'Login' });
    expect(b.code).toBeUndefined();
    expect(b.status_code).toBe('OPEN');
    expect(String(b.hlc)).toMatch(/^\d{15}-\d{5}-dev1$/);
    expect(b.status_hlc).toBeDefined();
    expect(b.updated_by).toBe('alice@bugrail.test');
    expect(await pendingRows()).toBe(1);
  });
  test('editing a non-status field leaves status_hlc alone; a status move advances only it and hlc', async () => {
    const { ctx } = make();
    const b = await createBug(ctx, 'fa', { title: 'T' });
    const e = await upsertRow(ctx, 'bugs', String(b.id), { description: 'd' });
    expect(e.status_hlc).toBe(b.status_hlc);
    expect(String(e.hlc) > String(b.hlc)).toBe(true);
    const s = await upsertRow(ctx, 'bugs', String(b.id), { status_code: 'RETEST' });
    expect(String(s.status_hlc) > String(b.status_hlc)).toBe(true);
  });
  test('softDelete tombstones instead of deleting, and liveRows hides it', async () => {
    const { ctx } = make();
    const b = await createBug(ctx, 'fa', { title: 'T' });
    await softDelete(ctx, 'bugs', String(b.id));
    expect((await local.get('SELECT deleted_at FROM bugs WHERE id = ?', b.id)).deleted_at).toBeTruthy();
    expect(await liveRows(local, 'bugs')).toEqual([]);
  });
  test('events and files and test cases are plain writes', async () => {
    const { ctx } = make();
    const f = await createFile(ctx, 'ws-a', 'F');
    const t = await createTestcase(ctx, String(f.id), { module: 'Login' });
    const ev = await addEvent(ctx, 'b1', 'comment', { text: 'hi' });
    expect(t.status).toBe('Open');
    expect(ev.kind).toBe('comment');
    expect(ev.hlc).toBeUndefined(); // insert-only
    expect(await pendingRows()).toBe(3);
  });
  test('a blocked clock refuses the write before touching the db', async () => {
    const { ctx } = make();
    ctx.writeBlock = () => 'clock off';
    await expect(createBug(ctx, 'fa', { title: 'T' })).rejects.toThrow('clock off');
    expect(await pendingRows()).toBe(0);
  });
});

describe('engine: when it syncs', () => {
  test('push runs one second after the LAST write, not after each', async () => {
    const { ft, engine, ctx } = make();
    await createBug(ctx, 'fa', { title: 'a' });
    await ft.advance(PUSH_DELAY_MS - 100);
    await createBug(ctx, 'fa', { title: 'b' }); // restarts the wait
    await ft.advance(PUSH_DELAY_MS - 100);
    expect(calls).toEqual([]);
    await ft.advance(200);
    expect(calls.filter((c) => c === 'push').length).toBeGreaterThanOrEqual(1);
    expect(await pendingRows()).toBe(0);
    expect(Number((await server.get('SELECT count(*) AS n FROM bugs')).n)).toBe(2);
    engine.stop();
  });
  test('offline: nothing is sent, the pending count stays; reconnecting pushes and the codes arrive', async () => {
    const { ft, engine, ctx } = make();
    online = false; engine.setOnline(false);
    await createBug(ctx, 'fa', { title: 'offline bug', module: 'Login' });
    await ft.advance(PUSH_DELAY_MS * 3);
    expect(calls).toEqual([]);
    expect(engine.state.pending).toBe(1);
    online = true; engine.setOnline(true);
    await engine.syncNow();
    expect(engine.state.pending).toBe(0);
    await engine.pull();
    expect((await local.get("SELECT code FROM bugs WHERE title = 'offline bug'")).code).toMatch(/^BUG-\d{4}$/);
  });
  test('an SSE poke pulls once after a 500 ms debounce, however many arrive', async () => {
    const { ft, engine } = make();
    await engine.pull(); // first pull resets once, so settle it before counting
    calls.length = 0;
    engine.poke(); engine.poke(); engine.poke();
    await ft.advance(POKE_DEBOUNCE_MS - 50);
    expect(calls).toEqual([]);
    await ft.advance(100);
    expect(calls.filter((c) => c === 'pull').length).toBe(1);
  });
  test('the 30 s poll syncs; stop() ends it', async () => {
    const { ft, engine } = make();
    engine.start();
    await ft.advance(10);
    const first = calls.length;
    await ft.advance(POLL_MS);
    expect(calls.length).toBeGreaterThan(first);
    engine.stop();
    const n = calls.length;
    await ft.advance(POLL_MS * 2);
    expect(calls.length).toBe(n);
  });
  test('pulled rows from another device raise db-changed; an empty pull does not', async () => {
    const { ft, engine, changed } = make();
    await engine.pull();
    const before = changed();
    await push(server, USERS.bob, [{ tbl: 'bugs', row: { id: 'x1', file_id: 'fa', title: 'from bob', status_code: 'OPEN', status_hlc: '000000000000002-00000-b', hlc: '000000000000002-00000-b' } }]);
    await engine.pull();
    expect(changed()).toBe(before + 1);
    await engine.pull();
    expect(changed()).toBe(before + 1);
    void ft;
  });
});

describe('engine: failure handling', () => {
  test('a 401 marks the session expired and stops further network calls, keeping the outbox', async () => {
    const { ft, engine, ctx } = make();
    await createBug(ctx, 'fa', { title: 'kept' });
    failWith = 401;
    await engine.push();
    expect(engine.state.auth).toBe('expired');
    const n = calls.length;
    failWith = null;
    await engine.syncNow();
    expect(calls.length).toBe(n);
    expect(await pendingRows()).toBe(1);
    void ft;
  });
  test('a 500 is shown as an error, the outbox is kept, and the next sync retries', async () => {
    const { engine, ctx } = make();
    await createBug(ctx, 'fa', { title: 'retry me' });
    failWith = 500;
    await engine.push();
    expect(engine.state.error).toMatch(/500/);
    expect(await pendingRows()).toBe(1);
    failWith = null;
    await engine.push();
    expect(engine.state.error).toBeNull();
    expect(await pendingRows()).toBe(0);
  });
  test('push and pull never overlap even when triggered together', async () => {
    const { engine, ctx } = make();
    await createBug(ctx, 'fa', { title: 'a' });
    let inflight = 0, max = 0;
    const slow = transport('alice');
    const wrap = (f: (...a: any[]) => Promise<any>) => async (...a: any[]) => { inflight++; max = Math.max(max, inflight); await new Promise((r) => setTimeout(r, 10)); try { return await f(...a); } finally { inflight--; } };
    const e2 = new SyncEngine({ db: local, transport: { push: wrap(slow.push), pull: wrap(slow.pull) } as Transport, clock: createClock('dev1') });
    void engine;
    await Promise.all([e2.push(), e2.pull(), e2.push(), e2.pull()]);
    expect(max).toBe(1);
  });
});

describe('engine: clock guard', () => {
  test('writes are blocked past 5 minutes of skew and allowed again after it is fixed', () => {
    const { engine } = make();
    expect(engine.writeBlock()).toBeNull();
    engine.observeServerDate(engine['d'].now() - CLOCK_LIMIT_MS - 1000);
    expect(engine.writeBlock()).toMatch(/clock/i);
    engine.observeServerDate(engine['d'].now() + 1000);
    expect(engine.writeBlock()).toBeNull();
    engine.observeServerDate(engine['d'].now() + CLOCK_LIMIT_MS + 1000); // a slow clock is just as bad
    expect(engine.writeBlock()).toMatch(/clock/i);
  });
});
