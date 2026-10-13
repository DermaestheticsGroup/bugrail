# BugRail → Next.js, keep MongoDB — Migration Plan

> Supersedes the Postgres/Prisma direction in `specs/2026-08-11-bugrail-next-migration-design.md` for teams that want to keep MongoDB.

## Goal

One Next.js (App Router) app replaces both `qa-app/` (vanilla JS) and `server/` (Express). MongoDB stays. Every feature ships, and the existing data migrates over: nothing gets dropped.

## Current state (what we migrate from)

| Area | Today | Pain |
|------|-------|------|
| Storage | `kv_store` collection, one doc per key (`qa_testcases`, `qa_bugs`, `qa_files`, `qa_settings`, `qa_counters`, `qa_activity_log`), whole array `PUT` per write | Every edit rewrites the whole collection blob. Optimistic `rev` lock + client-side `KvMerge` 3-way merge exist only to survive that |
| Auth | `Auth` in `qa-app/js/auth.js`, plaintext passwords in `settings.users`, role/workspace sent as `x-role` / `x-workspace` headers | Spoofable, no server session |
| Authorization | `validateFilesWrite` / `validateBugsWrite` / `validateSettingsWrite` diff old vs new blob | Rules live in the diff rather than in a per-document write |
| Realtime | `/api/events` SSE, in-memory listeners, broadcast `{key, rev}` | Single process only |
| UI | 17 global-object modules (`TestCaseModule`, `BugReportModule`, …), `index.html` ~1000 lines, CDN libs (Chart.js, xlsx, exceljs, jsPDF, Quill) | No components, no types |
| AI | `/api/testforge/generate`, `/api/bug/analyze` → Gemini `gemini-2.0-flash` | Fine; port as-is |
| Tests | `qa-app/test/*.check.js`, `node --test` | Tied to globals |
| Deploy | `deploy.yml` ssh → `git reset --hard` → `systemctl restart bugrail` | Keep shape, swap start command |

## Target architecture

```
bugrail/
└── web/                       Next.js 15+, App Router, TypeScript, Tailwind
    ├── app/
    │   ├── (auth)/login/page.tsx
    │   ├── (app)/[workspace]/dashboard|testcases|bugs|board|summary|report|activity|settings|users|master/
    │   └── api/
    │       ├── testforge/generate/route.ts
    │       ├── bug/analyze/route.ts
    │       └── events/route.ts      SSE (ReadableStream)
    ├── lib/
    │   ├── db.ts                    MongoClient singleton (globalThis cache in dev)
    │   ├── repo/                    testcases.ts, bugs.ts, files.ts, users.ts, settings.ts, counters.ts, activity.ts
    │   ├── auth.ts                  session (iron-session or Auth.js credentials), bcrypt
    │   ├── permissions.ts           port of Auth.can() + PERMISSION_KEYS
    │   └── domain/                  pure ports of BUG_FORM, TC_IMPORT, statusTransitionRule, ReportCalc, NotifCalc, WorkspaceCalc, IdGen
    ├── actions/                     Server Actions: createTestCase, updateBug, moveBugStatus, shareFile …
    └── components/                  client components per module
```

- **Writes:** Server Actions (or route handlers) doing per-document `insertOne` / `updateOne`. The whole-array `PUT`, `rev`, `KvMerge` and `qa_unsynced_v2` go away.
- **Reads:** Server Components query Mongo directly through `lib/repo/*`. Client lists use `useSWR` / React Query against route handlers when they need live refresh.
- **Auth:** server session cookie (httpOnly), bcrypt hashes. `middleware.ts` gates `(app)` routes. Role/workspace come from the session. Headers no longer carry them.
- **Authorization:** every Server Action calls `requirePermission(session, 'bugreport_update')` and `requireWorkspace(session, file)`. These replace the three `validate*Write` diffing functions.
- **Realtime:** `/api/events` SSE ported to a route handler. Source of events: MongoDB **change streams** (needs a replica set; a single-node `rs0` replica set is enough on the VM). Without a replica set, keep the in-process broadcast fired from Server Actions (single instance only, same as today).

## MongoDB schema (normalized from kv blobs)

| Collection | From | Key fields | Indexes |
|------------|------|-----------|---------|
| `users` | `settings.users` | `_id`, `email`, `passwordHash`, `role`, `workspaceIds[]` | `email` unique |
| `workspaces` | `settings.workspaces` | `_id`, `name` | — |
| `roles` | `settings.roles` + `rolePermissions` | `_id` (value), `label`, `permissions[]` | — |
| `settings` | rest of `qa_settings` (bugStatusMaster, …) | one doc per top-level key | — |
| `files` | `qa_files` | `_id`, `name`, `workspaceId`, `sharedWith[]` | `workspaceId`, `sharedWith` |
| `testcases` | `qa_testcases` | `_id`, `code` (TC-…), `fileId`, `module`, status fields, `updatedAt` | `fileId`, `{fileId, module}`, `code` unique |
| `bugs` | `qa_bugs` | `_id`, `code` (BUG-…), `fileId`, `testCaseId`, `status`, `severity`, `priority`, attachments | `fileId`, `testCaseId`, `status`, `code` unique |
| `counters` | `qa_counters` | `_id` (sequence name), `seq` | — |
| `activity_log` | `qa_activity_log` | `ts`, `actor`, `action`, `target` | `ts` desc; TTL or cap at 1000 via capped collection |

ID generation: `counters.findOneAndUpdate({_id}, {$inc:{seq:1}}, {upsert:true, returnDocument:'after'})`. This replaces client-side `IdGen`, which can collide across tabs today.

Concurrency: per-field `$set` with `updatedAt`. Bug board drag-drop uses `updateOne({_id, status: from}, {$set:{status: to}})` so a stale move fails loudly.

## Phases

### Phase 0: Scaffold (1–2 days)
- `web/` with `create-next-app` (TS, Tailwind, App Router, ESLint).
- `lib/db.ts` singleton reading the existing `MONGO_URI` / `DB_NAME`.
- Vitest set up; port `qa-app/test/*.check.js` logic tests against `lib/domain/*` first. They are pure, so this is the cheapest win.

### Phase 1: Domain + data migration (2–3 days)
- Port pure logic into `lib/domain/` as TS: `BUG_FORM`, `TC_IMPORT`, `statusTransitionRule`, `compareRows`, `moduleAbbrev`, `ReportCalc`, `NotifCalc`, `WorkspaceCalc`, `normPriority`.
- `scripts/migrate-kv.ts`: reads `kv_store`, writes the normalized collections, hashes plaintext passwords with bcrypt, keeps `code` values, sets `counters` to the max existing seq. Idempotent: upsert by `_id`. Dry-run flag prints counts.
- Keep `kv_store` untouched (rollback path).

### Phase 2: Auth + shell (2–3 days)
- Login page, session, `middleware.ts`, workspace picker (port `WorkspacePicker` + "must pick workspace" rule from commit `20f940e`).
- `permissions.ts` port of `Auth.can()`; role permission matrix reads `roles`.
- Layout: sidebar, dark/light (Tailwind `class` strategy), toasts, dialogs (`confirmDialog`, `promptDialog`, `fileCreateDialog`, `fileEditDialog` → shadcn/ui Dialog or native `<dialog>`).

### Phase 3: Test Case + Files (4–5 days)
- File/folder CRUD + share across workspaces (`testcase_fileShare`).
- Test case table: filter, sort, pagination (`bindPageSize`), bulk update, row actions.
- Import/export Excel/CSV: `xlsx` + `exceljs` as npm deps, run in client components (or a route handler for large files).
- TestForge UI → `/api/testforge/generate` route (port prompt builder, rate limiter, `TESTFORGE_ENABLED` gate).

### Phase 4: Bug Report (4–5 days)
- Bug list, form (Quill → `react-quill-new` or Tiptap), attachments, code `BUG-…`.
- Failed test case → Create Bug autofill, `/api/bug/analyze`.
- Board drag-drop (`@dnd-kit`), status flow rules incl. QA-only transitions with mandatory note.
- Master Status CRUD.

### Phase 5: Dashboard, Summary, Report, Notifications, Activity Log (3–4 days)
- Chart.js → `react-chartjs-2`.
- Summary/Report PDF via `jspdf` + `jspdf-autotable` in the client.
- Notification center from `NotifCalc`.
- Activity log written inside every Server Action (one helper `logActivity()`). Today the client writes it.

### Phase 6: Settings, User Management, Backup (2 days)
- User CRUD with password reset (hash), role CRUD, settings.
- JSON backup/restore → export/import of all collections (admin only).

### Phase 7: Realtime + cutover (2 days)
- `/api/events` from change streams; client `EventSource` → `router.refresh()` / SWR `mutate`.
- Run `migrate-kv.ts` for real, smoke test, switch systemd unit to `next start -p 3001` (keep the port so nginx stays unchanged).
- `deploy.yml`: `cd web && npm ci && npm run build`, then restart.
- After 2 weeks stable: delete `qa-app/`, `server/`, drop `kv_store`.

**Total:** ~20–26 dev days.

## Risks

| Risk | Mitigation |
|------|-----------|
| Plaintext password users can't log in after hash | Migration hashes the existing plaintext, so the same password keeps working |
| Change streams need a replica set | Single-node `rs0` on VM, or fall back to in-process broadcast |
| Big-bang cutover | `kv_store` kept read-only for rollback; old app stays runnable on another port during UAT |
| Offline mode lost (localStorage fallback) | Accepted: online-only. If offline is a requirement, see the Turso plan |
| Client-side libs (xlsx, jsPDF) bloat bundle | `next/dynamic` import on the pages that use them |

## Done when
- All `qa-app/test` behaviours pass as Vitest against `lib/domain`.
- No endpoint trusts `x-role` / `x-workspace`.
- Two browsers editing different bugs in the same file never trigger a conflict dialog.
- `kv_store` row counts == normalized collection counts (migration report).
