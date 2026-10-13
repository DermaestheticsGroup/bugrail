# ADR-003: Isolate workspaces on the server, per row, on every pull and push

## Status

Accepted (2026-10-13)

## Date

2026-10-13

## Context

BugRail accounts are shared with external vendors' QA staff. A vendor account must see only its own workspace and files explicitly shared into it.

Today nothing enforces this. Every browser downloads every blob (`GET /api/kv`, cached at `utils.js:158`), workspace filtering is done in the UI (`WorkspaceCalc`), and the server trusts `x-role`/`x-workspace` headers the client sets itself (`server/app.js`). Files with no `workspaceId` are visible in every workspace (`workspace.js:73`).

## Decision

- The server decides what each user receives. Pull returns only rows the user may see: files owned by or shared into the user's workspaces (admins see all), their test cases, bugs and bug events, the activity log of those workspaces, users who share a workspace with them, and global config (roles, status master, custom field definitions).
- Push checks each row against the session user (never request headers): workspace membership plus the role permission matrix, porting `validateFilesWrite`/`validateBugsWrite`.
- Password hashes, session data and secrets (the Gemini key) never leave the server.
- When a user's visibility changes (membership, share, file move, restore), their `access_version` is bumped and their next pull forces a full re-pull, which also deletes rows they can no longer see from the browser.
- The migration moves files with no workspace into a new "Internal" workspace containing every non-vendor user.

## Alternatives Considered

### Trust logged-in users with all data (Turso plan v2)

- Rejected: vendor accounts would receive every workspace.

### One database per workspace

- Pros: isolation at the file level.
- Cons: cross-workspace sharing needs copies or a shared DB; admin views open many DBs.
- Rejected: our own pull filter gives the same isolation with sharing intact.

## Consequences

- A vendor's browser storage and network traffic contain only its workspace's data: pull isolation verified by tests; activity_log write scoping covered by test in Phase 1; revoke-bump now reads the `users` table (Phase 3); real sessions replace the dev header, and the role matrix is enforced on push. A vendor account checks it again at the parity gate.
- Data already on a device stays there until it reconnects and pulls; departing vendors should also have their sessions revoked.
- Isolation is at the file level. Finer, per-row access within a workspace is out of scope.
