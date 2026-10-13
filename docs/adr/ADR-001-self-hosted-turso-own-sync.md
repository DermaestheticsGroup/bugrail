# ADR-001: Local-first on self-hosted Turso with our own sync protocol

## Status

Accepted (2026-10-13). Gate G0 validates it; see "If G0 fails" in the spec.

## Date

2026-10-13

## Context

BugRail today keeps every collection as one MongoDB `kv_store` blob. Each browser downloads all of it (`GET /api/kv`), caches it in localStorage and writes whole blobs back, merged by `KvMerge`. A session that boots offline can never write back.

We want the app to feel instant and to work offline, so the database has to live in the browser. Three constraints narrow the transport:

- **Fully self-hosted** on the existing VM. No Turso Cloud, no Vercel.
- **Workspace isolation** (ADR-003): a vendor account must never receive another workspace's rows.
- **Strict feature parity**, including files shared across workspaces.

## Decision

- Server: one `server.db` opened in the Next.js process with `@tursodatabase/database` (embedded Turso engine, MIT), pinned to `0.8.3`.
- Browser: `@tursodatabase/database-wasm` `0.8.3` in OPFS, holding only rows the user may see.
- Sync: our own `POST /api/sync/push` and `GET /api/sync/pull` route handlers. Push checks permission per row, applies the guarded upsert (ADR-002) and assigns display codes in one transaction. Pull returns visible rows by `server_seq` cursor, and forces a full re-pull when the user's access changes.
- Rejected writes are parked in a local `rejected` table (row id, table, reason, time) and leave the outbox, so they never retry forever and are never silently dropped. Dismissing one drops the refused local copy and re-pulls. UI toast lands in Phase 5.

Full design: `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md`.

## Alternatives Considered

### Native Turso Sync with self-hosted `tursodb --sync-server` (Turso plan v2)

- Pros: no sync code of our own; offline writes queue natively.
- Cons: pull replicates the whole DB with no row filtering; the server has no auth and serves one connection at a time; the Turso docs position it for dev/test.
- Rejected: can't isolate workspaces. One `tursodb` process per workspace would isolate, but breaks cross-workspace file sharing, multiplies the single-connection limit, and still needs an agent process for codes and identity tables.

### Native Turso Sync on Turso Cloud, hosted on Vercel

- Pros: managed sync and backups.
- Cons: same whole-DB replication; isolation needs one cloud DB per workspace with browser-held tokens.
- Rejected: violates the self-hosted constraint.

### Online-only Next.js + MongoDB collections (Mongo plan v2)

- Pros: smallest change; change streams for live refresh.
- Cons: no offline work; every interaction waits on the network.
- Rejected: fails the instant and offline goals.

## Consequences

- We own a small sync protocol: two routes and one merge function shared by browser and server. A convergence property test and a 3-client harness guard it.
- Isolation, permission checks and code assignment run on the server inside the push transaction, so no agent process and no client trust are needed.
- One process and one file to operate; backup is a file-level copy (`VACUUM INTO`).
- Turso is pre-1.0. If the server engine fails G0, the server switches to `bun:sqlite`/`node:sqlite` with the same SQL and schema.
- Pages need COOP/COEP headers for the wasm build's shared memory, and the 12.8 MB wasm is cached by the service worker.

## G0 results (2026-10-13)

Sizes are placeholders (24150 rows, 18.4 MB) until production counts are available, so G0.3 and G0.5 are provisional. Browser checks ran in headless Chrome 155 only.

| Check | Result | Evidence |
|-------|--------|----------|
| G0.1 Browsers (Chrome, Edge, Firefox, Safari) | Chrome 155 headless: `crossOriginIsolated` true, OPFS `boots` 1, 2, 3 (`persist` false, cause not tested). Edge, Firefox, Safari: NOT YET VERIFIED | docs/spike-g0/G0-NOTES.md § Task 8 |
| G0.2 Guarded upsert on both engines | PASS on Node (bun test) and wasm in headless Chrome 155 (`wasmMerge` PASS) | bun test output; /opfs |
| G0.3 30 clients × 10 min, p95 < 1 s, 0 errors | PASS: p95 = 38 ms (Node, 1802 cycles), errors = 0 | docs/spike-g0/G0-NOTES.md § Task 7 |
| G0.4 Bun runtime | PASS (binding loads, converge 3 seeds). Bun p95 107 ms vs Node 57 ms, ratio 1.88 > 1.20, so production runs Node 24 | docs/spike-g0/G0-NOTES.md § Task 10 |
| G0.5 Cold bootstrap < 10 s | FAIL at 30 concurrent cold bootstraps (about 20 s vs 10 s target); single-client PASS, provisional. Node 221 ms (single client), Chrome headless 3432 ms. At 30 concurrent cold clients the bootstrap p95 was about 20 s on both runtimes, over the target | docs/spike-g0/G0-NOTES.md § Tasks 7, 8, 10 |
| G0.6 Offline reload + soft navigation | NOT YET PASSED: reload offline, `/opfs` offline and reconnect pass in headless Chrome; soft navigation passes only for routes prefetched in the same page load | docs/spike-g0/G0-NOTES.md § Task 9, docs/spike-g0/g06-screens/ |
| G0.7 Backup while writing | PASS: `VACUUM INTO` 379 ms mid-load, counts inside the live range, `integrity_check` ok | docs/spike-g0/G0-NOTES.md § Task 11 |
| G0.8 Convergence (3 seeds) | PASS over HTTP, 300 rounds each | docs/spike-g0/G0-NOTES.md § Task 6 |

Verdict: proceed to Phase 1 with no fallback taken. Non-Chromium OPFS/wasm results and the concurrent-bootstrap time are Phase 1 exit criteria. Open items that Phase 1 must close: Safari, Firefox and Edge runs of G0.1, G0.2 (wasm half), G0.5 (browser half) and G0.6; production-sized re-runs of G0.3 and G0.5; the concurrent-bootstrap time (about 20 s at 30 clients) needs a plan (paging, caching or staggering); offline navigation needs `<Link>`s visible on every offline-reachable page, or the service worker must also serve `?_rsc` requests.

### Known gaps carried into Phase 1

- (a) ~~access_version reset: visibility changes (file move, share, revoke) never reach clients that are past those rows, must be the first Phase 1 sync task.~~ Closed in 800f23c.
  Closed for the dev user table only; Phase 3 wires the real users lookup for bumpAccess targets.
- (b) Display codes can repeat after deleting the top bug then un-delete (id-gen.ts "highest in use + 1").
- (c) file_shares.id is not checked against file_id:workspace_id so two live shares for one pair are possible.
- (d) activity_log is not in db/tables.ts, its isolation is unreviewed.
- (e) One shared server connection runs concurrent transactionAsync pushes: unverified hypothesis that two pushes can read the same seq, add a targeted test.
- (f) hlc.observe has no validation or drift cap.
- (g) The G0 spike is never deployed: x-spike-user auth and the backup route are stand-ins.
