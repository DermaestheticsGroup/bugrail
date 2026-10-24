# ADR-006: Vercel hosting with a Turso Cloud server database

## Status

Accepted (2026-10-25)

## Date

2026-10-25

## Context

ADR-005 runs `web/` on a VM with `server.db` on local disk. A hosted copy is wanted for review and demos without the VM. Vercel functions have no persistent disk, so the local `@tursodatabase/database` file cannot be the server store there.

## Decision

- **Server DB.** When `TURSO_DATABASE_URL` is set, `getServerDb()` uses `web/lib/libsql-db.ts`, a `@libsql/client` adapter to the same `Db` interface; otherwise the local file (ADR-005) is unchanged.
- **Databases.** Turso `bugrail` backs Vercel Production, `bugrail-preview` backs Preview and local dev. `web/scripts/bootstrap-turso.ts` migrates a database and creates the first admin when it has no users.
- **Basic Auth.** `web/proxy.ts` puts HTTP Basic Auth in front of every route when `BASIC_AUTH_USER` and `BASIC_AUTH_PASSWORD` are set. The app login is still the security boundary.
- **Deploy.** Vercel project `bugrail` (root `web/`) is deployed with the Vercel CLI: preview from the branch, production from `main` after merge. Secrets live only in Vercel env and the git-ignored `web/.env`.

## Alternatives Considered

### Local SQLite file on Vercel
`/tmp` is per-instance and wiped; data would be lost. Rejected.

### Embedded replica (`syncUrl`)
Still needs a writable disk per instance and adds sync lag between instances. Rejected for the hosted copy.

## Consequences

- The login rate limit and `/api/events` fan-out are in memory per function instance, so on Vercel they are best-effort; the VM (ADR-005) stays the single-instance deployment of record.
- Every query is a network round trip to Turso (`aws-ap-northeast-1`).
- Rotating a Turso token or `SESSION_PASSWORD` means updating Vercel env and redeploying.
