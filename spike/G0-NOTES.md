
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
