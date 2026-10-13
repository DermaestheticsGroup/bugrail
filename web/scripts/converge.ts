// G0.8 over HTTP: 3 devices make random offline edits, sync in random order, and must converge.
import { connect } from '@tursodatabase/database';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { httpTransport, localWrite, pullAll, pushOutbox } from '../lib/sync/client';
import type { Db } from '../lib/db-types';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const ROUNDS = Number(process.env.ROUNDS ?? 300);
let seed = Number(process.env.SEED ?? 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const dir = mkdtempSync(join(tmpdir(), 'g0-converge-'));
const names = ['alice', 'bob', 'admin'] as const;
const devices: { name: string; db: Db; clock: ReturnType<typeof createClock> }[] = [];
for (const name of names) {
  const db = (await connect(join(dir, `${name}.db`))) as unknown as Db;
  await applyMigrations(db, 'local');
  devices.push({ name, db, clock: createClock(`dev-${name}`) });
}
const t = (name: string) => httpTransport(BASE, name);

const fileId = `f-${crypto.randomUUID()}`;
const a = devices[0];
await localWrite(a.db, 'files', { id: fileId, name: 'converge', workspace_id: 'ws-a', hlc: a.clock.now() });
const bugIds = Array.from({ length: 5 }, () => crypto.randomUUID());
for (const id of bugIds) {
  const now = a.clock.now();
  await localWrite(a.db, 'bugs', { id, file_id: fileId, title: 'seed', status_code: 'OPEN', status_hlc: now, hlc: now });
}
await pushOutbox(a.db, t(a.name));
for (const d of devices) await pullAll(d.db, t(d.name), d.clock);

for (let i = 0; i < ROUNDS; i++) {
  const d = pick(devices);
  const id = pick(bugIds);
  const r = rand();
  if (r < 0.15) {
    await pushOutbox(d.db, t(d.name));
    await pullAll(d.db, t(d.name), d.clock);
    continue;
  }
  const cur = await d.db.get('SELECT * FROM bugs WHERE id = ?', id);
  if (r < 0.5) await localWrite(d.db, 'bugs', { ...cur, title: `${d.name}-${i}`, hlc: d.clock.now() });
  else if (r < 0.75) await localWrite(d.db, 'bugs', { ...cur, status_code: pick(['OPEN', 'RETEST', 'CLOSED']), status_hlc: d.clock.now() });
  else await localWrite(d.db, 'bug_events', { id: crypto.randomUUID(), bug_id: id, kind: 'comment', at: new Date().toISOString(), text: `${d.name}-${i}` });
}

for (let pass = 0; pass < 2; pass++) {
  for (const d of devices) {
    while (await pushOutbox(d.db, t(d.name))) { /* drain */ }
    await pullAll(d.db, t(d.name), d.clock);
  }
}

const dump = async (db: Db) => JSON.stringify({
  bugs: await db.all(`SELECT id, code, title, status_code, status_hlc, hlc, deleted_at FROM bugs WHERE file_id = ? ORDER BY id`, fileId),
  events: await db.all(`SELECT id, text FROM bug_events WHERE bug_id IN (SELECT id FROM bugs WHERE file_id = ?) ORDER BY id`, fileId),
});
const dumps = await Promise.all(devices.map((d) => dump(d.db)));
const ok = dumps.every((x) => x === dumps[0]);
const coded = JSON.parse(dumps[0]).bugs.every((b: { code: string | null }) => /^BUG-\d{4,}$/.test(String(b.code)));
console.log(JSON.stringify({ check: 'G0.8', rounds: ROUNDS, converged: ok, allCoded: coded }));
process.exit(ok && coded ? 0 : 1);
