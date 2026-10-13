import type { Db } from '../db-types';

// The browser holds one connection, and a second BEGIN while a transaction is open fails. UI writes, push settles and pull applies
// all use transactions, so they take turns here. A failed transaction never blocks the ones queued behind it.
export function serializeTx(db: Db): Db {
  let tail: Promise<unknown> = Promise.resolve();
  const wrapped: Db = {
    run: (sql, ...p) => db.run(sql, ...p),
    get: (sql, ...p) => db.get(sql, ...p),
    all: (sql, ...p) => db.all(sql, ...p),
    exec: (sql) => db.exec(sql),
    transactionAsync: ((fn: Parameters<Db['transactionAsync']>[0]) => {
      const inner = db.transactionAsync(fn);
      return (...args: unknown[]) => {
        const run = tail.then(() => inner(...args));
        tail = run.catch(() => undefined);
        return run;
      };
    }) as Db['transactionAsync'],
  };
  return wrapped;
}
