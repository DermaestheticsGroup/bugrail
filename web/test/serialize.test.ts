import { describe, expect, test } from 'bun:test';
import { serializeTx } from '../lib/client/serialize';
import type { Db, Tx } from '../lib/db-types';

// A db that fails like the wasm connection does when two transactions overlap.
function strictDb() {
  let open = 0, max = 0;
  const tx = {} as Tx;
  const db = {
    run: async () => ({ changes: 0, lastInsertRowid: 0 }), get: async () => undefined, all: async () => [], exec: async () => {},
    transactionAsync: (fn: (t: Tx) => Promise<unknown>) => async (...a: unknown[]) => {
      if (open > 0) throw new Error('cannot start a transaction within a transaction');
      open++; max = Math.max(max, open);
      try { await new Promise((r) => setTimeout(r, 5)); return await (fn as any)(tx, ...a); } finally { open--; }
    },
  } as unknown as Db;
  return { db, max: () => max };
}

describe('serializeTx', () => {
  test('without it, overlapping transactions fail (the hazard)', async () => {
    const { db } = strictDb();
    const f = db.transactionAsync(async () => 1);
    await expect(Promise.all([f(), f()])).rejects.toThrow(/within a transaction/);
  });
  test('with it, concurrent transactions take turns and all succeed, in order', async () => {
    const { db, max } = strictDb();
    const s = serializeTx(db);
    const order: number[] = [];
    const make = (i: number) => s.transactionAsync(async () => { order.push(i); return i; })();
    expect(await Promise.all([make(1), make(2), make(3), make(4)])).toEqual([1, 2, 3, 4]);
    expect(order).toEqual([1, 2, 3, 4]);
    expect(max()).toBe(1);
  });
  test('a failed transaction rejects its own caller but not the ones queued behind it', async () => {
    const { db } = strictDb();
    const s = serializeTx(db);
    const bad = s.transactionAsync(async () => { throw new Error('boom'); })();
    const good = s.transactionAsync(async () => 'ok')();
    await expect(bad).rejects.toThrow('boom');
    expect(await good).toBe('ok');
  });
  test('arguments pass through and reads are not queued', async () => {
    const { db } = strictDb();
    const s = serializeTx(db);
    expect(await s.transactionAsync(async (_t: Tx, a: number, b: number) => a + b)(2, 3)).toBe(5);
    expect(await s.get('x')).toBeUndefined();
  });
});
