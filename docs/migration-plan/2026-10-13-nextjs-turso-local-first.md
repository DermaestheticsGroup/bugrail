> **Superseded** (2026-10-13) by [`docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md`](../superpowers/specs/2026-10-13-bugrail-local-first-design.md). Kept for history.

# BugRail → Next.js + Turso (self-hosted sync), local-first, LWW — Migration Plan

## Goal

One Next.js app. Each browser holds a full local Turso/SQLite database (OPFS, via WASM). Reads and writes hit the local DB with zero network. A self-hosted sync server merges changes **row-by-row with last-write-wins (LWW)**. MongoDB is retired. Offline is a real mode here: today's localStorage fallback (`Storage.offlineBoot`) refuses to write to the server at all.

## Why this fits BugRail

Today's `Storage` already pretends to be local-first: synchronous `cache`, writes to localStorage first, background `PUT`, `qa_unsynced_v2` replay, `KvMerge` 3-way merge. It breaks because the unit of sync is a **whole key blob**. Turso + LWW moves the unit of sync to **one row (or one column)**, so most of that machinery can be deleted.

## Target architecture

```
browser (per device)                          VM (self-hosted)
┌──────────────────────────────┐             ┌────────────────────────────────┐
│ Next.js client components    │             │ Next.js server (route handlers)│
│  └ lib/local/db.ts           │  push/pull  │  ├ /api/auth/*  session, bcrypt │
│     @tursodatabase/sync      │◀──────────▶ │  ├ /api/sync/*  authz gate      │
│     (WASM, OPFS file)        │   HTTPS     │  ├ /api/testforge, /api/bug/... │
│  └ lib/repo/* (SQL, sync API)│             │  └ /api/events  SSE "pull now"  │
└──────────────────────────────┘             │ Turso sync server  (primary DB) │
                                             └────────────────────────────────┘
```

- **Local:** `@tursodatabase/sync` (browser/WASM build) opens `bugrail.db` in OPFS. All UI reads/writes go to it through `lib/repo/*`.
- **Server:** a self-hosted Turso sync server holds the primary DB. The Next.js server sits **in front** of it as an auth + authorization gate. Clients never reach the sync server directly.
- **Realtime:** `/api/events` SSE only says "something changed" and the client calls `pull()`. Today's SSE carries `{key, rev}`; this is the same idea with a smaller payload.

### Phase 0 spike (blocking): confirm self-hosted sync
Not verified yet: whether the self-hosted Turso server supports **bidirectional** offline sync (push of local writes) or only embedded-replica style reads (`sqld` / libsql-server: local reads, writes forwarded to the primary, so no offline writes). Spike, 2 days:
1. Run the Turso sync server on the VM (container), push/pull from `@tursodatabase/sync` in a browser, kill the network, write, reconnect, check the merge.
2. Check the conflict hook. We need LWW by our own `hlc` column, not by arrival order.

**Fallback if the spike fails:** keep Turso/SQLite on both sides but own the protocol: `POST /api/sync/push` (rows changed since the last push), `GET /api/sync/pull?since=<server_seq>`. The server applies LWW in SQL (below). ~4 extra days. Same schema, same client code above `lib/repo`.

## LWW model

Every synced table carries:

| Column | Purpose |
|--------|---------|
| `id TEXT PRIMARY KEY` | UUIDv7, created on the device. No server round-trip needed |
| `hlc TEXT NOT NULL` | Hybrid logical clock `"<ms>-<counter>-<nodeId>"`, zero-padded so string compare == causal order |
| `node_id TEXT` | Device id (tie-break is already inside `hlc`) |
| `deleted_at TEXT` | Tombstone. Rows are never hard-deleted while any device may be offline |
| `updated_by TEXT` | User email, for the activity log + audit |

Merge rule (server and client, same SQL):
```sql
INSERT INTO bugs (...) VALUES (...)
ON CONFLICT(id) DO UPDATE SET ... = excluded....
WHERE excluded.hlc > bugs.hlc;
```

**Granularity decision:** row-level LWW by default. Two fields are hot enough to deserve column-level LWW (separate `*_hlc` column): `bugs.status` (board drag-drop vs a tester editing description) and `testcases.status` (execution vs editing steps). Without it, one user's edit silently drops the other's status move.

**Clock skew:** HLC takes `max(local wall clock, highest hlc seen) + 1`, so a device with a wrong clock can't win forever after it syncs once. The server rejects pushes with `hlc` more than 24h ahead of server time.

## Schema (SQLite)

`users`, `workspaces`, `roles`, `role_permissions`, `settings(key, value_json)`, `files`, `file_shares(file_id, workspace_id)`, `testcases`, `bugs`, `bug_attachments`, `bug_status_master`, `activity_log` (append-only, no LWW needed).

Not synced to the client: `users.password_hash`, `sessions`. These are server-only tables.

**Partial sync:** each device pulls only the workspaces its user belongs to (`files.workspace_id IN session.workspaceIds OR shared`). If the Turso server can't filter per client, the fallback protocol does it in `/api/sync/pull`. **This is a data-exposure requirement:** a full-DB sync would leak other workspaces to every browser.

## Hard problems and decisions

| Problem | Decision |
|---------|----------|
| Human codes `TC-0001` / `BUG-0001` collide offline | Row `id` is a UUID. `code` is NULL locally and shows "BUG-(pending)". The server assigns the code from a `counters` table on first push and it syncs back. Report/export wait for the code |
| Authorization offline | Client enforces `permissions.ts` for UX. The server re-checks every pushed row (port `validateFilesWrite`/`validateBugsWrite`/`validateSettingsWrite` per row) and rejects bad rows. The client then drops them and shows a toast |
| Login offline | First login must be online. The session token + user/role snapshot are cached locally. Offline unlock is allowed until the token expires (7 days). Sync push requires a valid token |
| Settings blob merge (old `validateSettingsWrite` 409) | `settings` is one row per top-level key, so LWW works per key and a key can't vanish |
| Attachments / images | Not in SQLite. Upload to the server (`/api/files`, disk or S3-compatible on the VM); the row stores a URL. Queued upload when offline |
| Deletes resurrecting | Tombstones. GC rows where `deleted_at` is older than 30 days |
| Schema migrations on many devices | Client runs `lib/local/migrations/*.sql` on open (`PRAGMA user_version`). The server refuses pushes from schema versions older than N-1 |
| Activity log | Append-only insert with UUID, no conflict possible. Server caps/prunes |

## Phases

### Phase 0: Scaffold + sync spike (3–4 days)
- `web/` Next.js (TS, Tailwind, App Router). COOP/COEP headers in `next.config` if the WASM build needs SharedArrayBuffer.
- Spike above → pick **native Turso sync** or the **own protocol**. Record the decision as an ADR.

### Phase 1: Schema, HLC, repo layer (3–4 days)
- `lib/local/schema.sql`, `lib/hlc.ts` (+ property test: monotonic, total order), `lib/repo/*` with `upsert()` that stamps `hlc` and `updated_by`.
- Port pure domain logic from `qa-app/js/*` into `lib/domain/` (BUG_FORM, TC_IMPORT, statusTransitionRule, ReportCalc, NotifCalc, WorkspaceCalc). Port the `qa-app/test` checks to Vitest.
- LWW merge test: two DB files, conflicting edits, both orders, converge to the same state.

### Phase 2: Server — auth, sync gate, data migration (3–4 days)
- `/api/auth/login` (bcrypt), session cookie, `middleware.ts`.
- `/api/sync/*` gate: token check, per-row authorization, code assignment, partial-sync filter.
- `scripts/migrate-mongo-to-turso.ts`: reads Mongo `kv_store`, writes normalized rows with `hlc = migration time`, hashes passwords, keeps existing codes, seeds `counters`. Mongo stays read-only for rollback.

### Phase 3: Shell + offline UX (2–3 days)
- Login, workspace picker, layout, dark/light, dialogs.
- Sync status badge (online / offline / N pending) replaces the `beforeunload` unsynced guard. With local persistence, closing the tab no longer loses data.

### Phase 4: Test Case + Files (4–5 days)
- Same feature list as today (CRUD, filter/sort/bulk, import/export Excel, sharing, TestForge online-only).

### Phase 5: Bug Report (4–5 days)
- Form, attachments (queued upload), board with column-level LWW on `status`, QA status rules, Master Status, Analyze (online-only).

### Phase 6: Dashboard, Summary, Report, Notifications, Activity, Settings, Users (4–5 days)
- All computed locally from SQLite (fast, works offline). User/role management is online-only (server-only tables).

### Phase 7: Cutover (2–3 days)
- VM: Turso sync server as a systemd/Podman unit + `next start`. `deploy.yml` builds `web/`, restarts both.
- Run the migration, smoke test with 2 browsers + 1 offline device, retire Mongo after 2 weeks.

**Total:** ~25–33 dev days (+4 if the own-protocol fallback is needed).

## Risks

| Risk | Mitigation |
|------|-----------|
| Self-hosted Turso sync immature / cloud-only features | Phase 0 spike with go/no-go; own-protocol fallback keeps the same schema |
| LWW silently drops a concurrent edit | Column-level LWW on status fields; activity log records both writes so loss is auditable |
| Workspace data leak via full-DB sync | Partial sync filter enforced server-side; test: user A's local DB contains no workspace-B rows |
| OPFS unsupported / storage evicted | `navigator.storage.persist()`; on eviction the device just re-pulls (server is the source of truth) |
| WASM bundle size | Load the DB in a Web Worker, lazy on first authenticated route |

## Done when
- Device offline: create/edit test cases and bugs, reconnect, all rows on the server, codes assigned.
- Two devices edit the same bug offline: converge to an identical state, and the status move survives a concurrent description edit.
- User A's local DB has zero rows from workspaces A can't see.
- `KvMerge`, `rev`, `qa_unsynced_v2`, `x-role` headers: all deleted.
