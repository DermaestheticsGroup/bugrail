# Phase 2: Domain Logic Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** Port the pure legacy business logic from `qa-app/js/` into typed `web/lib/domain/*.ts` with no behavior change, and port the legacy `.check.js` assertions to `bun test`.

**Architecture:** One TS module per legacy source area, no DOM, no Storage, no globals. Functions that read `Storage`/`Auth` globals take their inputs as parameters. Legacy files stay untouched (cutover is Phase 7).

**Tech Stack:** TypeScript, `bun test` (`bun:test`), run from `web/`.

**Spec:** `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md`; scope from `docs/migration-plan/2026-10-13-nextjs-turso-local-first-v2.md` Phase 2 (T2.1-T2.3) and Mongo plan M2.1/M2.2.

## Global Constraints

- Rulings: tests use `bun test`, not Vitest (Phase 1 convention, `web/package.json`); T2.3 hlc/lww tests already exist from Phase 1 (`web/test/hlc.test.ts`, `web/test/lww.test.ts`), so no new work.
- Same assertions as the legacy `.check.js`, ported 1:1; add no new behavior.
- Status comparisons switch from names to codes where the web schema has status codes (see `web/db/schema`); keep the name-to-code mapping in one place, `web/lib/domain/status.ts`.
- `safeStepsHtml` stays client-only (needs DOM). `storage.check.js` is not ported (localStorage layer is replaced by the local DB).
- `cd web && bun test && bunx tsc --noEmit` must pass after every task. Commit and push after every task. Never force-push.

## Review Focus

- Empty/undefined inputs to every ported function return what the legacy code returned.
- `IdGen.nextInScope` ignores foreign prefixes and odd ids.
- `can()` for admin vs non-admin and unknown permission keys.

### Task 1: utils.ts domain modules

**Files:** Create `web/lib/domain/{forms,status,ids,steps,stats}.ts`; tests `web/test/domain-{bugcode,bugform,statusflow,tcimport}.test.ts`.
Port from `qa-app/js/utils.js`: `BUG_FORM`, `TC_IMPORT`, `normPriority`, `statusTransitionRule`, `compareRows`, `moduleAbbrev`, `IdGen.nextInScope` (pure; `uid` takes no Storage), `bugCode`/`tcCode`, `computeBugResolutionStats`, `textToStepsHtml`/`stepsHtmlToText`, `detectLang`. Ports legacy `bugcode`, `bugform`, `statusflow`, `tcimport` checks.

### Task 2: report.ts

**Files:** Create `web/lib/domain/report.ts`; test `web/test/domain-report.test.ts`. Port `ReportCalc` from `qa-app/js/report.js` (pure parts only, no DOM rendering) and `report.check.js`.

### Task 3: notifications.ts and workspace.ts

**Files:** Create `web/lib/domain/{notifications,workspace}.ts`; tests `web/test/domain-{notifications,workspace,filedelete}.test.ts`. Port `NotifCalc`, `WorkspaceCalc` and `notifications`, `workspace`, `filedelete` checks.

### Task 4: auth.ts

**Files:** Create `web/lib/domain/auth.ts`; test `web/test/domain-auth.test.ts`. Port `DEFAULT_ROLES`, `PERMISSION_KEYS`, `DEFAULT_ROLE_PERMISSIONS`, and `can(user, permKey)` as a pure function taking the user and role map. Write tests for admin, non-admin, unknown key.
