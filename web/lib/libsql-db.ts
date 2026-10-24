import { createClient, type InStatement, type Transaction } from '@libsql/client';
import type { Db, Tx } from './db-types';

// Adapts a remote libSQL/Turso database to the Db interface the server code uses.
type Exec = { execute(stmt: InStatement): Promise<any>; executeMultiple(sql: string): Promise<void> };

function tx(c: Exec): Tx {
  const q = (sql: string, params: unknown[]) => c.execute({ sql, args: params as any[] });
  return {
    async run(sql, ...params) {
      const r = await q(sql, params);
      return { changes: r.rowsAffected, lastInsertRowid: Number(r.lastInsertRowid ?? 0) };
    },
    async get(sql, ...params) { return (await q(sql, params)).rows[0]; },
    async all(sql, ...params) { return (await q(sql, params)).rows; },
    exec: (sql) => c.executeMultiple(sql),
  };
}

export function connectRemote(url: string, authToken?: string): Db {
  const client = createClient({ url, authToken });
  return {
    ...tx(client),
    transactionAsync: (fn) => (async (...args: any[]) => {
      const t: Transaction = await client.transaction('write');
      try {
        const out = await fn(tx({ execute: (s) => t.execute(s), executeMultiple: (s) => t.executeMultiple(s) }), ...args);
        await t.commit();
        return out;
      } catch (e) {
        await t.rollback();
        throw e;
      } finally {
        t.close();
      }
    }) as any,
  };
}
