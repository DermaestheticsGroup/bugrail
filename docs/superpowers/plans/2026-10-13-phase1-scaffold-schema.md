# Phase 1 Scaffold + Schema Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Promote the G0 spike into the real `web/` app (scaffold, full schema, hardened sync core) and close the sync gaps G0 found, so Phase 2 can build domain ports on it.

**Architecture:** `git mv spike web`, then replace stand-ins with real units named in the spec. Sync core (`hlc`, `lww`, `sync/server`, `sync/client`) is kept and extended, not rewritten. Production runs `next start` under Node 24; Bun is the local install/script/test tool.

**Tech Stack:** Next 16.4.0 (pinned), React 19, `@tursodatabase/database@0.8.3`, `@tursodatabase/database-wasm@0.8.3` (exact pins), Bun (dev tooling), Node 24 LTS (production).

**Spec:** `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (G1 scaffold gate; sections Data model, LWW, Sync protocol). Evidence: `spike/G0-NOTES.md`, `docs/adr/ADR-001` "Known gaps carried into Phase 1", `docs/adr/ADR-004-bun-runtime.md`.

## Global Constraints

- Both Turso packages pinned exactly `0.8.3`, no caret. `next` pinned exactly `16.4.0`.
- Production runtime Node 24 (`node node_modules/next/dist/bin/next start`). Bun only for `bun install`, `bun run`, `bun test`. Every script and test must also pass under Node where it does not use `bun:test`.
- Synced tables have no `UNIQUE` (besides the key), `FOREIGN KEY`, `CHECK`, `NOT NULL`, so a sync write never fails on a constraint.
- HLC format `<ms:15>-<counter:5>-<deviceId>`; status clock `status_hlc`; `code = COALESCE(old, new)`; deletes are tombstones; `bug_events` insert-only.
- Server schema changes are additive only.
- `qa-app/` and `server/` are untouched; `deploy.yml` keeps deploying them until Phase 7.
- Engine quirk: Turso 0.8.3 rejects an aggregate in `ORDER BY`; alias it.
- Docs updated in the same task as the behavior they describe (README, ADRs, spec).
- Every commit pushed to `feat/phase1-local-first-foundation`; never force-push.

## Review Focus

- Pull with a stale `av`: client past the visibility change must lose rows it can no longer see, and keep unpushed local writes.
- Push rejected rows: the client must keep or surface them, never silently drop the write.
- Two live `file_shares` rows for the same file and workspace pair (id not equal to `file_id:workspace_id`).
- Bug un-delete, or delete of the top-numbered bug, then a new bug: display code must not repeat a code still referenced.
- Concurrent pushes on one server connection: no duplicate `server_seq`.
- `hlc.observe` with a malformed or far-future HLC from a pulled row must not poison the local clock.

## File Structure

- `web/` (from `spike/`): `app/`, `lib/`, `db/`, `scripts/`, `test/`, `public/`, `package.json`, `next.config.ts`.
- `web/db/schema/001_core.sql`, `002_server.sql`, `003_local.sql` plus `web/db/migrate.ts`: versioned schema files and the runner.
- `docs/spike-g0/`: `G0-NOTES.md` and `g06-screens/` moved out of the app.
- `.github/workflows/web-ci.yml`: Bun install, Node 24 build and test.

---

### Task 1: Promote spike to web/

**Files:**
- Move: `spike/` -> `web/`; `web/G0-NOTES.md`, `web/g06-screens/` -> `docs/spike-g0/`
- Delete: `web/app/api/spike/`, `web/app/opfs/`, `web/app/other/`, `web/lib/sync/users.ts` stand-in header auth is replaced in Step 3
- Modify: `web/package.json`, `web/app/page.tsx`, `README.md`, `docs/adr/ADR-001-self-hosted-turso-own-sync.md` (path references), `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (none unless it names `spike/`)

**Interfaces:**
- Produces: `web/` app root; `bun run build`, `bun test`, `bun run start` (Node).

- [ ] **Step 1: Move and prune**

```bash
git mv spike web
mkdir -p docs/spike-g0
git mv web/G0-NOTES.md web/g06-screens docs/spike-g0/
git rm -r web/app/api/spike web/app/opfs web/app/other
```

- [ ] **Step 2: package.json.** Name `bugrail-web`; add `"engines": {"node": ">=24"}`, `"packageManager": "bun@<installed bun version>"`; `"start": "node node_modules/next/dist/bin/next start -p 3001"`; keep `dev` on port 3001 too; `"test": "bun test"`; add `"typecheck": "tsc --noEmit"`. Add `web/.node-version` containing `24`.

- [ ] **Step 3: Keep `users.ts` and `x-spike-user` for now**, but rename the header to `x-dev-user` and gate `userFromHeader` so it returns `undefined` unless `process.env.NODE_ENV !== 'production'`. Add a test in `web/test/users.test.ts`: with `NODE_ENV=production`, `userFromHeader('admin')` is `undefined`. (Phase 3 replaces this with iron-session.) Update both route handlers and `httpTransport` to the new header name.

- [ ] **Step 4: Fix path references.** `grep -rn "spike/" README.md docs --include=*.md` and repoint to `docs/spike-g0/` or `web/`. README "Migration in progress" gets a Quick Start for `web/`: `bun install`, `bun run dev`, `bun test`, and the line "Production runs Node 24; Bun is for local development only."

- [ ] **Step 5: Verify**

Run (in `web/`): `bun install && bun run typecheck && bun test && bun run build`
Expected: typecheck clean, all tests PASS, build succeeds.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "chore(web): promote G0 spike to web/, gate dev auth to non-production" && git push -u origin feat/phase1-local-first-foundation
```

### Task 2: Runtime split (Node 24 production, Bun local) and CI

**Files:**
- Create: `.github/workflows/web-ci.yml`
- Modify: `docs/adr/ADR-004-bun-runtime.md`, `README.md`, `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (D8 and the deploy bullet: state Node 24 production, Bun local)

**Interfaces:**
- Consumes: Task 1 scripts.
- Produces: CI job `web` that proves the same code builds and tests under both runtimes.

- [ ] **Step 1: Workflow.** Trigger on pull_request and push to `main` for paths `web/**`. Steps: `actions/checkout`, `actions/setup-node` with `node-version: 24`, `oven-sh/setup-bun`, then in `web/`: `bun install --frozen-lockfile`, `bun run typecheck`, `bun test`, `bun run build`, then a Node smoke: `node scripts/converge.ts` is not runnable on Node; instead run `node --experimental-strip-types scripts/smoke-node.ts` (create it: open an in-memory `@tursodatabase/database`, `applySchema`, push one row, pull it back, assert it round-trips, exit 1 on failure).

- [ ] **Step 2: Write `web/scripts/smoke-node.ts` and run it locally** with `node --experimental-strip-types scripts/smoke-node.ts`. Expected: prints `ok`, exit 0. If Node 24 rejects the TS import specifiers, add `.ts` extensions only in this script's imports.

- [ ] **Step 3: Docs.** ADR-004 Consequences: CI runs install and tests under Bun and a Node 24 smoke; systemd `ExecStart` is the `node …/next start` line; note the measured reason (p95 107 ms vs 57 ms). README: add a "Runtime" paragraph.

- [ ] **Step 4: Verify and commit**

Run: `bun run typecheck && bun test && node --experimental-strip-types scripts/smoke-node.ts` in `web/`.
Expected: green.

```bash
git add -A && git commit -m "ci(web): Bun for install/test, Node 24 for build and smoke; ADR-004 consequences" && git push
```

### Task 3: Full schema, migration runner, table metadata

**Files:**
- Create: `web/db/schema/001_core.sql`, `002_server.sql`, `003_local.sql`, `web/db/migrate.ts`, `web/test/schema.test.ts`
- Modify: `web/db/tables.ts`, `web/db/sql.ts` (remove, replaced by files), `web/lib/schema.ts`, `web/lib/server-db.ts`

**Interfaces:**
- Produces: `applyMigrations(db, scope: 'server' | 'local'): Promise<number>` returns the applied schema version; `TABLES` includes every synced table in the spec's Data model: `files, file_shares, testcases, bugs, bug_events, bug_status_master, custom_field_defs, activity_log` (kinds per spec: `testcases` and `bugs` are `lww+status`; `bug_events`, `activity_log` insert-only; others `lww`). `SyncedTable` union updated to match.

- [ ] **Step 1: Failing test.** `schema.test.ts`: for each `TABLES` entry, create an in-memory DB, `applyMigrations(db, 'server')`, then `PRAGMA table_info(<name>)` and assert the column names equal `TABLES[name].columns` as a set; assert `applyMigrations` twice is idempotent and returns the same version; assert `sync_meta.schema_version` equals the highest file number.

- [ ] **Step 2: Run, expect FAIL** (`bun test test/schema.test.ts`).

- [ ] **Step 3: Write the SQL files.** Columns exactly as the spec's Data model table (all TEXT unless listed INTEGER; `server_seq INTEGER`; `sort_order INTEGER`). `001_core.sql` holds synced tables plus `server_seq` indexes and the `bugs_file`, `bug_events_bug`, `testcases_file` indexes. `002_server.sql`: `users(id TEXT PRIMARY KEY, email, role, password_hash, session_version INTEGER, access_version INTEGER, created_at)`, `secrets`, `sync_meta` with `seq` and `schema_version`. `003_local.sql`: `outbox`, `meta`. `activity_log` columns: `id, actor_email, action, target_type, target_id, detail, at, server_seq`.

- [ ] **Step 4: Runner.** `applyMigrations` reads the files for its scope in numeric order (server: 001+002, local: 001+003), runs each `IF NOT EXISTS` script, and writes `schema_version` into `sync_meta` (server) or `meta` (local). Import the SQL as strings via a `?raw`-free approach: keep each file's SQL as an exported template string in a sibling `.ts` generated at build time is out of scope; instead read with `node:fs` on the server and, for the browser, `import sql from './schema/001_core.sql'` is not available, so export the strings from `web/db/schema/index.ts` and keep the `.sql` files as the checked source verified equal by a test (parse both, compare the table-name sets).

- [ ] **Step 5: Wire `server-db.ts` and tests** to `applyMigrations`; keep existing tests green.

- [ ] **Step 6: Verify and commit**

Run: `bun test && bun run build`. Expected: all PASS.

```bash
git add -A && git commit -m "feat(web): full synced schema, versioned migration runner, table metadata" && git push
```

### Task 4: Visibility changes reach clients (access_version reset) — gap (a)

**Files:**
- Modify: `web/lib/sync/server.ts`, `web/lib/sync/client.ts`, `web/app/api/sync/pull/route.ts`, `web/lib/sync/users.ts`
- Test: `web/test/sync-reset.test.ts`

**Interfaces:**
- Produces: `bumpAccess(db, userId): Promise<number>`; `pull(db, user, since, av, sv, limit?)` returns `PullResult` that may be `{ reset: true, av, sv }`; `pullAll` handles reset; client `meta` keys `access_version`, `schema_version`. Server keeps `access_version` per user in `users.access_version` (insert the dev users at startup in non-production).

- [ ] **Step 1: Failing tests.** (1) alice pulls, admin moves a file out of `ws-a`, `bumpAccess(alice)`; alice's next `pullAll` ends with that file and its bugs gone from her local DB. (2) alice has an unpushed local bug in the outbox when the reset happens; after `pullAll` the bug is still in her local DB and its outbox entry is still there, and a following `pushOutbox` delivers it. (3) matching `av` never returns `reset`. (4) `sv` behind returns `reset`.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** Server `pull`: read user's `access_version` and server `schema_version`; if `av !== current` or `sv < schema`, return `{ reset: true, av: current, sv: schema }` (no rows). Client `pullAll`: on `reset`, in one transaction delete from every synced table every row whose `(tbl, id)` is not in `outbox`, set `since = 0`, store the new `access_version` and `schema_version`, then continue pulling. `bumpAccess` runs on the server wherever a visibility change is accepted: a push that moves a file or changes `file_shares` bumps `access_version` for every user whose `workspaceIds` include the old or new workspace (for the dev user table, iterate `USERS`).

- [ ] **Step 4: Run, expect PASS**, then `bun test` for the whole suite.

- [ ] **Step 5: Docs.** ADR-001 Known gaps: mark (a) closed with the commit hash placeholder filled in after commit; spec Sync protocol already describes `reset`, add one line that unpushed rows are kept.

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "feat(sync): access_version and schema_version reset on pull, keep unpushed rows" && git push
```

### Task 5: Rejected pushes are retained and surfaced — no-mistakes review-1

**Files:**
- Modify: `web/lib/sync/client.ts`, `web/db/schema/003_local.sql`
- Test: `web/test/sync-rejected.test.ts`

**Interfaces:**
- Consumes: `PushResult.rejected: { id: string; reason: string }[]`.
- Produces: local table `rejected(row_id TEXT PRIMARY KEY, tbl TEXT, reason TEXT, at TEXT)`; `pushOutbox` removes outbox entries only for accepted ids and ids it did not send; `listRejected(db)`, `dismissRejected(db, rowId)`.

- [ ] **Step 1: Failing tests.** (1) vendor locally writes a bug into a file it cannot see; `pushOutbox` returns it in `rejected`; afterwards the outbox entry is gone **and** a `rejected` row with the reason exists, so the write is visible to the UI instead of lost. (2) A transient failure (transport throws) leaves the outbox untouched. (3) `dismissRejected` clears the row and deletes the local copy of an insert that was never accepted.

- [ ] **Step 2: Run, expect FAIL.**

- [ ] **Step 3: Implement.** In `settle`, build `rejectedIds` from `result.rejected`; for each, insert into `rejected` (upsert) and still clear its outbox entry (a rejected write must not retry forever); for accepted and unsent entries delete as before. `dismissRejected` deletes the `rejected` row and, if the server never returned that id, the local row.

- [ ] **Step 4: Run, expect PASS; full `bun test`.**

- [ ] **Step 5: Docs.** ADR-001: note decision "rejected writes are parked in `rejected`, UI toast lands in Phase 5."

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "fix(sync): park rejected pushes instead of dropping them" && git push
```

### Task 6: Remaining sync gaps (b, c, e, f) with tests

**Files:**
- Modify: `web/lib/sync/server.ts`, `web/lib/hlc.ts`, `web/lib/id-gen.ts` (only if needed)
- Test: `web/test/sync-gaps.test.ts`, extend `web/test/hlc.test.ts`

- [ ] **Step 1: Failing tests, one per gap.**
  - (b) create BUG-0001 and BUG-0002 in `ws-a`, tombstone BUG-0002, push a new bug (gets BUG-0002), then un-delete the old BUG-0002 by pushing it with `deleted_at = null` and a newer HLC: assert two live bugs never share a code (the revived bug keeps its code, the code assignment pass must skip codes held by any live row; if both live, the later-assigned bug gets the next free code).
  - (c) pushing a `file_shares` row whose `id !== file_id + ':' + workspace_id` is rejected with reason `bad share id`.
  - (e) fire 10 concurrent `push()` calls on one shared connection with disjoint rows; assert all `server_seq` values are distinct and the `sync_meta.seq` equals the number of changed rows. If it fails, serialize pushes with an in-process promise queue in `push`.
  - (f) `observe()` ignores malformed strings and any HLC more than 24 h ahead of `wall()`; the next `now()` still returns near `wall()`.

- [ ] **Step 2: Run, expect FAIL for each gap that is real**, record which are not reproducible in `docs/spike-g0/G0-NOTES.md` as "not reproducible, test kept".

- [ ] **Step 3: Implement the fixes** minimally in the files above. For (b), have `nextInScope` callers pass codes of all rows with `code IS NOT NULL` regardless of `deleted_at` when the candidate row is being revived; document why in a one-line comment.

- [ ] **Step 4: Run, expect PASS; full `bun test`.**

- [ ] **Step 5: Docs.** ADR-001 Known gaps: mark (b), (c), (e), (f) closed; (d) closed by Task 3 (activity_log has table metadata, its push rule is `actor_email == user.email`, add that rule and a test here: pushing an `activity_log` row with a different actor email is rejected as `actor mismatch`).

- [ ] **Step 6: Commit and push**

```bash
git add -A && git commit -m "fix(sync): close ADR-001 gaps b-f with tests" && git push
```

### Task 7: G1 gate, docs, and Phase 2 hand-off

**Files:**
- Modify: `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (Phases section: Phase 1 done), `docs/adr/ADR-001`, `README.md`
- Create: `docs/superpowers/plans/` note listing Phase 2 inputs in `docs/spike-g0/PHASE1-RESULT.md`

- [ ] **Step 1: Run the G1 gate** in `web/`: `bun run typecheck && bun test && bun run build`, plus `node --experimental-strip-types scripts/smoke-node.ts`, plus `bun scripts/converge.ts` (3 seeds, all PASS). Paste the final lines of each into `docs/spike-g0/PHASE1-RESULT.md`.

- [ ] **Step 2: Record what Phase 1 did not close:** Safari/Firefox/Edge runs, production-sized G0.3/G0.5 re-runs, the 30-concurrent-bootstrap time (about 20 s), offline soft navigation (G0.6). Each with its owning phase (5 for client shell and offline, cutover rehearsal for sizes).

- [ ] **Step 3: Commit and push**

```bash
git add -A && git commit -m "docs: Phase 1 G1 result and carry-over list" && git push
```
