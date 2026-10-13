# ADR-002: Resolve conflicts by last write wins, ordered by a hybrid logical clock

## Status

Accepted (2026-10-13)

## Date

2026-10-13

## Context

With offline writes, two devices can edit the same row before either syncs. Ordering by arrival ("last push wins") lets a device that reconnects after three days overwrite newer edits. Today's data also embeds `activity[]`, `comments[]` and `assignments[]` in each bug (`bugreport.js:331,557`, `auth.js:207`), so any row-level merge drops a concurrent comment. Bug status is stored by name, and renaming a status rewrites every bug (`masterstatus.js:126`).

## Decision

- Every synced row carries `hlc`, a hybrid logical clock string `"<ms:15>-<counter:5>-<deviceId>"` whose string order is time order.
- One guarded upsert per table (`lib/lww.ts`) applies an incoming row only where `excluded.hlc > row.hlc`. Status has its own `status_hlc`, so a status move and a concurrent field edit both survive. `code` is first-non-null-wins.
- The same statement runs on the server for push and in the browser for pull.
- Anything that can conflict as a list becomes insert-only rows: `bug_events` (comments, status history, assignments), `file_shares`, `activity_log`. Deletes are tombstones. Status is stored by code.
- Synced tables have no `UNIQUE` (beyond the key), `FOREIGN KEY` or rejecting `CHECK`, so a sync write never fails on a constraint.
- A device whose clock is more than 5 minutes off the server's `Date` header is blocked from writing.

## Alternatives Considered

### Last push wins (native Turso Sync default)

- Rejected: a late reconnect silently overwrites newer work.

### CRDTs per field (Yjs, Automerge)

- Pros: merges concurrent text edits.
- Cons: new dependency and storage format for fields that are short and rarely co-edited.
- Rejected: field-level LWW plus insert-only logs covers BugRail's conflict cases.

### Server timestamps

- Rejected: offline writes have no server time at write time.

## Consequences

- Two devices converge to identical rows regardless of sync order (property-tested with 1000 random interleavings).
- LWW is per row for plain fields: when two devices edit plain fields of the same row concurrently, the later write's whole row wins, even if they touched different fields. Status (own clock) and comments, history and assignments (insert-only rows) are protected from this.
- The migration converts embedded arrays to `bug_events` and status names to codes; the rollback export converts them back.
