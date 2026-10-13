import { TABLES, SYNCED_TABLES, isSyncedTable, type SyncedTable } from '../../db/tables';
import { mergeArgs, mergeSql } from '../lww';
import type { Clock } from '../hlc';
import type { Db, Row, Tx } from '../db-types';
import type { PullResult, PushResult, PushRow } from './server';

export interface Transport {
  push(rows: PushRow[]): Promise<PushResult>;
  pull(since: number, av: number, sv: number): Promise<PullResult>;
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
    // A rejected write is parked for the UI, and its outbox entry still clears so it never retries forever.
    const at = new Date().toISOString();
    for (const r of result.rejected) {
      const e = entries.find((x) => x.row_id === r.id && (!r.tbl || x.tbl === r.tbl));
      if (!e) continue;
      await tx.run(
        'INSERT INTO rejected (row_id, tbl, reason, at) VALUES (?, ?, ?, ?) ON CONFLICT(row_id) DO UPDATE SET tbl = excluded.tbl, reason = excluded.reason, at = excluded.at',
        r.id, e.tbl, r.reason, at,
      );
    }
    // Only entries that existed when the push started; later writes stay queued.
    for (const e of entries) {
      await tx.run('DELETE FROM outbox WHERE tbl = ? AND row_id = ? AND seq <= ?', e.tbl, e.row_id, maxSeq);
    }
  });
  await settle();
  return result;
}

export async function listRejected(db: Db): Promise<Row[]> {
  return db.all('SELECT row_id, tbl, reason, at FROM rejected ORDER BY at, row_id');
}

// The local copy holds state the server refused: a never-accepted insert, or an edit to a row the user may no longer
// write. Drop it (unless a newer write is queued) and re-pull from 0 so any server copy the user can still see returns.
// shortcut: full re-pull per dismiss, fine while dismissals are rare; upgrade to a per-row fetch if they are not.
export async function dismissRejected(db: Db, rowId: string): Promise<void> {
  const dismiss = db.transactionAsync(async (tx: Tx) => {
    const r = await tx.get('SELECT tbl FROM rejected WHERE row_id = ?', rowId);
    if (!r) return;
    await tx.run('DELETE FROM rejected WHERE row_id = ?', rowId);
    if (!isSyncedTable(r.tbl) || (await tx.get('SELECT 1 FROM outbox WHERE tbl = ? AND row_id = ?', r.tbl, rowId))) return;
    await tx.run(`DELETE FROM ${r.tbl} WHERE id = ?`, rowId);
    await tx.run("INSERT INTO meta (key, value) VALUES ('since', '0') ON CONFLICT(key) DO UPDATE SET value = excluded.value");
  });
  await dismiss();
}

export async function pullAll(db: Db, t: Transport, clock?: Clock): Promise<number> {
  let applied = 0;
  for (;;) {
    const meta = Object.fromEntries((await db.all('SELECT key, value FROM meta')).map((r) => [r.key, r.value]));
    // No stored access_version yet: -1 forces a reset on first pull.
    const page = await t.pull(Number(meta.since ?? 0), Number(meta.access_version ?? -1), Number(meta.schema_version ?? 0));
    if ('reset' in page) {
      const reset = db.transactionAsync(async (tx: Tx) => {
        // Unpushed local writes survive; the next push re-sends them and the server rejects what is no longer writable.
        // Parked rejections and their local rows stay until the user dismisses them.
        for (const tbl of SYNCED_TABLES) {
          await tx.run(`DELETE FROM ${tbl} WHERE id NOT IN (SELECT row_id FROM outbox WHERE tbl = ?) AND id NOT IN (SELECT row_id FROM rejected WHERE tbl = ?)`, tbl, tbl);
        }
        for (const [k, v] of [['since', 0], ['access_version', page.av], ['schema_version', page.sv]]) {
          await tx.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', k, String(v));
        }
      });
      await reset();
      continue;
    }
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
    async pull(since, av, sv) {
      const res = await fetch(`${base}/api/sync/pull?since=${since}&av=${av}&sv=${sv}`, { headers });
      if (!res.ok) throw new Error(`pull ${res.status}`);
      return res.json();
    },
  };
}
