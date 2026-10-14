// Nightly server.db backup: VACUUM INTO a dated copy, open the copy to check it, then prune old copies.
// Runs under plain Node (production has no Bun requirement): node scripts/backup.mjs
// Env: BUGRAIL_DB_PATH (default /var/lib/bugrail/server.db), BACKUP_DIR (default /var/backups/bugrail), BACKUP_KEEP_DAYS (default 14).
import { connect } from '@tursodatabase/database';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const src = process.env.BUGRAIL_DB_PATH ?? '/var/lib/bugrail/server.db';
const dir = process.env.BACKUP_DIR ?? '/var/backups/bugrail';
const keepDays = Number(process.env.BACKUP_KEEP_DAYS ?? 14);
if (!existsSync(src)) { console.error(`backup: source not found: ${src}`); process.exit(1); }
mkdirSync(dir, { recursive: true });

const day = new Date().toISOString().slice(0, 10).replaceAll('-', '');
const final = join(dir, `server-${day}.db`);
// One partial per invocation (a manual run while the timer fires must not delete the other's file); never a half-written file under a name the prune or a restore would trust.
const tmp = `${final}.${process.pid}.partial`;
const clean = () => { for (const f of [tmp, `${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true }); };
clean();

const live = await connect(src, { readonly: true });
try {
  await live.exec(`VACUUM INTO '${tmp.replaceAll("'", "''")}'`);
} catch (e) {
  clean();
  console.error(`backup: VACUUM INTO failed, partial removed: ${e.message}`);
  process.exit(1);
} finally { await live.close?.(); }

const copy = await connect(tmp, { readonly: true });
let counts;
try {
  const check = await (await copy.prepare('PRAGMA integrity_check')).get();
  if (Object.values(check ?? {})[0] !== 'ok') throw new Error(`integrity_check: ${JSON.stringify(check)}`);
  counts = {};
  for (const t of ['files', 'bugs', 'bug_events']) counts[t] = (await (await copy.prepare(`SELECT count(*) AS n FROM ${t}`)).get()).n;
} catch (e) {
  clean();
  console.error(`backup: copy failed verification, removed: ${e.message}`);
  process.exit(1);
} finally { await copy.close?.(); }
// The check above opened the copy, which can leave journal sidecars; a clean close has folded them in.
for (const f of [`${tmp}-wal`, `${tmp}-shm`]) rmSync(f, { force: true });

renameSync(tmp, final);
// Today's file is replaced on a re-run; only dated copies older than the window go.
const cutoff = Date.now() - keepDays * 86_400_000;
// Partials left by a crashed run (own pid is gone) are removed after a day.
for (const f of readdirSync(dir)) if (/\.partial(-wal|-shm)?$/.test(f) && statSync(join(dir, f)).mtimeMs < Date.now() - 86_400_000) rmSync(join(dir, f), { force: true });
const pruned = readdirSync(dir).filter((f) => /^server-\d{8}\.db$/.test(f) && statSync(join(dir, f)).mtimeMs < cutoff);
for (const f of pruned) rmSync(join(dir, f));
console.log(JSON.stringify({ backup: final, counts, pruned }));
