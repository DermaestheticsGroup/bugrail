# ADR-004: Bun for tooling, and as the production runtime if G0 passes

## Status

Accepted (2026-10-13): production runtime is Node 24 LTS. G0.4 passed (the native binding loads under Bun and convergence holds), but under 30 clients for 10 minutes on the same seeded DB Bun's p95 was 107 ms against Node's 57 ms, a ratio of 1.88 against the 1.20 limit. One run per runtime, so variance is unmeasured. Bun stays for tooling.

## Date

2026-10-13

## Context

The team wants Bun across the project. Bun as package manager, script runner and test runner is low risk. Running the production Next.js server under Bun is less certain: `@tursodatabase/database` is a native Node-API binding, and Next.js 16 officially targets Node.

## Decision

- Bun installs dependencies (`bun.lock`), runs scripts (`bun run`, `bun scripts/*.ts`) and tests (`bun test`).
- Production runs `next start` under Bun only if G0.4 passes: `next build`, `next start` and the native binding all work under Bun, and the G0.3 load test passes under Bun.
- Otherwise production runs under Node 24 LTS, and Bun stays for tooling.

## Alternatives Considered

### npm and Node everywhere

- Rejected: slower installs and test runs, and it ignores the team's tooling choice.

### Bun everywhere without a gate

- Rejected: an untested runtime under a native binding is the riskiest combination in the stack.

## Consequences

- `deploy.yml` uses `bun install --frozen-lockfile && bun run build`; only the systemd `ExecStart` differs between outcomes.
- The systemd `ExecStart` runs `node node_modules/next/dist/bin/next start`; CI keeps `bun install --frozen-lockfile && bun run build`.
- Revisit if a later Bun release closes the p95 gap: repeat the G0.4 load on production-like hardware.
