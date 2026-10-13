# BugRail → Next.js 16 + self-hosted Turso Sync, local-first, last-write-wins: Migration Plan v2

> Replaces v1 (`2026-10-13-nextjs-turso-local-first.md`). Cross-checked 2026-10-13 against commit `33e1e49`, the published type definitions of `@tursodatabase/sync-wasm@0.8.3` / `@tursodatabase/sync-common@0.8.3`, the Turso docs ([local sync server](https://docs.turso.tech/sync/local-sync-server), [sync usage](https://docs.turso.tech/sync/usage)), [turso PR #9025](https://github.com/tursodatabase/turso/pull/9025) and `next@16.4.0`.

## Direction

These are decisions. Phase 0 can overturn only the ones it tests.

1. **The browser holds the whole database.** Each device keeps a Turso DB in OPFS through `@tursodatabase/sync-wasm`, pinned to exactly `0.8.3` and imported from `@tursodatabase/sync-wasm/turbopack`. Every read and write is local.
2. **Self-hosted sync server.** It runs as `tursodb /var/lib/bugrail/server.db --sync-server 127.0.0.1:8080`, on the same pinned 0.8.x. It is reachable only through a Next.js route handler at `/sync/[...path]`, which checks the session first.
3. **Last write wins, by write time.** Native Turso Sync resolves conflicts as "last *push* wins", so a device that comes back online after 3 days would overwrite newer edits. Every synced row therefore carries an `hlc` (hybrid logical clock). The `transform` hook rewrites each pushed change into an upsert that applies only `WHERE excluded.hlc > row.hlc`. Status has its own clock, `status_hlc`.
4. **Nothing that can conflict is stored as an array.** Comments, status history and assignments become insert-only rows in `bug_events`. File sharing becomes `file_shares` rows. Deletes are tombstones (`deleted_at`). Bug status is stored by code, so renaming a status touches one row.
5. **The server owns identity.** Users, password hashes, roles, workspaces and the Gemini key live in a server-only `auth.db`. A sync agent inside the Next.js process mirrors the non-secret parts into the synced DB and assigns display codes.
6. **Security model, stated plainly.** Pull replicates the whole DB to every logged-in browser, and the sync server can't check per-row permissions. Logged-in users are trusted with all synced data. That is today's real exposure: every browser already downloads everything (`GET /api/kv`) and keeps it in localStorage (`utils.js:158`). The role matrix stays a UI guardrail plus an audit trail. If vendor QA must not see other workspaces, use fallback B.
7. **The data app is one client page.** Next.js serves the shell, auth, the sync proxy, AI routes and SSE. In-app navigation uses `history.pushState`, and a service worker caches the shell and the wasm, so a reload works offline.
8. **Gate G0 decides.** Ten pass/fail checks run before any feature work. One failure switches the plan to **fallback B**: our own push/pull routes on top of the same Turso DB files and schema, with the client code above `lib/repo` unchanged.

## Cross-check: what v1 got wrong

| # | v1 said | Verified | v2 does |
|---|---------|----------|---------|
| 1 | "Unverified whether self-hosted sync takes offline writes" | `tursodb --sync-server` speaks the same protocol as Turso Cloud. Push sends logical row changes, and offline writes queue locally until `push()`. The docs frame it as a dev/test tool with **no auth token**. It handles **one connection at a time**: PR #9025, which adds workers to `--sync-dir`, is still open and calls itself "local and development use" | It sits on `127.0.0.1` behind the session proxy. G0.8 load-tests it. Versions are pinned. The risk is owned in ADR-001 |
| 2 | "Conflict hook → LWW by our `hlc`" | The native rule is **last push wins**. `DatabaseOpts.transform(mutation)` can `skip` or `rewrite` each change before push (`sync-common/dist/types.d.ts`) | The `transform` emits an upsert guarded by `hlc` (see [LWW](#lww-the-whole-mechanism)) |
| 3 | "Pull filters rows per workspace" | Pull streams DB pages (`logicalMvccPull` defaults to WAL page streams). `partialSyncExperimental` is lazy bootstrap, not access control | Whole-DB replication, as Direction 6 states. Fallback B is the route to isolation |
| 4 | "Server re-checks every pushed row" | The proxy only sees opaque protocol bytes, and `transform` runs on the client | Explicit security model. The agent re-asserts server-owned tables every cycle |
| 5 | Codes come from a `counters` table | Test case code = `moduleAbbrev(module)-NNNN`, bug code = `BUG-NNNN`, both per workspace of the file, next = highest code in use + 1 (`utils.js:450-462`, `testcase.js:40-45`, `bugreport.js:48-52`) | The agent assigns codes with the same rule. The `code` column is first-non-null-wins |
| 6 | Attachments upload to the server through a queue | Attachments are newline-separated URLs (`utils.js:326-329`, `bugreport.js:949`) | No upload subsystem |
| 7 | Row-level LWW, column-level on status | Bugs embed `activity[]`, `comments[]` and `assignments[]` (`bugreport.js:331,557`, `auth.js:207`), so row LWW drops a concurrent comment. Status is stored by **name**, and a rename rewrites every bug (`masterstatus.js:126`), which under LWW clobbers concurrent status moves | `bug_events` insert-only, status by code, and status changes **don't** bump the row `hlc` |
| 8 | COOP/COEP "if the WASM build needs it" | It does: `setupMainThread` allocates `WebAssembly.Memory({ shared: true })` (`database-wasm-common`). The wasm is **12.8 MB**. Google Fonts are linked at `index.html:8` | COOP/COEP on every route, fonts through `next/font`, and the service worker caches the wasm |
| 9 | Nothing about loading the app offline | Without a cached shell, an offline reload shows the browser's error page | Service worker plus a single client page (Direction 7) |
| 10 | Client-side schema migrations via `PRAGMA user_version` | DDL on a replica vs. the server is unspecified for this protocol | Schema changes are made only on `server.db` with the sync server stopped. Clients pull them. Changes add columns only |
| 11 | "Load the DB in a Web Worker" | The package already starts its own OPFS worker (`index-default.js`: `new Worker(... 'turso-database-sync')`) | Nothing extra |
| 12 | `middleware.ts` | Next 16 renamed it `proxy.ts`; the docs say to verify auth in every Server Function too | `proxy.ts` handles page redirects; each route checks the session |
| 13 | Gemini key, theme | `geminiApiKey` sits in shared settings and every browser sends it (`settings.js:25`, `testforge.js:191`). `theme` is shared by all users (`app.js:280`) | The key goes to `auth.db` and never syncs. Theme is local |

## LWW: the whole mechanism

**Clock.** `lib/hlc.ts` builds a string `"<ms:15>-<counter:5>-<deviceId>"`, zero-padded so string order matches time order. `now()` = max(`Date.now()`, the highest hlc seen) plus a counter. `deviceId` = `crypto.randomUUID()`, kept in localStorage and also passed as `clientName`.

**Write rules in `lib/repo/*`** (the only code that writes the DB):
- Insert: new `id = crypto.randomUUID()` and `hlc = now()`.
- Edit any field except status: set the fields plus `hlc = now()` and `updated_by`.
- Change status: set `status_code`/`status` plus `status_hlc = now()` only. The row `hlc` stays put, so a concurrent description edit survives. Then insert a `bug_events` row.
- Delete: `deleted_at = now`, `hlc = now()`. Never `DELETE`.
- Comments, status history, assignments and the activity log are always `INSERT`.

**Push transform (`lib/local/lww.ts`)** decides per captured change:
- Server-owned tables (`workspaces`, `users_public`, `roles`) → `skip`.
- Any `delete` → `skip`.
- Insert-only tables → rewrite to `INSERT … ON CONFLICT(id) DO NOTHING`.
- Everything else → rewrite to the guarded upsert below, generated per table from its column list:

```sql
INSERT INTO bugs (id, title, …, status_code, status_hlc, code, hlc, deleted_at, updated_by)
VALUES (?, ?, …)
ON CONFLICT(id) DO UPDATE SET
  title       = CASE WHEN excluded.hlc > bugs.hlc THEN excluded.title ELSE bugs.title END,
  -- … same CASE for every plain column, deleted_at and updated_by included …
  status_code = CASE WHEN excluded.status_hlc > bugs.status_hlc THEN excluded.status_code ELSE bugs.status_code END,
  status_hlc  = MAX(bugs.status_hlc, excluded.status_hlc),
  code        = COALESCE(bugs.code, excluded.code),          -- assigned once by the agent, never cleared
  hlc         = MAX(bugs.hlc, excluded.hlc)
WHERE excluded.hlc > bugs.hlc OR excluded.status_hlc > bugs.status_hlc;
```

SQLite evaluates every `SET` against the pre-update row, so the `CASE`s compare old against incoming. Rows are keyed by `id`, never by `rowid`; the mutation's `id` field is a rowid, which differs between devices. **Schema rule:** synced tables have no `UNIQUE` (besides `id`), no `FOREIGN KEY` and no rejecting `CHECK`. A push must never fail on a constraint, or it blocks that device's queue.

**Clock guard.** The `/sync` proxy always returns a `Date` header. If the device clock differs by more than 5 minutes, the app shows a banner and blocks writes until it's fixed. Otherwise a fast clock would win every conflict.

## Schema

Synced (`server.db`, replicated to every device):

| Table | Columns (all TEXT unless noted) | Kind |
|-------|----------------------------------|------|
| `files` | `id, name, workspace_id, created_by, created_at, hlc, deleted_at, updated_by` | LWW |
| `file_shares` | `id = file_id||':'||workspace_id, file_id, workspace_id, hlc, deleted_at, updated_by` (unshare = tombstone) | LWW |
| `testcases` | `id, code, file_id, module, role_user, scenario, test_case, preconditions, steps, test_data, expected_result, type_test, status, status_hlc, actual_result, evidence, execution_date, custom_fields (JSON), created_by, created_at, extra (JSON), hlc, deleted_at, updated_by` | LWW + status clock |
| `bugs` | `id, code, file_id, test_case_id, title, module, severity, priority, status_code, status_hlc, description, steps, expected_result, actual_result, platform, environment, browser, device, build_version, attachments, tester, assignee, report_date, extra (JSON), hlc, deleted_at, updated_by` | LWW + status clock |
| `bug_events` | `id, bug_id, kind ('status'/'comment'/'assignment'), at, email, from_status, to_status, note, attachment, text, assignee` | insert-only |
| `bug_status_master` | `id (= code), name, color, sort_order INTEGER, hlc, deleted_at, updated_by` | LWW |
| `custom_field_defs` | `id, label, hlc, deleted_at, updated_by` (dedupe by label in the UI, no UNIQUE) | LWW |
| `activity_log` | `id, ts, actor_email, actor_role, workspace_id, action, label` | insert-only |
| `workspaces`, `users_public`, `roles` | mirrors of `auth.db` (`users_public` has no password field) | server-owned |

`extra` keeps any legacy field the mapping doesn't name, so the migration is lossless. Children of a tombstoned file are hidden by a join (`files.deleted_at IS NULL`), so deleting a file writes one row and undo clears one field.

Server-only (`auth.db`, opened by Next.js with `@tursodatabase/database`, never synced): `users(id, email, password_hash, role, workspace_ids, session_version, created_at)`, `roles`, `workspaces`, `secrets(key, value)`.

Local-only (localStorage): `deviceId`, last hlc, theme, notification seen-time (`notifications.js:60`, parity), and a `currentUser` snapshot for offline boot.

## Target layout

```
web/
├── next.config.ts            headers(): COOP same-origin + COEP require-corp on '/(.*)'
├── proxy.ts                  redirect anonymous loads of the shell to /login (pages only)
├── instrumentation.ts        starts the sync agent once per server process
├── public/sw.js              cache-first /_next/static/* (incl. wasm); navigation → network, fallback cached shell
├── app/
│   ├── login/page.tsx        online-only
│   ├── [[...path]]/page.tsx  THE data app: one client page, client router on history.pushState
│   ├── sync/[...path]/route.ts   requireUser → stream to 127.0.0.1:8080 → on push: live.broadcast()
│   └── api/ events/ testforge/generate/ bug/analyze/ admin/* (users, roles, workspaces, secrets → auth.db)
├── lib/
│   ├── local/db.ts           connect({ path:'bugrail.db', url: () => signedIn ? `${origin}/sync` : null, transform: lww, clientName: deviceId })
│   ├── local/lww.ts  hlc.ts  repo/*  useQuery.ts (re-runs on 'db-changed')
│   ├── server/auth.ts        iron-session + node:crypto scrypt + requireUser/requirePermission
│   ├── server/agent.ts       @tursodatabase/sync client: pull → assign codes → re-assert server-owned → push
│   ├── server/live.ts        SSE fan-out
│   └── domain/               pure ports from qa-app/js
└── scripts/ apply-schema.ts  migrate-kv-to-turso.ts  export-turso-to-kv.ts  backup.sh
```

## Steps

Each step has a check, and each phase ends in a gate.

### Phase 0: Spike and gate G0 (4–5 days)
- [ ] **T0.1** Install `tursodb` 0.8.x (the same minor as the npm packages) on a test box and record `tursodb --version` in ADR-001. Run `tursodb /tmp/server.db --sync-server 127.0.0.1:8080`.
- [ ] **T0.2** Build a throwaway `spike/` app on Next 16. Add the COOP/COEP headers in `next.config.ts`. A client page imports `connect` from `@tursodatabase/sync-wasm/turbopack`. Create one `bugs` table on the server with `scripts/apply-schema.ts` (`@tursodatabase/database`, sync server stopped).
- [ ] **T0.3** Write `lww.ts` and `hlc.ts`, plus a Node harness running 2–3 `@tursodatabase/sync` clients on local files, to script the scenarios below.
- [ ] **T0.4** Write the `/sync/[...path]` proxy route. It forwards method, headers and body (`fetch(…, { body: req.body, duplex: 'half' })`) and returns 401 without a session. Record the actual push and pull paths here.
- [ ] **T0.5** Load script: 30 Node clients, each doing push and pull every 10 s for 10 min, on a copy sized like prod (`db.kv_store.stats()` gives the size).
- [ ] **T0.6** Service worker in the spike: load once online, go offline, reload.
- [ ] **T0.7** Run G0 and write `docs/adr/ADR-001-sync-transport.md`: native or fallback B.

| Gate G0 check | Pass when |
|---------------|-----------|
| G0.1 Offline write | A edits offline, reconnects, `push()`; the server has A's rows |
| G0.2 True LWW | A edits bug X offline at t1. B edits X at t2 > t1 and pushes. A pushes later. The server keeps B's value |
| G0.3 Concurrent inserts | A and B insert different rows offline; both survive on the server and on both devices |
| G0.4 Rebase by id | A has an unpushed edit and pulls. The edit lands on the right row (by `id`) and pushes after |
| G0.5 Status clock | A changes status while B edits the description of the same bug; both survive |
| G0.6 UPSERT | The Turso DB server executes `INSERT … ON CONFLICT(id) DO UPDATE … WHERE` and `DO NOTHING` |
| G0.7 Proxy | Sync works through `/sync` with the cookie and gets 401 without it. Port 8080 is unreachable from another host |
| G0.8 Load | 30 clients for 10 min: p95 push+pull < 1 s, 0 errors. Cold bootstrap of a prod-size DB < 10 s |
| G0.9 Browser | The Next 16 build runs in current Chrome, Edge, Firefox and Safari: the DB opens, survives a reload, and `navigator.storage.persist()` is granted |
| G0.10 Schema + offline shell | A column added on the server reaches clients by pull while their pending writes still push. An offline reload opens the app from the SW cache |

### Phase 1: Scaffold and schema (2–3 days)
- [ ] **T1.1** `npx create-next-app@16 web --typescript --app --no-tailwind --no-src-dir --import-alias "@/*" --use-npm`. Pin `@tursodatabase/sync-wasm@0.8.3` exactly (no caret). Copy `qa-app/css/style.css` to `app/globals.css`, load fonts with `next/font/google`, and add the COOP/COEP headers.
- [ ] **T1.2** Write `db/schema/001_init.sql` from the table above, plus `scripts/apply-schema.ts`, which refuses to run while `bugrail-sync` is active.
- [ ] **T1.3** Write `lib/local/db.ts`, `hlc.ts`, `lww.ts` and `repo/*` following the write rules. `useQuery(sql, params)` re-runs on a `db-changed` event.
- **Gate G1:** `npm run build` passes. Repo tests against an in-memory `@tursodatabase/database` pass.

### Phase 2: Domain logic (2–3 days)
- [ ] **T2.1** Port the same pure modules as Mongo plan M2.1 into `lib/domain/`. Status comparisons switch from names to codes; there are 24 sites that compare `'Closed'`/`'Reopened'`.
- [ ] **T2.2** Port the 8 `.check.js` files to Vitest (Mongo plan M2.2).
- [ ] **T2.3** `hlc.test.ts`: monotonic, total order, and two devices never equal. `lww.test.ts`: a seeded random loop of 1000 interleaved edits, applied to two DB copies in different orders, converges to identical rows.
- **Gate G2:** `npm test` is green.

### Phase 3: Server side (3–4 days)
- [ ] **T3.1** Create the `auth.db` schema and `lib/server/auth.ts`: iron-session cookie `{userId, sessionVersion}`, 7 days; scrypt; `requireUser`. Add `login`/`logout` with rate-limited login. The client stores a `currentUser` snapshot for offline boot.
- [ ] **T3.2** `proxy.ts`: redirect anonymous loads of `/` and the shell paths to `/login`. Exclude `/sync`, `/api` and static files.
- [ ] **T3.3** The production `/sync/[...path]` proxy from T0.4. After a successful push it calls `live.broadcast()`, and every response carries a `Date` header.
- [ ] **T3.4** `lib/server/agent.ts`, started from `instrumentation.ts`, using `@tursodatabase/sync@0.8.3` with its replica at `/var/lib/bugrail/agent.db`. Every 10 s, and right after each proxied push:
  1. Pull.
  2. Assign codes to rows where `code IS NULL AND deleted_at IS NULL`. Scope = workspace of the file; prefix = `moduleAbbrev(module)` or `BUG`; next = max + 1 (`IdGen.nextInScope`). The write is `UPDATE … SET code=? WHERE id=? AND code IS NULL`, and the agent's `transform` passes code-only updates through as that same statement.
  3. Re-assert `workspaces`, `users_public` and `roles` from `auth.db`.
  4. Push.
- [ ] **T3.5** `/api/events` SSE, with the same headers as the Mongo plan M6.2.
- [ ] **T3.6** Admin route handlers write `auth.db`: users (create, reset = hash plus `session_version++`), roles and permissions, workspaces, and the Gemini key. The agent mirrors them on its next cycle.
- [ ] **T3.7** AI routes: port `/api/testforge/generate` and `/api/bug/analyze` (`server/app.js:218-383`) with `requireUser()`, reading the key from `auth.db` or env.
- **Gate G3:** the T0.3 harness passes against the real proxy and agent. New bugs get codes within 15 s. A tampered `roles` row on a client is overwritten within one cycle.

### Phase 4: Data migration (2–3 days)
- [ ] **T4.1** `scripts/migrate-kv-to-turso.ts` (Node 24 runs `.ts` directly) reads Mongo `kv_store` and writes a fresh `server.db` and `auth.db` while the sync server is stopped. Mapping:
  - Normalize the same fields as the Mongo plan inventory.
  - Status names → codes. Unknown names, such as legacy `'Reopened'` in activity, get master rows with codes from the `masterstatus.js` rule.
  - `activity[]`, `comments[]` and `assignments[]` → `bug_events`. `sharedWith[]` → `file_shares`.
  - Unmapped fields → `extra`.
  - Every `hlc` = one migration HLC with deviceId `migrate`. Existing codes are kept.
- [ ] **T4.2** `scripts/export-turso-to-kv.ts` is the reverse, for rollback. Codes go back to names, events go back into embedded arrays, and passwords follow the Mongo plan M3.3 rule.
- [ ] **T4.3** Rehearse on a prod dump: migrate, export, diff.
- **Gate G4:** row counts match the blobs. For each bug, timeline events = `activity.length + comments.length + assignments.length`. Codes are identical. The diff is empty except for normalized fields.

### Phase 5: Client shell and offline (3–4 days)
- [ ] **T5.1** `app/[[...path]]/page.tsx` plus `lib/nav.ts`, a small path → screen map on `history.pushState`. Workspace in the path (`/w/<id>/…`) replaces sessionStorage. Shims: `#bug=<id>` and `?rptModule&rptRound` (parity).
- [ ] **T5.2** Login gate, workspace picker (2+ workspaces), nav permissions from the local `roles`/`users_public`, toasts, dialogs and shortcuts (same sources as Mongo plan M4.4).
- [ ] **T5.3** `public/sw.js` plus registration (G0.10 rules). Call `navigator.storage.persist()` after login.
- [ ] **T5.4** Sync badge: online, offline, or N pending (`stats().cdcOperations`), plus the last pull time. While online, push 1 s after the last write.
- [ ] **T5.5** Live refresh: SSE → 500 ms debounce → `pull()`, plus pull on `online`, on `visibilitychange`, and every 30 s. Don't use `longPollTimeoutMs`: a held pull would block the single-connection server. Then emit `db-changed`; screens re-query, deferred while busy (`isUserBusy` port, `app.js:197-205`).
- **Gate G5:** create bugs offline, go online, and codes appear within 15 s. An offline reload opens the app.

### Phase 6: Feature parity (11–14 days)
- [ ] **T6.1** Same feature list and sources as Mongo plan M5.1–M5.9. Screens read and write through `lib/repo` instead of Server Actions. Excel import inserts locally, and codes come from the agent.
- [ ] **T6.2** Online-only, with a clear "needs connection" state: login, user, role and workspace admin, TestForge, Analyze, backup and restore.
- **Gate G6:** a QA lead ticks `docs/parity-checklist.md` with 2 online browsers and 1 device that goes offline mid-session.

### Phase 7: Cutover (2 days, then 2 weeks of watching)
- [ ] **T7.1** systemd units: `bugrail-sync` runs `tursodb /var/lib/bugrail/server.db --sync-server 127.0.0.1:8080`; `bugrail` runs `npm run start -- -p 3001` in `web/`. In `deploy.yml`: `npm ci && npm run build`, then restart both.
- [ ] **T7.2** Nightly backup (`scripts/backup.sh` on a systemd timer at 02:00): stop `bugrail-sync`, copy `server.db*` and `auth.db*`, start it again. Clients just retry.
- [ ] **T7.3** Runbook:
  1. Announce a freeze.
  2. Stop the old `bugrail`.
  3. `mongodump`.
  4. `migrate-kv-to-turso.ts`.
  5. Start `bugrail-sync` and the new `bugrail`.
  6. Smoke test with 2 browsers plus 1 offline device.
  7. Lift the freeze.
- [ ] **T7.4** Rollback (first 48 h): stop both, run `export-turso-to-kv.ts`, start the old `server/`.
- [ ] **T7.5** After 2 weeks stable: retire MongoDB after a final dump.

**Estimate:** 29–38 dev days. Add 5–7 if G0 picks fallback B.

## Fallback B (only if G0 fails)

The same schema, `hlc` rules, repo modules and screens. Only the transport changes:
- **Browser:** `@tursodatabase/database-wasm` (same OPFS and COOP/COEP) plus an `outbox` table filled by `lib/repo`.
- **Server:** `@tursodatabase/database` opens `server.db` inside Next.js. No `tursodb` process.
- **`POST /api/sync/push {rows}`:** per row, it checks permission (the `validateFilesWrite`/`validateBugsWrite` rules), applies the same guarded upsert, assigns codes, and returns accepted/rejected ids.
- **`GET /api/sync/pull?since=<seq>`:** returns rows with `server_seq > since`, filtered by the user's visible workspaces (`WorkspaceCalc`). This is real isolation.

## Risks

| Risk | Mitigation |
|------|-----------|
| `tursodb --sync-server` is positioned for dev/test, serves one connection at a time and has no auth | Localhost bind, session proxy, G0.8 load gate, nightly backup, ADR-001 sign-off. Fallback B removes the process |
| Pre-1.0 protocol drift | Exact pins on both sides. Upgrade client and server together, after re-running the G0 harness |
| A malicious logged-in user can push any row | Activity log audit, server-owned tables re-asserted, fallback B if that's unacceptable |
| OPFS eviction loses unpushed writes | `storage.persist()`, push 1 s after each write while online, pending count in the badge |
| 12.8 MB wasm on first load | Cached by the service worker; one-time per device |
| COOP/COEP blocks cross-origin embeds | There are none today. Fonts are self-hosted, and plain links (attachments, the translate call in `utils.js:922` via CORS) are unaffected |

## Done when
- G0 is recorded in ADR-001, and all of G1–G6 passed.
- Offline: create and edit test cases and bugs, reconnect, and every row is on the server with codes assigned.
- Two devices editing the same bug offline converge to identical rows. A status move survives a concurrent description edit, and two concurrent comments both remain.
- `KvMerge`, `rev`, `qa_unsynced_v2` and the `x-role` headers are gone. The Gemini key never reaches a browser.
