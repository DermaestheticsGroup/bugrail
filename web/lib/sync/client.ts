import { TABLES, isSyncedTable, type SyncedTable } from '../../db/tables';
import { mergeArgs, mergeSql } from '../lww';
import type { Clock } from '../hlc';
import type { Db, Row, Tx } from '../db-types';
import type { PullResult, PushResult, PushRow } from './server';

export interface Transport {
  push(rows: PushRow[]): Promise<PushResult>;
  pull(since: number): Promise<PullResult>;
}

export async function localWrite(db: Db, tbl: SyncedTable, row: Row): Promise<void> {
  const write = db.transactionAsync(async (tx: Tx) => {
    await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
    await tx.run('INSERT INTO outbox (tbl, row_id) VALUES (?, ?)', tbl, row.id);
  });
  await write();
}

export async function pushOutbox(db: Db, t: Transport): Promise<PushResult | null> {
  const entries = await db.all(
    'SELECT tbl, row_id, MAX(seq) AS seq, MIN(seq) AS first_seq FROM outbox GROUP BY tbl, row_id ORDER BY first_seq LIMIT 500',
  );
  if (entries.length === 0) return null;
  const maxSeq = Math.max(...entries.map((e) => Number(e.seq)));
  const rows: PushRow[] = [];
  for (const e of entries) {
    if (!isSyncedTable(e.tbl)) continue;
    const row = await db.get(`SELECT * FROM ${e.tbl} WHERE id = ?`, e.row_id);
    if (row) rows.push({ tbl: e.tbl, row });
  }
  const result = await t.push(rows);
  const settle = db.transactionAsync(async (tx: Tx) => {
    for (const s of result.server) await tx.run(mergeSql(TABLES[s.tbl]), ...mergeArgs(TABLES[s.tbl], s.row));
    // Only entries that existed when the push started; later writes stay queued.
    for (const e of entries) {
      await tx.run('DELETE FROM outbox WHERE tbl = ? AND row_id = ? AND seq <= ?', e.tbl, e.row_id, maxSeq);
    }
  });
  await settle();
  return result;
}

export async function pullAll(db: Db, t: Transport, clock?: Clock): Promise<number> {
  let applied = 0;
  for (;;) {
    const sinceRow = await db.get("SELECT value FROM meta WHERE key = 'since'");
    const page = await t.pull(Number(sinceRow?.value ?? 0));
    const apply = db.transactionAsync(async (tx: Tx) => {
      for (const { tbl, row } of page.rows) {
        if (!isSyncedTable(tbl)) continue;
        if (clock && typeof row.hlc === 'string') clock.observe(row.hlc);
        await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
      }
      await tx.run(
        "INSERT INTO meta (key, value) VALUES ('since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(page.next),
      );
    });
    await apply();
    applied += page.rows.length;
    if (!page.more) return applied;
  }
}

export function httpTransport(base: string, user: string): Transport {
  // shortcut: x-dev-user stands in for the session cookie in the spike only.
  const headers = { 'content-type': 'application/json', 'x-dev-user': user };
  return {
    async push(rows) {
      const res = await fetch(`${base}/api/sync/push`, { method: 'POST', headers, body: JSON.stringify({ rows }) });
      if (!res.ok) throw new Error(`push ${res.status}`);
      return res.json();
    },
    async pull(since) {
      const res = await fetch(`${base}/api/sync/pull?since=${since}`, { headers });
      if (!res.ok) throw new Error(`pull ${res.status}`);
      return res.json();
    },
  };
}
