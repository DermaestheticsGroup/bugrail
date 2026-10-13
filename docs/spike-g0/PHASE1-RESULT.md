# Phase 1 result (G1 scaffold + schema), 2026-10-13

Branch `feat/phase1-local-first-foundation`, plan `docs/superpowers/plans/2026-10-13-phase1-scaffold-schema.md`.

## G1 gate (run in `web/` at 61b3b6c)

| Check | Result |
|-------|--------|
| `bun run typecheck` | clean |
| `bun test` | 85 pass, 0 fail |
| `bun run build` | succeeds |
| `node --experimental-strip-types scripts/node-smoke.mjs` | `ok` |
| `bun scripts/converge.ts` over HTTP (next dev, seeds 1, 2, 3, 100 rounds) | `converged: true, allCoded: true` x3 |

`web-ci.yml` has not run on GitHub yet; the first PR runs it.

## What changed

- `spike/` promoted to `web/`; dev auth header `x-dev-user` is ignored when `NODE_ENV=production`.
- Production runs Node 24, Bun is local tooling (ADR-004).
- Full synced schema as versioned files (`db/schema/001..004`), `applyMigrations`, `SCHEMA_VERSION` 4.
- Pull reset on `access_version` / `schema_version` change keeps unpushed rows (gap a closed for the dev user table).
- Rejected pushes parked in a local `rejected` table (review finding from the no-mistakes run).
- ADR-001 gaps b, c, d, f closed; e not reproducible (test kept).

## Decisions worth a second look

- Display codes: deleted numbers are never reused (spec line updated). Legacy behavior reused them.
- A share edit or file move resets every client of the affected workspaces (full re-download).
- New tables (testcases, bug_status_master, custom_field_defs) are admin-only until Phase 3 permission rules.
- `activity_log` push checks `actor_email` only, not that `workspace_id` is one of the user's workspaces.
- `bumpAccess` targets come from the dev `USERS` list; Phase 3 must read the `users` table. Backup-restore and `workspace_ids` bump triggers are not wired.

## Not closed by Phase 1

| Item | Owner |
|------|-------|
| Safari, Firefox, Edge runs of G0.1, G0.2 wasm half, G0.5 browser half, G0.6 | Phase 5 (client shell) |
| Production-sized re-runs of G0.3 and G0.5 | Phase 4 (data migration) |
| 30 concurrent cold bootstraps about 20 s vs 10 s target | Phase 5 |
| Offline soft navigation (G0.6) | Phase 5 |
| `web/` dev and start use port 3001, same as legacy `server/` | resolved at Phase 7 cutover |
