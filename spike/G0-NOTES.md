
## Task 4: sync server

- Plan code for id-gen, users, server and tests ran unchanged: 0 discrepancies. `UNION` inside `IN (...)`/`FROM (...)` and `transactionAsync` work on Turso 0.8.3.
- Added one test (empty-workspace guard: non-admin with `workspaceIds: []` pulls nothing, pushes nothing).

## Task 5: sync client and offline scenarios

- 1 discrepancy: Turso 0.8.3 rejects `ORDER BY MIN(seq)` ("misuse of aggregate function MAX()"). Fixed by selecting `MIN(seq) AS first_seq` and ordering by that alias. Everything else in the plan client and all 8 scenario tests ran unchanged; convergence (LWW, status clock, paged pull, in-flight write stays queued) holds in-process.
- `httpTransport` is untested here (needs the Task 6 routes).

## Task 6: sync routes and HTTP convergence (G0.8)

- 0 discrepancies. Plan code for server-db, both routes and converge.ts ran unchanged. `bun run build` succeeds (Next 16.4.0 Turbopack); `@tursodatabase/database` imports fine in route handlers; both routes are dynamic (ƒ).
- `pull` without user: 401. `pull?since=0` as admin: `{"rows":[],"next":0,"more":false}`.
- `httpTransport` now exercised over real HTTP. Convergence output (3 seeds, 300 rounds, 3 devices):

```
{"check":"G0.8","rounds":300,"converged":true,"allCoded":true}
{"check":"G0.8","rounds":300,"converged":true,"allCoded":true}
{"check":"G0.8","rounds":300,"converged":true,"allCoded":true}
```

- Fix (review): `USERS[header]` matched inherited keys (`constructor`, `__proto__`, `toString`) so the routes returned 500 instead of 401. Now `userFromHeader` (own-property check, lib/sync/users.ts) is used by both routes; test/users.test.ts covers it. Verified over HTTP: all three headers give 401 on pull and push.

## Task 7: production-sized seed, load, bootstrap (G0.3, G0.5 Node half)

- SIZES ARE PLACEHOLDERS pending real production counts (`qa_files`, `qa_testcases`, `qa_bugs`, activity+comments+assignments total, `kv_store.stats().size`). Defaults used: 150 files, 6000 bugs (test cases folded in), 18000 events. Re-run with `bun scripts/seed.ts --files N --rows N --events N`; load via `CLIENTS`, `INTERVAL_MS`, `DURATION_MS`, `BASE` env.
- Seed: `{"seeded":24150,"bytes":18419712}` (3.4 s).
- Smoke (3 clients, 20 s, first request to a cold server): `{"clients":3,"cycles":30,"errors":0,"p50ms":41,"p95ms":74,"bootstrapP95ms":1660,"bootstrapMaxms":1660}`, exit 0.
- Real (30 clients, 10 min, 10 s interval): `{"check":"G0.3/G0.5","clients":30,"cycles":1802,"errors":0,"p50ms":21,"p95ms":38,"bootstrapP95ms":217,"bootstrapMaxms":221}`, exit 0.
- G0.3 PASS (p95 38 ms < 1000 ms). G0.5 Node half PASS (max cold bootstrap 221 ms < 10 s, all 30 at once). The 1660 ms smoke figure is the first-request cost on a freshly started server.
- Caveat: placeholder size only; 18 MB DB is likely well under production. Cold bootstrap not yet measured in a real browser (G0.5 browser half).

## Task 8: browser checks (G0.1, G0.2 wasm half, G0.5 browser half)

- `bun run build` passes with `@tursodatabase/database-wasm/turbopack` and the COOP/COEP headers; `/opfs` is static (○).
- Driven with playwright-core against installed Google Chrome 155.0.8059.40 (headless, fresh persistent profile), server on a fresh 24150-row seed (placeholder sizes, see Task 7). Observed:

| Browser | Version | crossOriginIsolated | boots after 2 reloads | persist | wasmMerge | bootstrapMs (24150 rows) |
|---|---|---|---|---|---|---|
| Chrome (headless) | 155.0.8059.40 | true | 3 (loads 1,2,3) | false | PASS | 3432 (< 10000) |
| Edge | - | NOT YET VERIFIED | | | | |
| Firefox | - | NOT YET VERIFIED | | | | |
| Safari | - | NOT YET VERIFIED | | | | |

- Chrome: G0.1 and G0.2 wasm half PASS, G0.5 browser half PASS on this size. `persist: false` recorded as-is for the risk register (headless, not installed/bookmarked). One 404 console error on first load (not investigated, likely favicon).
- G0.1 overall NOT YET VERIFIED: needs Edge, Firefox, Safari. G0.2 is complete only if those also report `wasmMerge: PASS`. Headless Chrome is not a substitute for those engines.
- Manual steps (Edge, Firefox, Safari; also worth repeating in headed Chrome):
  1. `cd spike && bun scripts/seed.ts && bun run build && BUGRAIL_DB_PATH=data/server.db bun run start`
  2. Open `http://localhost:3100/opfs`. Check `crossOriginIsolated: true`, `wasmMerge (G0.2): PASS`.
  3. Reload twice. `boots` must read 1, 2, 3.
  4. Click "Run full bootstrap". Record `bootstrapMs` (< 10000) and `bootstrapRows` (24150 for the default seed).
  5. Paste the `results` block per browser into the table above. Safari: `localhost` is a secure context so OPFS should be available; if `opfs` shows FAIL, record the message.

## Task 9: offline shell (G0.6)

- Plan code (sw.js, sw-register, offline-badge, layout) ran unchanged. 0 discrepancies: `next/offline` `useOffline` exists in 16.4.0 (`node_modules/next/offline.d.ts`, doc `dist/docs/01-app/02-guides/offline-support.md`), build passes (`/`, `/opfs`, `/other` static).
- Driven with playwright-core against installed Google Chrome 155.0.8059.40 (headless, fresh persistent profile), `next build` + `next start` on :3100, `context.setOffline(true/false)`. Screenshots in `g06-screens/`.

| Step | Expected | Observed (Chrome 155 headless) |
|---|---|---|
| 1 SW | sw.js active, controls page | PASS: `navigator.serviceWorker.controller` set after one reload; cache holds `/`, `/opfs`, `/other` + 14 `/_next/static` chunks (incl. wasm worker chunk) |
| 3 reload `/` offline | renders, badge `offline` | PASS: h1 "BugRail G0 spike", badge `offline` (the browser `offline` event flips it) |
| 4 soft nav `/` -> `/other` offline | renders without browser error page | PARTIAL: passes only when the page session prefetched online first (same session, no reload): url `/other`, "Other page" visible, no error page. Link prefetch (`/_tree` + `/other/__PAGE__` RSC requests) happened online |
| 4b soft nav `/other` -> `/` offline | renders | FAIL as written: stays on `/other`, "Home" click pending (`/` RSC request fails with ERR_INTERNET_DISCONNECTED and is retried). The new `/` Link on `/other` can't prefetch once offline |
| 4c soft nav after an offline reload of `/` | renders | FAIL: reload clears the router prefetch cache, prefetch can't re-run offline; click stays pending (8 s waited), url stays `/` |
| 5 `/opfs` offline goto + reload | renders, boots grows, wasmMerge PASS | PASS: boots 2 then 3, `wasmMerge: PASS`, `crossOriginIsolated: true` (wasm served from SW cache). Badge read `online` here (no failed Next request or offline event after the fresh load, so it is not a reliable status after a SW-served load) |
| 6 back online | badge `online` within ~3 s | PASS: pending `/` navigation completed, badge `online` after 23 ms (probe run). Step 6 in the full script read 1-2 ms because badge was already `online` |

- Next's own behavior (per docs): with `useOffline`, failed navigation/prefetch is held pending and retried on reconnect, not thrown. That matches: pending, then completes after reconnect.
- G0.6 overall NOT YET PASSED: step 4 partial, headless Chrome only.
- Steps 3, 5, 6 PASS in headless Chrome 155. Step 4 passes only for routes whose shell was prefetched earlier in the same page load. Navigation offline to a route not prefetched in the current page load (including after an offline reload) hangs pending until online. Consequence: every route reachable offline needs a `<Link>` visible on the page after load, or the SW must also serve RSC (`?_rsc`) requests from cache. Not tried here.
- Limitation: after a SW-served fresh load while offline, the badge reads `online` (no failed Next request or `offline` event follows). Do not rely on `useOffline` alone for status there.
- SW fix round: cache writes wrapped in `event.waitUntil`, only `res.ok` responses cached, uncached offline navigations now get a plain 503 instead of the `/` shell. Checks 3, 5, 6 re-run after the change with the same results.
- Reproduce: `PLAYWRIGHT_CORE=<path to playwright-core> node scripts/g06-offline.cjs <outdir>` with `next start` on :3100 (covers 3, 4, 4b, 4c, 5, 6). Screenshots: step3, step4, step5, step6 in `g06-screens/`.
- Chrome only. Edge, Firefox, Safari: NOT YET VERIFIED. Manual steps (DevTools Network -> Offline, or Safari Develop -> Disable network):
  1. `cd spike && bun scripts/seed.ts && bun run build && BUGRAIL_DB_PATH=data/server.db bun run start`
  2. Open `http://localhost:3100/`, confirm sw.js active, wait 5 s (prefetch), visit `/opfs` once, go back to `/`.
  3. Go offline. Click "Other page": must render `/other`. Click "Home": record whether it renders (expected in Chrome: hangs, 4b).
  4. Reload `/`, then `/opfs`: must render, `boots` grows, `wasmMerge: PASS`. After the fresh offline load, record the badge (Chrome: reads `online`, known limitation).
  5. Offline reload `/`, then click "Other page": record whether it renders or hangs (Chrome: hangs, 4c).
  6. Go online: badge returns to `online` within ~3 s.

## Task 10: Bun vs Node runtime (G0.4)

- Versions: bun 1.4.2, node v24.21.0, next 16.4.0, @tursodatabase/database 0.8.3. macOS, same machine, back to back.
- DB: scratch DB from `bun scripts/seed.ts` defaults (150 files, 6000 rows, 18000 events; 24150 rows, 18419712 bytes), one fresh copy per runtime (`bun.db`, `node.db`), so Bun's writes did not touch Node's data. Not committed.
- Load: defaults, 30 clients, 10000 ms interval, 600000 ms duration, both runs complete, 0 errors.
- Bun: `bun --bun next build` + `bun --bun next start -p 3100`. Native binding loads (pull returned JSON). G0.8 converge seeds 1, 2, 3 all `converged:true,allCoded:true`. G0.4 PASS.
- Node: `npx next build` + `node .../next start -p 3100`.

```
Bun : {"check":"G0.3/G0.5","clients":30,"cycles":1796,"errors":0,"p50ms":35,"p95ms":107,"bootstrapP95ms":19990,"bootstrapMaxms":20067}
Node: {"check":"G0.3/G0.5","clients":30,"cycles":1798,"errors":0,"p50ms":35,"p95ms":57,"bootstrapP95ms":21596,"bootstrapMaxms":21596}
```

- p95 ratio Bun/Node = 107/57 = 1.88 (limit 1.20). p50 equal (35 ms). Bootstrap p95 about equal (~20-22 s for both; both exceed the 10 s G0.5 target at 30 concurrent cold bootstraps, separate issue).
- One Node load attempt was discarded (the output file stayed empty, the process was lost to a tool timeout) and rerun in full; only the complete run is recorded.
- **Decision: Node 24 as production runtime** (G0.4 passes, but Bun p95 is 88% worse than Node in a single run, indicative only). Single run per runtime, no repeats, so the p95 variance is unmeasured.

## Task 11: Backup while writing (G0.7)

- Setup: scratch live DB from `bun scripts/seed.ts --db <scratch>/live.db` (defaults, 24150 rows, 18419712 bytes). Server: `npx next build`, then `BUGRAIL_SPIKE=1 BUGRAIL_DB_PATH=<scratch>/live.db node node_modules/next/dist/bin/next start -p 3100` (Node 24 per Task 10). Not committed.
- Load: `CLIENTS=10 DURATION_MS=60000 INTERVAL_MS=2000 bun scripts/load.ts`, started, then backup fired 30 s in (load still writing). Load finished: 293 cycles, 0 errors, p95 182 ms.
- Backup: `curl -s -X POST "http://localhost:3100/api/spike/backup?to=<scratch>/backup.db"` returned `{"ok":true,"ms":379}`. `VACUUM INTO` is supported, so the Step 3 cp fallback was not needed or tested.
- Counts (live DB read-only from a second process, just before / just after the POST; backup via `bun scripts/backup-check.ts`):

```
before: {"files":150,"bugs":6116,"bug_events":18000}
backup: {"files":150,"bugs":6117,"bug_events":18000}  integrity {"integrity_check":"ok"}
after : {"files":150,"bugs":6118,"bug_events":18000}
```

- Backup bugs count (6117) falls inside the live range [6116, 6118]; the load wrote 2 rows during the window, so the copy is a consistent point-in-time snapshot, not a torn read.
- `PRAGMA integrity_check` is supported by this driver and returned `ok`.
- Not tested: backup under the 30-client load, larger DB, concurrent backup requests. The route is unauthenticated and interpolates `target` into SQL behind the `/^[\w./-]+\.db$/` regex (spike only; the shortcut comment says so).
- **G0.7 PASS**: backup opened, has rows, counts in range, integrity ok, 379 ms for an 18 MB DB while writes continued.
