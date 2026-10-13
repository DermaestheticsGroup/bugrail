# BugRail → Next.js 16, local-first on self-hosted Turso: Design

- **Status:** Design approved in conversation 2026-10-13; written spec awaiting review. Implementation starts with Phase 0 (gate G0).
- **Supersedes:** `specs/2026-08-11-bugrail-next-migration-design.md` (Postgres/Prisma, never built) and the four plans in `docs/migration-plan/` (Mongo v1/v2, Turso v1/v2). The Turso v2 plan is the main source; this spec keeps its schema, clock and write rules and replaces its transport.
- **Decisions:** [ADR-001](../../adr/ADR-001-self-hosted-turso-own-sync.md) transport, [ADR-002](../../adr/ADR-002-lww-by-hlc.md) conflicts, [ADR-003](../../adr/ADR-003-workspace-isolation.md) isolation, [ADR-004](../../adr/ADR-004-bun-runtime.md) runtime (Proposed until G0).
- **Cross-checked against:** commit `33e1e49`, `@tursodatabase/database@0.8.3`, `@tursodatabase/database-wasm@0.8.3`, `next@16.4.0` docs (backend-for-frontend, instant navigation, offline support, `useOffline`).

## Goal

Replace `qa-app/` (vanilla JS on localStorage blobs) and `server/` (Express on MongoDB `kv_store`) with one Next.js 16 app that:

1. Feels instant. Every read and write hits a database in the browser; the network is a sync target, never something the UI waits on.
2. Works offline. A user can create and edit test cases and bugs with no connection, reload the app, and have everything sync when the connection returns.
3. Isolates workspaces. An account given to a vendor sees only the workspaces it belongs to, plus files explicitly shared into them. Nothing else ever reaches that browser.
4. Runs fully self-hosted on the existing VM. No Turso Cloud, no Vercel, no third-party sync service.
5. Migrates all existing data with nothing dropped, and keeps strict feature parity with today.

### Success criteria

- Two devices editing the same bug offline converge to identical rows. A status move survives a concurrent description edit, and two concurrent comments both remain.
- A vendor account, inspected in DevTools (OPFS contents and every `/api/sync/pull` response), contains no row from a workspace it isn't in.
- Offline: create test cases and bugs, reload the page, reconnect; every row reaches the server and gets a display code.
- Every row of `docs/parity-checklist.md` is ticked on a copy of production data.
- `KvMerge`, `rev`, `qa_unsynced_v2` and the `x-role`/`x-workspace`/`x-can-share` headers are gone. The Gemini key never reaches a browser.

## Decisions (fixed for this spec)

| # | Decision |
|---|----------|
| D1 | One Next.js 16 App Router app in `web/`, TypeScript, used as the full backend (route handlers) and the frontend. It replaces both `qa-app/` and `server/`. |
| D2 | Server database: one file, `/var/lib/bugrail/server.db`, opened in-process with `@tursodatabase/database` (embedded Turso engine, MIT). No `tursodb` process, no Turso Cloud. |
| D3 | Browser database: `bugrail.db` in OPFS through `@tursodatabase/database-wasm`, holding only the rows the user may see. Both packages are pinned to exactly `0.8.3` (no caret). |
| D4 | Sync is our own protocol: `POST /api/sync/push` and `GET /api/sync/pull`. Native Turso Sync is not used, because it replicates the whole DB with no row filtering (ADR-001). |
| D5 | Conflicts resolve by write time (hybrid logical clock), never by arrival order. Status has its own clock (ADR-002). |
| D6 | Nothing that can conflict is stored as an array. Comments, status history and assignments are insert-only `bug_events` rows; sharing is `file_shares` rows; deletes are tombstones. |
| D7 | Visibility and write permission are enforced on the server, per row, on every pull and push (ADR-003). |
| D8 | Bun installs packages and runs scripts and tests. Production runs Node 24; Bun is local tooling only (G0.4 p95 107 ms vs 57 ms, ADR-004). |
| D9 | Parity only. `qa-app/css/style.css` becomes the global stylesheet with the same class names. No Tailwind, no UI kit, no new features. |
| D10 | Big-bang cutover with a write freeze, and a 48-hour rollback path back to MongoDB. |

## Architecture

```
Browser (per device)                                 VM (/opt/qa-monitor, port 3001)
┌───────────────────────────────────────┐           ┌──────────────────────────────────────────┐
│ App Router pages (static shells)       │           │ Next.js 16 process (bugrail.service)     │
│   └─ client screens ── useQuery ─┐     │           │                                          │
│ lib/repo/* ── writes ────────────┤     │           │  /api/sync/push ─┐                        │
│        │                          ▼     │  HTTPS    │  /api/sync/pull ─┼─ lib/sync/server.ts ─┐ │
│        └─ outbox ──► lib/sync/client.ts ├──────────►│  /api/events (SSE) ◄─ lib/server/live.ts │ │
│                bugrail.db (OPFS, wasm)  │◄──────────│  /api/auth/*, /api/admin/*, AI routes    │ │
│ service worker: shell, static, wasm     │           │                                        ▼ │
└───────────────────────────────────────┘           │   server.db (@tursodatabase/database)    │
                                                     └──────────────────────────────────────────┘
```

### Units

| Unit | Does | Depends on |
|------|------|-----------|
| `lib/hlc.ts` | `now()`, `observe(hlc)`. Shared by browser and server. | nothing |
| `lib/lww.ts` | Builds the guarded upsert for a table from its column list (see LWW). Shared by browser and server, so both sides apply the same merge. | table metadata in `db/tables.ts` |
| `db/schema/NNN_*.sql`, `db/tables.ts` | Schema and per-table metadata (kind: `lww`, `lww+status`, `insert-only`, `server`). | nothing |
| `lib/local/db.ts` | Opens OPFS DB, runs local schema migrations, exposes `query`/`exec`, emits `db-changed`. | `@tursodatabase/database-wasm` |
| `lib/repo/*` | The only code that writes the browser DB. Applies the write rules and appends to `outbox` in the same transaction. One module per table. | `local/db`, `hlc`, `lww` |
| `lib/local/useQuery.ts` | `useQuery(sql, params)`; re-runs on `db-changed`. | `local/db` |
| `lib/sync/client.ts` | Push loop, pull loop, reset handling, sync badge state, clock guard. | `local/db`, `lww`, `fetch` |
| `lib/sync/server.ts` | `pull(user, since, av)` and `push(user, rows)`: visibility filter, permission check, guarded upsert, code assignment, `server_seq`. | `server/db`, `domain/*`, `lww` |
| `lib/server/db.ts` | Opens `server.db` once per process, applies pending schema files at startup. | `@tursodatabase/database` |
| `lib/server/auth.ts` | iron-session, scrypt, `requireUser`, `requirePermission`, `visibleWorkspaceIds`, `bumpAccess`. | `server/db`, `iron-session` |
| `lib/server/live.ts` | In-process SSE fan-out keyed by workspace. | nothing |
| `lib/domain/*` | Pure ports from `qa-app/js`: `IdGen`, `moduleAbbrev`, `BUG_FORM`, `TC_IMPORT`, `ReportCalc`, `NotifCalc`, `WorkspaceCalc`, `can()`, permission keys, status transition rules. | nothing |

Each unit is testable alone: `hlc`, `lww` and `domain` are pure; `sync/server` runs against an in-memory `@tursodatabase/database`; `repo` runs against the same engine in Node.

### Target layout

```
web/
├── next.config.ts            cacheComponents, partialPrefetching, experimental.useOffline; headers(): COOP same-origin + COEP require-corp on '/(.*)'
├── proxy.ts                  redirects anonymous page loads to /login (pages only; excludes /api, static files)
├── instrumentation.ts        opens server.db and applies schema once per process
├── public/sw.js              cache-first /_next/static/* (incl. wasm); navigations network-first, fall back to cached shell
├── app/
│   ├── login/page.tsx        online-only
│   ├── page.tsx              legacy shims: #bug=<id> → bug route; ?rptModule&rptRound → report
│   ├── w/[ws]/…              data screens (static shells + client components); ws = workspace id or "__all__" (admin)
│   └── api/ sync/push  sync/pull  events  auth/*  admin/*  testforge/generate  bug/analyze  backup/*
├── db/ schema/*.sql  tables.ts
├── lib/ hlc.ts  lww.ts  local/  repo/  sync/  server/  domain/
└── scripts/ migrate-kv-to-turso.ts  export-turso-to-kv.ts  backup.sh
```

## Data model

All IDs are `TEXT` UUIDs (existing ids are kept as-is). Every synced table has `server_seq INTEGER`, set by the server on each accepted write and never by the client.

### Synced tables (exist on server and in the browser)

| Table | Columns (TEXT unless noted) | Kind |
|-------|----------------------------|------|
| `files` | `id, name, workspace_id, created_by, created_at, hlc, deleted_at, updated_by, server_seq` | LWW |
| `file_shares` | `id = file_id||':'||workspace_id, file_id, workspace_id, hlc, deleted_at, updated_by, server_seq` (unshare = tombstone) | LWW |
| `testcases` | `id, code, file_id, module, role_user, scenario, test_case, preconditions, steps, test_data, expected_result, type_test, status, status_hlc, actual_result, evidence, execution_date, custom_fields (JSON), created_by, created_at, extra (JSON), hlc, deleted_at, updated_by, server_seq` | LWW + status clock |
| `bugs` | `id, code, file_id, test_case_id, title, module, severity, priority, status_code, status_hlc, description, steps, expected_result, actual_result, platform, environment, browser, device, build_version, attachments, tester, assignee, report_date, extra (JSON), hlc, deleted_at, updated_by, server_seq` | LWW + status clock |
| `bug_events` | `id, bug_id, kind ('status'/'comment'/'assignment'), at, email, from_status, to_status, note, attachment, text, assignee, server_seq` | insert-only |
| `bug_status_master` | `id (= code), name, color, sort_order INTEGER, hlc, deleted_at, updated_by, server_seq` | LWW |
| `custom_field_defs` | `id, label, hlc, deleted_at, updated_by, server_seq` (dedupe by label in the UI) | LWW |
| `activity_log` | `id, ts, actor_email, actor_role, workspace_id, action, label, server_seq` | insert-only |
| `workspaces` | `id, name, created_at, server_seq` | server-owned |
| `users` | browser copy has only `id, email, name, role, workspace_ids (JSON), server_seq` | server-owned |
| `roles` | `id, name, permissions (JSON), server_seq` | server-owned |

`extra` keeps any legacy field the mapping doesn't name, so the migration is lossless. Children of a tombstoned file are hidden by a join on `files.deleted_at IS NULL`, so deleting a file writes one row and undo clears one field.

**Schema rule:** synced tables have no `UNIQUE` (besides the primary key), no `FOREIGN KEY` and no rejecting `CHECK`. A row must never fail on a constraint during push or pull, or it blocks that device's queue. Validation happens in `lib/domain` and the push permission check instead.

### Server-only (same `server.db` file, never sent to a browser)

- `users` server columns: `password_hash, session_version INTEGER, access_version INTEGER, created_at`. The pull query projects only the browser columns listed above.
- `secrets(key, value)`: the Gemini key (admin can set it; `GEMINI_API_KEY` env is the fallback).
- `sync_meta(key, value)`: the `server_seq` counter and `schema_version`.
- Login rate-limit state lives in memory, as today.

### Browser-only

- `outbox(seq INTEGER PRIMARY KEY, tbl, row_id)` in OPFS.
- `meta(key, value)`: pull cursor `since`, `access_version`, `schema_version`, owner `user_id`.
- localStorage: `deviceId`, last HLC, theme, notification seen-time (`notifications.js:60`, parity), and a `currentUser` snapshot for offline boot.

### Schema changes

Server schema files are additive (add tables or columns only) and applied by `instrumentation.ts` at startup. The browser applies the same files to its own DB. Because the browser DB is ours (not a protocol replica), local DDL is safe. When the server's `schema_version` is newer than the client's, the pull answers `reset` (see Sync protocol) after the new app version is loaded.

## LWW: the whole mechanism

**Clock.** `lib/hlc.ts` builds `"<ms:15>-<counter:5>-<deviceId>"`, zero-padded so string order matches time order. `now()` = max(`Date.now()`, highest HLC seen) plus a counter. `deviceId = crypto.randomUUID()`, kept in localStorage. Every pulled row passes through `observe()` so the local clock never lags the data.

**Write rules in `lib/repo/*`:**

- Insert: `id = crypto.randomUUID()`, `hlc = now()`, `code = NULL` (the server assigns codes).
- Edit any field except status: set the fields plus `hlc = now()` and `updated_by`.
- Change status: set `status_code`/`status` plus `status_hlc = now()` only. The row `hlc` stays put, so a concurrent description edit survives. Then insert a `bug_events` row.
- Delete: `deleted_at = now`, `hlc = now()`. Never `DELETE`.
- Comments, status history, assignments and the activity log are always `INSERT`.
- Every write appends `(tbl, row_id)` to `outbox` in the same transaction.

**Merge (`lib/lww.ts`).** One generated statement per LWW table, used by the server on push and by the browser on pull:

```sql
INSERT INTO bugs (id, title, …, status_code, status_hlc, code, hlc, deleted_at, updated_by, server_seq)
VALUES (?, ?, …)
ON CONFLICT(id) DO UPDATE SET
  title       = CASE WHEN excluded.hlc > bugs.hlc THEN excluded.title ELSE bugs.title END,
  -- … same CASE for every plain column, deleted_at and updated_by included …
  status_code = CASE WHEN excluded.status_hlc > bugs.status_hlc THEN excluded.status_code ELSE bugs.status_code END,
  status_hlc  = MAX(bugs.status_hlc, excluded.status_hlc),
  code        = COALESCE(bugs.code, excluded.code),
  hlc         = MAX(bugs.hlc, excluded.hlc),
  server_seq  = excluded.server_seq
WHERE excluded.hlc > bugs.hlc OR excluded.status_hlc > bugs.status_hlc OR (bugs.code IS NULL AND excluded.code IS NOT NULL);
```

SQLite semantics evaluate every `SET` against the pre-update row, so each `CASE` compares old against incoming. Insert-only tables use `INSERT … ON CONFLICT(id) DO NOTHING`. Server-owned tables arrive only by pull and are applied as plain upserts.

On pull the browser runs this same statement, so a pulled row can't overwrite an unpushed local edit with a newer HLC. The local edit stays in the outbox and wins on the server too.

**Clock guard.** Every `/api/*` response carries a `Date` header. If the device clock differs from it by more than 5 minutes, the app shows a banner and blocks writes until the clock is fixed; otherwise a fast clock would win every conflict.

## Sync protocol

### Push: `POST /api/sync/push`

Body: `{ rows: [{ tbl, row }] }`, where `row` is the current local row for each distinct `(tbl, row_id)` in the outbox (multiple edits to one row coalesce into one entry), at most 500 per request.

The server, in one write transaction:

1. `requireUser()`; 401 if the session is missing or its `session_version` is stale.
2. For each row, run the permission check (below). A failed row goes to `rejected` with a reason and is not applied.
3. Ignore any client-supplied `server_seq`, and any client `code` on insert.
4. Apply the guarded upsert (or `DO NOTHING` for insert-only), and set `server_seq = ++seq` if the row changed.
5. Assign display codes to any row with `code IS NULL AND deleted_at IS NULL`: scope = the owning workspace of the row's file; prefix = `moduleAbbrev(module)` for test cases and `BUG` for bugs; next = `IdGen.nextInScope(prefix, codes of non-tombstoned rows in scope)` (`utils.js:450-462`, same rule as today, so deleting rows frees numbers).
6. Respond `{ accepted: [id], rejected: [{ id, reason }], server: [row] }`, where `server` holds the server's current row for every pushed id whose stored values differ from what was sent (the server won, or a code was assigned).
7. After commit, `live.broadcast(workspaceIds touched)`.

The client applies `server` rows through the merge, removes accepted and rejected ids from the outbox, reverts rejected rows to the server's version (or deletes a rejected local-only insert), and shows one toast per rejected batch with the reason.

**Permission check** (ports `validateFilesWrite`/`validateBugsWrite`, `server/app.js:64-167`, plus the role matrix via `can()`):

| Table | Allowed when |
|-------|-------------|
| `files` insert | `workspace_id` is one of the user's workspaces and `can(testcase_create)` or `can(bugreport_fileCreate)` (both screens create files today: `testcase.js:151`, `bugreport.js:148`) |
| `files` update/tombstone | file's current `workspace_id` is one of the user's workspaces; changing `workspace_id` is admin-only |
| `file_shares` | user's workspaces include the file's owner workspace, and `can(testcase_fileShare)` |
| `testcases` | file is visible to the user, and `testcase_create`/`_update`/`_delete` matches the change |
| `bugs` | file is visible, and `bugreport_create`/`_update`/`_delete`; a status-or-priority-only change also passes with `bugreport_updateStatusPriority`; status transitions re-checked with the ported `statusTransitionRule` |
| `bug_events` | parent bug is visible |
| `activity_log` | `actor_email` equals the session user's email |
| `bug_status_master`, `custom_field_defs` | `can(master)` / `can(settings)` |
| `workspaces`, `users`, `roles` | never via push; admin routes only |

Admin (`role = 'admin'`) passes every check, as today.

### Pull: `GET /api/sync/pull?since=<seq>&av=<access_version>&sv=<schema_version>`

1. `requireUser()`.
2. If `av` differs from the user's `access_version`, or `sv` is behind, respond `{ reset: true }`. The client wipes its synced tables (keeping the outbox), sets `since = 0`, and pulls again. It then re-pushes the outbox; rows the user can no longer write are rejected as above. Unpushed rows (any row still in the outbox) and their outbox entries survive the wipe.
3. Otherwise return `{ rows: [{ tbl, row }], next, more, av }`: visible rows with `server_seq > since`, ordered by `server_seq`, at most 2000 per page. The client loops while `more`.

`access_version` is bumped for every affected user whenever visibility can change: a user's `workspace_ids` change, a `file_shares` row is created or tombstoned (users of that workspace), a file's `workspace_id` changes (users of the old and new workspace), or a backup is restored (everyone). Gaining and losing access both trigger a reset, because newly visible rows may have a `server_seq` below the client's cursor. Losing access also deletes the now-invisible rows from OPFS, which is how revocation reaches the device.

### When the client syncs

- Push 1 s after the last local write while online, and on reconnect.
- Pull on an SSE `sync` event (500 ms debounce), on `online`, on `visibilitychange` to visible, and every 30 s.
- After a pull applies rows, emit `db-changed`. Screens re-query, deferred while the user is busy (port of `isUserBusy`, `app.js:197-205`).
- Sync badge: online/offline, pending count (`SELECT count(*) FROM outbox`), last successful pull time.

## Auth and workspace isolation

**Session.** iron-session cookie `bugrail_session = {userId, sessionVersion}`, httpOnly, `sameSite: lax`, 7 days. Passwords use `node:crypto` scrypt with a 16-byte salt and `timingSafeEqual`. Login is rate-limited per IP. `requireUser()` runs in every route handler; `proxy.ts` only redirects anonymous page loads. Resetting a password or removing a user bumps `session_version`, which ends their sessions.

**Visibility.** For user `u` with workspace set `W` (admin: all):

| Table | Rows `u` receives |
|-------|------------------|
| `files` | `workspace_id ∈ W`, or a live `file_shares` row for the file with `workspace_id ∈ W` |
| `testcases`, `bugs` | rows whose file is visible |
| `bug_events` | rows whose bug is visible |
| `file_shares` | rows with `workspace_id ∈ W`, plus every share of files owned by `W` |
| `activity_log` | `workspace_id ∈ W` |
| `workspaces` | ids in `W`; users with `testcase_fileShare` also receive the `id, name` of all workspaces, to pick share targets |
| `users` | users sharing at least one workspace with `u`, with `workspace_ids` cut to the intersection |
| `roles`, `bug_status_master`, `custom_field_defs` | all rows (global, non-secret config) |

A vendor account is a normal user whose `workspace_ids` is just the vendor's workspace and whose role has the permissions the admin chooses. It therefore sees that workspace's files and files shared into it, and nothing else.

**Offline boot (render first, authenticate second).** If OPFS has data and the localStorage `currentUser` snapshot exists, the app renders immediately and calls `/api/auth/me` in the background. A 401 sends the user to `/login`; the outbox stays in OPFS and pushes after the same user logs in again. If a **different** user logs in on the device, the local DB is wiped; if the outbox still holds unpushed rows, the login screen warns first and offers to cancel.

**Server-only data.** Password hashes, session versions, access versions and `secrets` are never selected into a pull. AI routes read the Gemini key from `secrets` or `GEMINI_API_KEY`; the request body no longer carries it.

## Client

- **Routes.** Real App Router routes under `/w/[ws]/` (dashboard, summary, report, activity, import-export, testcases, testcases/[fileId], bugs, bugs/[fileId], bugs/[fileId]/board, bugs/[fileId]/[bugId], settings, master/status, users, roles, workspaces), matching today's pages (`app.js:118-131`). The workspace lives in the path, replacing sessionStorage. Shims keep `#bug=<id>` and `?rptModule&rptRound` links working.
- **Instant navigation.** `cacheComponents` and `partialPrefetching` make each route a static App Shell that `<Link>` prefetches. Data comes from client components reading OPFS through `useQuery`, so there is no server data fetch to wait on.
- **Offline.** `experimental.useOffline` keeps soft navigations and online-only actions pending while offline, and its `useOffline()` hook drives the offline indicator. `public/sw.js` covers what `useOffline` can't: a full reload while offline is served from the cached shell, with `/_next/static/*` and the wasm cache-first. `navigator.storage.persist()` is requested after login.
- **Headers.** COOP `same-origin` and COEP `require-corp` on every route (the wasm build uses shared memory). Fonts load through `next/font`, replacing the Google Fonts link at `index.html:8`.
- **Online-only features** show a clear "needs connection" state: login, user/role/workspace admin, TestForge, Analyze, backup and restore.
- **Live refresh.** `/api/events` SSE (`force-dynamic`, `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`, 25 s ping) carries only `sync` pokes for the user's workspaces; the data itself always comes through pull.
- **Excel import** inserts rows locally through `lib/repo`; codes arrive from the server on the next push. `xlsx` comes from the SheetJS 0.20.3 tarball (the npm `0.18.5` has CVE-2023-30533 and CVE-2024-22363).

## Migration of existing data

`scripts/migrate-kv-to-turso.ts` reads MongoDB `kv_store` (read-only) and writes a fresh `server.db` while the app is stopped. **Every record migrates; nothing is dropped.**

- Field normalization follows the Mongo v2 inventory: `status 'Not Run' → 'Open'`, `priority Highest/Critical → Urgent`.
- Status names → codes. Unknown names (for example legacy `'Reopened'` in activity) get master rows with codes from the `masterstatus.js` rule.
- `activity[]`, `comments[]` and `assignments[]` → `bug_events`. `sharedWith[]` → `file_shares`.
- Unmapped fields → `extra`. Existing ids and codes are kept, including legacy duplicate codes (reported, not renumbered).
- Settings split: `users` (plaintext passwords → scrypt hashes), `workspaces`, `roles` with `rolePermissions`, `bug_status_master`, `custom_field_defs`, Gemini key → `secrets`. `theme` becomes local-only.
- **Files with no `workspaceId`** (visible to everyone today, `workspace.js:73`) move into a new **"Internal"** workspace. Every non-vendor user is added to it, so internal staff keep seeing those files and vendors don't. The report lists every moved file so an admin can re-home or share it.
- Every `hlc` is one migration HLC with deviceId `migrate`; every row gets a `server_seq`.
- The script prints a report: counts per table, duplicate codes per scope, files moved to Internal, users hashed.

`scripts/export-turso-to-kv.ts` is the reverse for rollback: codes back to names, events back into embedded arrays, Internal files back to no workspace. Users who existed at cutover get their old plaintext password back from `kv_store.qa_settings` (untouched until MongoDB is retired); users created after cutover get a temporary password printed for the admin.

**Gate:** on a restored production dump, migrate then export and diff against the original blobs. Row counts match. For each bug, timeline events = `activity.length + comments.length + assignments.length`. Codes are identical. The diff is empty except for normalized fields, Internal assignment and passwords. Every migrated user can log in with their old password.

## Operations

- **Service.** systemd `bugrail` runs the app from `/opt/qa-monitor/web` on port 3001 (`node node_modules/next/dist/bin/next start`, Node 24, per ADR-004). `server.db` lives in `/var/lib/bugrail/`.
- **Deploy.** `.github/workflows/deploy.yml`: `bun install --frozen-lockfile && bun run build`, then `systemctl restart bugrail`. Clients pick up the new version through the service worker update.
- **Backup.** systemd timer at 02:00 runs `scripts/backup.sh`: `VACUUM INTO '/var/backups/bugrail/server-YYYYMMDD.db'`, kept 14 days. G0 confirms the engine supports it; otherwise the script briefly stops the service and copies `server.db*`.
- **Env.** `SESSION_PASSWORD` (32+ chars), `GEMINI_API_KEY`, `GEMINI_MODEL`, `TESTFORGE_ENABLED`, `BUGRAIL_DB_PATH`.

## Testing

All tests run with `bun test`.

- **Domain:** port the 8 `qa-app/test/*.check.js` files that test pure logic (`storage.check.js` is dropped with `Storage`).
- **Clock and merge:** `hlc.test.ts` (monotonic, total order, two devices never equal). `lww.test.ts`: a seeded random loop of 1000 interleaved edits applied to two DB copies in different orders converges to identical rows.
- **Sync server** against an in-memory DB: push/pull round trips, code assignment, rejected rows, `access_version` reset.
- **Isolation:** a vendor user's pull never contains another workspace's rows; a vendor push to another workspace's file is rejected; unsharing a file removes it from the vendor's local DB after the next pull.
- **Convergence harness:** 3 Node clients (`@tursodatabase/database` + `lib/sync/client`) doing random offline edits against the real routes converge.

## Gates

| Gate | Pass when |
|------|-----------|
| **G0** spike (before any feature work) | G0.1 `@tursodatabase/database-wasm@0.8.3` opens an OPFS DB, survives reload and gets `storage.persist()` in current Chrome, Edge, Firefox and Safari behind our COOP/COEP headers. G0.2 Both engines run the guarded upsert, `DO NOTHING` and `MAX()` exactly as specified. G0.3 30 simulated clients push and pull every 10 s for 10 min on a production-sized DB: p95 < 1 s, 0 errors. G0.4 Bun runs `next build`, `next start` and the native binding (decides ADR-004). G0.5 Cold full pull of a production-sized DB < 10 s. G0.6 Offline reload opens the app from the SW, and soft navigation between prefetched shells works offline. G0.7 The backup method produces an openable copy while the app is writing. G0.8 The convergence harness passes the v2 scenarios: offline write, true LWW, concurrent inserts, status clock. |
| G1 scaffold | `bun run build` passes; repo tests pass on an in-memory DB. |
| G2 domain | `bun test` green. |
| G3 server | Harness passes against the real routes; new bugs get codes on push; isolation tests pass. |
| G4 migration | Migration gate above. |
| G5 client | Create bugs offline, reload offline, go online: codes appear within one push. |
| G6 parity | A QA lead ticks `docs/parity-checklist.md` with 2 online browsers, 1 device going offline mid-session, and 1 vendor account. |

**If G0 fails:** G0.1 failing in one non-Chromium browser lists that browser as unsupported in ADR-001; failing in Chrome or Edge stops the plan for redesign. G0.3 or G0.7 failing on the server engine switches the server to `bun:sqlite`/`node:sqlite` with the same SQL and schema. G0.4 failing keeps Bun for tooling and runs Node 24 in production.

## Phases

0 spike and G0 → 1 scaffold and schema → 2 domain ports → 3 server (auth, sync, admin, AI, SSE) → 4 data migration → 5 client shell and offline → 6 feature parity → 7 cutover. Each phase ends in its gate. Rough size, carried from the v2 estimate plus the own-sync work: 32–42 dev days. Implementation plans are written per phase, starting with Phase 0.

**Cutover runbook:** announce a freeze → stop the old `bugrail` → `mongodump` → run the migration → start the new `bugrail` → smoke test with 2 browsers, 1 offline device and 1 vendor account → lift the freeze. Rollback within 48 h: stop, run the export, start the old `server/`. After 2 stable weeks: final `mongodump`, then retire MongoDB, `qa-app/` and `server/`.

## Risks

| Risk | Mitigation |
|------|-----------|
| Turso engine and wasm build are pre-1.0 | Exact pins on both sides; G0.2/G0.3; `bun:sqlite`/`node:sqlite` fallback on the server keeps the same SQL |
| We own the sync protocol | Small surface (two routes, one merge function shared by both sides), convergence property test, harness gate |
| OPFS eviction loses unpushed writes | `storage.persist()`, push 1 s after each write, pending count in the badge |
| Data already on a device after access is revoked | Removed on the next pull (reset); a device that never reconnects keeps its copy. Revoke the session (`session_version`) for departing vendors. |
| A permitted user writes bad data in their own workspace | Same as today: activity log audit, server-side permission and transition checks |
| Device clock skew | HLC plus the 5-minute clock guard |
| 12.8 MB wasm on first load | Cached by the service worker, once per device |
| `cacheComponents`, `partialPrefetching`, `useOffline` are experimental | Pinned `next` version; the service worker and local DB carry offline even if these flags change |
| COOP/COEP blocks cross-origin embeds | None today; attachments are plain links, fonts are self-hosted |

## Out of scope

New features, a visual redesign, per-row access below the file level, mobile apps, multi-server deployment, and Turso Cloud or Vercel hosting.
