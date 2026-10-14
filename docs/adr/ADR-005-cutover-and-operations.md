# ADR-005: Manual deploy, nightly VACUUM INTO backup, systemd on the VM

## Status

Accepted (2026-10-14)

## Date

2026-10-14

## Context

Phase 7 puts `web/` on the existing VM in place of `server/`. `.github/workflows/deploy.yml` deploys the old server on every push to `main`. Deploying `web/` replaces the running service and its data store, so it is the cutover, not a routine release.

## Decision

- **Manual web deploy.** `.github/workflows/deploy-web.yml` runs only by `workflow_dispatch`, and only when the input says `cutover`. The old `deploy.yml` stays in the repo, is disabled in GitHub at cutover (runbook), and is deleted when the old stack is retired, so merging this change does not touch production.
- **Service.** systemd `bugrail` runs `node node_modules/next/dist/bin/next start -p 3001` (Node 24, ADR-004) with secrets in `/etc/bugrail/bugrail.env` (mode 600, outside the repo). `server.db` lives in `/var/lib/bugrail/` via `StateDirectory`.
- **Backup.** A systemd timer at 02:00 runs `web/scripts/backup.mjs` under plain Node: `VACUUM INTO` a `.partial` file, open the copy, check `PRAGMA integrity_check` and row counts, then rename to `server-YYYYMMDD.db` and prune copies older than 14 days. A copy that fails the check is deleted and the job exits 1, so systemd marks the unit failed.
- **Single instance.** The login rate limit is in memory; the service runs once.

## Alternatives Considered

### Deploy `web/` from the same push-to-main workflow

- Rejected: the first merge after G6 would swap production without the freeze, dump and migration steps.

### Stop the service and copy `server.db*` for backups

- Rejected: G0.7 showed `VACUUM INTO` works on the engine in 379 ms for an 18 MB DB while writes continued, so no downtime is needed.

### Backup through an HTTP route

- Rejected: the G0 spike route was unauthenticated and interpolated its target into SQL. A script run by the OS timer needs no route.

## Consequences

- The deploy builds in place: `bun run build` rewrites `.next` while the old process still serves, so requests during the build can miss assets, and a failed build leaves a half-rebuilt `.next` until the next good build. A release-directory switch would avoid it; not done. The cutover itself runs under a write freeze, so this only matters for later releases.
- `ProtectSystem=strict` with a write exception for `.next/cache` is untested on the VM; if `next start` needs another writable path the service will fail on start and the journal will say which.

- A rollback after 48 h has no automated path; the runbook covers the first 48 h only.
- Backups live on the same VM. A disk loss takes them too. Copy `/var/backups/bugrail` off the machine if that matters; not done here.
- `VACUUM INTO` was only measured at 18 MB on a dev machine, not on the production VM or a production-sized DB.
