'use client';
import { useEffect, useState } from 'react';
import { TABLES } from '@/db/tables';
import { mergeArgs, mergeSql } from '@/lib/lww';
import { applySchema } from '@/lib/schema';
import { httpTransport, pullAll } from '@/lib/sync/client';
import type { Db } from '@/lib/db-types';

type Line = [string, string];

async function open(name: string): Promise<Db> {
  const { connect } = await import('@tursodatabase/database-wasm/turbopack');
  return (await connect(name)) as unknown as Db;
}

async function wasmMergeCheck(): Promise<string> {
  const db = await open('selftest.db');
  await db.exec('DROP TABLE IF EXISTS bugs');
  await applySchema(db, ['schema']);
  const t = TABLES.bugs;
  const base = { id: 'b1', title: 't0', description: 'd0', status_code: 'OPEN', status_hlc: '000000000001000-00000-a', hlc: '000000000001000-00000-a' };
  await db.run(mergeSql(t), ...mergeArgs(t, base));
  await db.run(mergeSql(t), ...mergeArgs(t, { ...base, description: 'A', hlc: '000000000002000-00000-a' }));
  await db.run(mergeSql(t), ...mergeArgs(t, { ...base, status_code: 'RETEST', status_hlc: '000000000003000-00000-b' }));
  const old = await db.run(mergeSql(t), ...mergeArgs(t, { ...base, title: 'old', hlc: '000000000001500-00000-c' }));
  const row = await db.get("SELECT * FROM bugs WHERE id = 'b1'");
  const ok = row.description === 'A' && row.status_code === 'RETEST' && row.title === 't0' && old.changes === 0;
  return ok ? 'PASS' : `FAIL ${JSON.stringify(row)}`;
}

export default function OpfsCheck() {
  const [lines, setLines] = useState<Line[]>([]);
  const add = (k: string, v: string) => setLines((ls) => [...ls, [k, v]]);

  useEffect(() => {
    (async () => {
      add('userAgent', navigator.userAgent);
      add('crossOriginIsolated', String(globalThis.crossOriginIsolated));
      try {
        const db = await open('spike.db');
        await db.exec('CREATE TABLE IF NOT EXISTS boots (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT)');
        await db.run('INSERT INTO boots (at) VALUES (?)', new Date().toISOString());
        add('boots (reload: must grow)', String((await db.get('SELECT count(*) AS n FROM boots')).n));
      } catch (e) {
        add('opfs', `FAIL ${(e as Error).message}`);
      }
      add('persist', String(await navigator.storage?.persist?.()));
      try {
        add('wasmMerge (G0.2)', await wasmMergeCheck());
      } catch (e) {
        add('wasmMerge (G0.2)', `FAIL ${(e as Error).message}`);
      }
    })();
  }, []);

  async function bootstrap() {
    const name = `boot-${Date.now()}.db`;
    const db = await open(name);
    await applySchema(db, ['schema', 'local']);
    const t0 = performance.now();
    const rows = await pullAll(db, httpTransport(location.origin, 'admin'));
    add('bootstrapMs (G0.5 < 10000)', String(Math.round(performance.now() - t0)));
    add('bootstrapRows', String(rows));
  }

  return (
    <section>
      <button type="button" onClick={bootstrap}>Run full bootstrap</button>
      <pre data-testid="results">{lines.map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
    </section>
  );
}
