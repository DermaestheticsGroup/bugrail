
## Task 4: sync server

- Plan code for id-gen, users, server and tests ran unchanged: 0 discrepancies. `UNION` inside `IN (...)`/`FROM (...)` and `transactionAsync` work on Turso 0.8.3.
- Added one test (empty-workspace guard: non-admin with `workspaceIds: []` pulls nothing, pushes nothing).

## Task 5: sync client and offline scenarios

- 1 discrepancy: Turso 0.8.3 rejects `ORDER BY MIN(seq)` ("misuse of aggregate function MAX()"). Fixed by selecting `MIN(seq) AS first_seq` and ordering by that alias. Everything else in the plan client and all 8 scenario tests ran unchanged; convergence (LWW, status clock, paged pull, in-flight write stays queued) holds in-process.
- `httpTransport` is untested here (needs the Task 6 routes).
