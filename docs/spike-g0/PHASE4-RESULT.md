# Phase 4 result: data migration

## Built
- `web/lib/migrate/kv.ts`: pure `transformKv` (legacy blobs to rows), `writeServerDb`, `exportKv` (rollback), `diffKv`, `blobsFromJson`.
- `web/scripts/migrate-kv-to-turso.ts` (`--from-json` or `--mongo`, `--dry-run`) and `web/scripts/export-turso-to-kv.ts` (`--out`, optional `--to-mongo --yes`). Run with Bun, like the other scripts.
- Synthetic legacy fixture `web/test/fixtures/legacy-kv.ts` (seeded): Not Run, Highest/Critical, a status only the history knows (`Reopened`), files with no workspace, orphan rows, duplicate codes, legacy single `workspaceId`, unmapped and non-string fields, empty arrays.

## Behavior
- Every record migrates. Unmapped fields, and known fields holding a non-string value, go to `extra` (bugs, test cases) and come back on export. Empty embedded arrays are remembered.
- Status names become codes via the master list (defaults when empty); unknown names get master rows with the `masterstatus.js` code rule. Events store codes.
- `activity[]`, `comments[]`, `assignments[]` become `bug_events` with ids `<bug>:s|c|a:<index>`, so export restores order.
- Files with no workspace move to an "Internal" workspace; non-vendor, non-admin users join it. Export reverses this using a note in `secrets.migration`.
- Every row gets one HLC (`<ms>-00000-migrate`) and a sequential `server_seq`; `sync_meta.seq` is set to the highest.
- A legacy workspace already named "Internal" (or using id `ws-internal`) aborts the migration; empty or duplicate user emails abort the CLI unless `--allow-skip-users`.
- Export file is written mode 0600; temporary passwords print only with `--print-temp-passwords`.
- Writer refuses a non-empty database and runs in one transaction (a failure leaves it empty).
- Users with an empty or duplicate (case-insensitive) email are skipped and listed in `report.warnings`; the first one wins.
- Passwords: scrypt on migrate. Export gives cutover users their old plaintext from the original `qa_settings`; later users get a random temporary password (crypto-generated) printed once.

## Gate G4 evidence (synthetic data only)
- Row counts match blob lengths (+1 FILE-DEFAULT file for orphans); per-bug events = `activity + comments + assignments` for all bugs; codes identical, legacy duplicates reported not renumbered.
- migrate, export, diff: empty except the intended differences (FILE-DEFAULT added, Internal removed again, master list and merged role permissions filled in, emails lower-cased). A tampered export is detected.
- Every migrated user logs in through the real `login()` with the old password; the user with no password cannot.
- A migrated QA user's push gets the next code; a vendor's pull holds only own and shared files, never the Internal file.
- CLI run end to end on a generated 300-bug dump: migrate, refusal on rerun, export, diff.
- Full suite: see the PR for the current count (`bun test`); `tsc` clean.

## Not done or not checked
- **No production dump was available.** G4 is rehearsed on synthetic data; the real rehearsal (restore dump, migrate, export, diff) is still open. This also leaves the production-sized G0.3 and G0.5 re-runs open.
- The `--mongo` read path and `--to-mongo` write path were never run against a real MongoDB.
- Dropped by design, listed in the report: unknown user fields (no column), unknown workspace fields, unknown keys on custom field definitions, `theme`, `qa_counters`, `qa_trash`.
- Custom roles are stored in `secrets.roles`, but the admin API still validates roles against the four defaults.
- Test case display codes are not assigned on push (only bug codes are); needed before the client creates test cases (Phase 5/6 prerequisite).
- Backup-restore access bump still not wired.
