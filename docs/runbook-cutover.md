# Cutover and operations runbook

For the person doing the cutover. Spec: `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (Operations, Cutover). Decision record: `docs/adr/ADR-005-cutover-and-operations.md`.

Do not start before gate G6 (`docs/parity-checklist.md`, ticked by a QA lead) and gate G4 on a real production dump. Neither has been done as of this writing: G4 was only rehearsed on synthetic data.

## One-time VM setup

1. Node 24 and Bun on the VM. `node -v` shows v24.
2. `sudo install -d -m 700 /etc/bugrail`. Copy `deploy/bugrail.env.example` to `/etc/bugrail/bugrail.env`, set `SESSION_PASSWORD` (32+ random chars), `chmod 600`. Never set `BUGRAIL_DEV_AUTH`.
3. Install the units (do not enable the new `bugrail.service` until the cutover step below):
   `sudo cp deploy/bugrail-backup.service deploy/bugrail-backup.timer /etc/systemd/system/`
4. The `itdev1` deploy user needs passwordless `sudo systemctl restart|is-active bugrail` (already true for the old service).
5. `sudo install -d -o itdev1 -m 750 /var/backups/bugrail`.
6. HTTPS in front of the app (the service worker and OPFS need a secure context). If a reverse proxy sets `X-Forwarded-For`, set `BUGRAIL_TRUSTED_PROXY=1`.

## Cutover

1. Announce the write freeze.
2. Stop the old service: `sudo systemctl stop bugrail`.
3. `mongodump` (keep it: it is the rollback source). Export `kv_store` as JSON.
4. Disable the old auto-deploy first, so a push to `main` cannot restart the new unit against an unbuilt `.next`: `gh workflow disable deploy.yml` (or Actions > Deploy BugRail > Disable workflow). Confirm no deploy run is in progress (`gh run list --workflow deploy.yml --limit 3`).
5. Replace the unit: `sudo cp deploy/bugrail.service /etc/systemd/system/ && sudo systemctl daemon-reload`. Create the data directory the migration needs (the service creates it only when it starts): `sudo install -d -o itdev1 -m 750 /var/lib/bugrail`.
6. Update the checkout and build as `itdev1`: `cd /opt/qa-monitor && git fetch origin main && git reset --hard origin/main && cd web && bun install --frozen-lockfile && bun run build`.
7. Migrate into an empty DB (read the printed report: counts, duplicate codes, files moved to Internal, users hashed):
   `cd /opt/qa-monitor/web && bun scripts/migrate-kv-to-turso.ts --from-json /path/kv.json --db /var/lib/bugrail/server.db --dry-run`
   then again without `--dry-run`. It refuses a non-empty target.
8. `sudo systemctl enable --now bugrail && sudo systemctl enable --now bugrail-backup.timer`.
9. Smoke test: 2 browsers, 1 device that goes offline mid-session and syncs after, 1 vendor account that sees only its own workspace. Log in as a migrated user with the old password.
10. Run one backup by hand: `sudo systemctl start bugrail-backup.service`, then `journalctl -u bugrail-backup -n 5`. The line shows the file and row counts.
11. Lift the freeze. From now on `Deploy BugRail web (manual)` in GitHub Actions deploys web/ (type `cutover`).

## Rollback (within 48 hours)

1. Announce a freeze, `sudo systemctl stop bugrail`.
2. `cd /opt/qa-monitor/web && MONGO_URI=... DB_NAME=... bun scripts/export-turso-to-kv.ts --db /var/lib/bugrail/server.db --original /path/kv.json --out /path/kv-back.json --print-temp-passwords --to-mongo --yes`. `--to-mongo --yes` overwrites `kv_store` in MongoDB with the exported blobs (the `mongodump` from cutover step 3 is the way back from that); without it nothing reaches MongoDB and the old app would start on pre-cutover data. (`--to-mongo` needs the `mongodb` driver on the machine and has not been run against a real MongoDB.) `--original` is the step 3 export: users who existed at cutover get their old password back from it; users created after cutover get a temporary password for the admin.
3. Check out the last commit before the cutover into `/opt/qa-monitor`, restore the old unit from `server/`, `sudo systemctl start bugrail`. Re-enable the old auto-deploy: `gh workflow enable deploy.yml`.
4. Browsers keep their local database. Clear site data in each browser, or the old app and the new local DB will disagree.

## Restore a backup

Backups are `/var/backups/bugrail/server-YYYYMMDD.db`, kept 14 days, verified with `PRAGMA integrity_check` when written.

1. `sudo systemctl stop bugrail`
2. Keep the damaged file: `mv /var/lib/bugrail/server.db /var/lib/bugrail/server.db.bad` (also move `server.db-wal` if present).
3. `cp /var/backups/bugrail/server-YYYYMMDD.db /var/lib/bugrail/server.db`
4. `sudo systemctl start bugrail`
5. Know what a restore does to clients. Pulled rows never go back through a client's outbox, and `pushOutbox` clears an entry once the server accepts it, so rows a client synced after the backup was taken are **not** pushed again. Clients also keep a pull cursor, which can sit ahead of the restored server's sequence numbers. After restoring an older backup, each client must start from a fresh pull, and anything it wrote after the backup is gone from the server.
6. Before clearing a client's site data, check it has nothing unsent (the sync badge says "up to date"); if it does, let it sync first or export it with the Import/Export screen backup. Clear site data only on clients where discarding the post-backup rows is intended.
7. This restore path has not been rehearsed with real clients.

## Retire (after 2 stable weeks)

Final `mongodump`, then stop MongoDB, delete `qa-app/` and `server/`, and delete `.github/workflows/deploy.yml` (the old deploy, disabled since cutover).

## Operating notes

- Logs: `journalctl -u bugrail -f`.
- Env changes: edit `/etc/bugrail/bugrail.env`, `sudo systemctl restart bugrail`.
- The login rate limit is in memory: a restart clears it, and a second instance would not share it. Run one instance.
- Update clients: a deploy changes the service worker; open tabs pick it up on the next navigation.
