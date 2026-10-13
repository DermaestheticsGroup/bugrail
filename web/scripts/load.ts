// G0.3: CLIENTS devices push+pull every INTERVAL_MS for DURATION_MS. G0.5: time each cold bootstrap.
import { connect } from '@tursodatabase/database';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import { httpTransport, localWrite, pullAll, pushOutbox } from '../lib/sync/client';
import type { Db } from '../lib/db-types';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const CLIENTS = Number(process.env.CLIENTS ?? 30);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 10_000);
const DURATION_MS = Number(process.env.DURATION_MS ?? 600_000);
const dir = mkdtempSync(join(tmpdir(), 'g0-load-'));

const cycles: number[] = [];
const bootstraps: number[] = [];
let errors = 0;

async function client(i: number) {
  const user = i === 0 ? 'vendor' : i % 2 ? 'alice' : 'admin';
  const t = httpTransport(BASE, user);
  const clock = createClock(`load-${i}`);
  const db = (await connect(join(dir, `c${i}.db`))) as unknown as Db;
  await applyMigrations(db, 'local');
  const b0 = performance.now();
  await pullAll(db, t, clock);
  bootstraps.push(performance.now() - b0);

  const fileId = user === 'vendor' ? 'file-0' : 'file-1'; // ws-v / ws-a in seed.ts
  const end = Date.now() + DURATION_MS;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS * (0.5 + Math.random())));
    try {
      const now = clock.now();
      await localWrite(db, 'bugs', { id: crypto.randomUUID(), file_id: fileId, title: `load ${i}`, status_code: 'OPEN', status_hlc: now, hlc: now });
      const c0 = performance.now();
      await pushOutbox(db, t);
      await pullAll(db, t, clock);
      cycles.push(performance.now() - c0);
    } catch (e) {
      errors += 1;
      console.error(`client ${i}:`, (e as Error).message);
    }
  }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? NaN;
await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
const report = {
  check: 'G0.3/G0.5', clients: CLIENTS, cycles: cycles.length, errors,
  p50ms: Math.round(pct(cycles, 0.5)), p95ms: Math.round(pct(cycles, 0.95)),
  bootstrapP95ms: Math.round(pct(bootstraps, 0.95)), bootstrapMaxms: Math.round(Math.max(...bootstraps)),
};
console.log(JSON.stringify(report));
process.exit(report.errors === 0 && report.p95ms < 1000 && report.bootstrapMaxms < 10_000 ? 0 : 1);
