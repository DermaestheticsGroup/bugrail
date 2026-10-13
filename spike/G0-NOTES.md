
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
