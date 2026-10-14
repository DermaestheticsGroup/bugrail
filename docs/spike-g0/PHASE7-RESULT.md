# Phase 7 result: cutover tooling

## Built
- `web/scripts/backup.mjs`: nightly `VACUUM INTO` backup with verification, atomic rename, 14-day prune. Runs under Node 24.
- `deploy/`: `bugrail.service`, `bugrail-backup.service`, `bugrail-backup.timer`, `bugrail.env.example`.
- `.github/workflows/deploy-web.yml`: manual deploy of `web/` (type `cutover`). The old `deploy.yml` is untouched.
- `docs/runbook-cutover.md`, `docs/adr/ADR-005-cutover-and-operations.md`, README links.

## Evidence
- `backup.mjs` under Node v24.21.0 on a seeded DB (20 files, 500 bugs, 1500 events): the copy opens, `PRAGMA integrity_check` is ok, row counts match; a rerun on the same day replaces the file; a copy older than 14 days is pruned; a missing source exits 1; a garbage source exits 1 and leaves no file under a trusted name; no `-wal` or `-shm` sidecar remains.

## Not done or not checked
- Nothing ran on the real VM: the unit files, the timer, `sudo` rules, the deploy workflow and the runbook are unexecuted. The `itdev1` user and `/usr/bin/node` path are assumptions.
- Backup was not run while the app was writing (G0.7 covered that for the engine, 18 MB). Not run on a production-sized DB.
- The runbook's migration and rollback steps were rehearsed only on synthetic data (Phase 4). `--mongo` is untested against a real MongoDB.
- Off-machine backup copies are not set up.
- G6 (QA lead ticks the parity checklist) and G4 on a real dump are still open. They block the cutover itself.
