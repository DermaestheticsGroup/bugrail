# BugRail → Next.js 16 + MongoDB: Migration Plan v2

> Replaces v1 (`2026-10-13-nextjs-mongodb.md`) and the Postgres/Prisma spec (`specs/2026-08-11-bugrail-next-migration-design.md`), which was never built (no `BugRail-Next/` exists).
> Cross-checked 2026-10-13 against commit `33e1e49` and the registry and docs: `next@16.4.0` (Node ≥ 20.9), `mongodb@7.7.0` (Node ≥ 20.19), `iron-session@9.0.1` (Node ≥ 22.13).

## Direction

These are decisions. Change one before Phase 1 starts or not at all.

1. **One app.** `web/` holds a Next.js 16 App Router app in TypeScript. At cutover it replaces both `qa-app/` and `server/`. The VM runs Node 24 LTS.
2. **Same database, real collections.** MongoDB stays. The 6 `kv_store` blobs become 9 collections, plus a `code_locks` helper, with one document per record. Production looks like Atlas (`qa-app/js/utils.js:88`, DNS workaround in `server/db.js`); Atlas is always a replica set, so change streams and transactions work as-is. Step M0.3 confirms this.
3. **Same ids, same codes.** Every existing `id` string becomes `_id`, so `#bug=<id>` links keep working. Display codes keep today's rule, which now runs on the server inside a transaction.
4. **Port, don't redesign.** `qa-app/css/style.css` becomes the global stylesheet, with the same class names in JSX. No Tailwind and no UI kit. A restyle can follow later.
5. **Auth lives on the server.** An iron-session cookie plus `node:crypto` scrypt hashes, with no extra hashing dependency. `proxy.ts` only redirects anonymous page loads. Every Server Action and route handler checks the session itself, as the Next.js docs require.
6. **One write path, one live path.** Writes are Server Actions. Live refresh is one SSE route fed by a change stream, which calls `router.refresh()`.
7. **No secrets in the browser.** `geminiApiKey` moves to a server-only doc. Theme becomes a per-browser preference.
8. **Online-only.** The `Storage.offlineBoot` fallback is dropped. If offline matters, follow the Turso plan instead.

## Cross-check: what v1 got wrong

| # | v1 said | Code / docs say | v2 does |
|---|---------|-----------------|---------|
| 1 | Test case codes look like `TC-…`; ids come from a `counters` `$inc` | Test case code = `moduleAbbrev(module)-NNNN`, bug code = `BUG-NNNN`, both counted per workspace of the file. Next = highest code in use + 1, so deletes free numbers (`testcase.js:40-45`, `bugreport.js:48-52`, `utils.js:450-462`). `qa_counters` is legacy | Same rule on the server, serialized by a transaction (M5.2). `counters` is dropped |
| 2 | `middleware.ts` | Next 16 renamed it `proxy.ts` (Node runtime). The docs say to verify auth inside every Server Function, not in the proxy alone | `proxy.ts` handles redirects only; `requireUser()` runs in every action and route |
| 3 | Change streams need a single-node `rs0` on the VM | Production appears to be Atlas, which is already a replica set | Use change streams and transactions directly. Dev uses a `--replSet rs0` container |
| 4 | Flat document fields only | Bugs embed `activity[]` (`bugreport.js:331`), `comments[]` (`:557`) and `assignments[]` (`auth.js:207`). A whole-doc write loses a concurrent comment | These stay embedded and are only appended with `$push` |
| 5 | Settings = one doc per key | `qa_settings` mixes users with plaintext passwords (`auth.js:17-19,218-221`), workspaces, roles, `rolePermissions`, `bugStatusMaster`, `customFieldDefs`, a shared `theme` (`app.js:280`) and `geminiApiKey`. Every browser gets the key and posts it back (`settings.js:25`, `testforge.js:191`) | Split into `users`, `workspaces`, `roles`, `config` and a server-only `secrets` |
| 6 | Activity log uses a capped collection or TTL | The 1000-entry cap only existed to keep one blob small (`activitylog.js:5-10`) | Plain collection with a `{ts:-1}` index, paginated, no cap |
| 7 | Hash passwords with bcrypt | The stdlib already has scrypt | `node:crypto` scrypt with `timingSafeEqual` |
| 8 | Backup = export the collections | Today's backup JSON includes `settings`, so plaintext passwords and the API key go into a file (`export.js:30-35`) | Backup leaves out `passwordHash` and secrets. Admin only |
| 9 | Tests run under `node --test` | `qa-app/test/*.check.js` are standalone scripts that load code with `vm` plus regex (`storage.check.js:1-10`) | The 8 domain checks move to Vitest. `storage.check.js` is dropped because `Storage` is deleted |
| 10 | "nginx unchanged", deploy with `npm install --omit=dev` | Nothing shows nginx exists. `next build` needs devDependencies. iron-session 9 needs Node ≥ 22.13 | `npm ci && npm run build` on Node 24 (M0.2, M7.2) |
| 11 | `xlsx` moves to an npm dependency | npm's latest `xlsx` is still `0.18.5`, which has CVE-2023-30533 (prototype pollution) and CVE-2024-22363 (ReDoS). Import parses user files | Use `xlsx` 0.20.3 from the SheetJS CDN tarball |
| 12 | Nothing about status rename | Status is stored by name, and a rename rewrites every bug (`masterstatus.js:126`) | Keep names; the rename runs as one transaction: `config` `$set` plus bugs `updateMany` |
| 13 | Nothing about body size | `express.json({limit:'20mb'})` existed only for whole-blob PUTs. Server Actions default to 1 MB | Per-doc writes are small. Excel import sets `experimental.serverActions.bodySizeLimit: '10mb'` (M5.3) |

## Inventory: what migrates

| kv key (shape) | Record fields (copy **all**; normalize only those listed) | Target |
|----------------|------------------------------------------------------------|--------|
| `qa_testcases[]` | `id, code, fileId, module, roleUser, scenario, testCase, preconditions, steps (HTML), testData, expectedResult, typeTest, status, actualResult, evidence, executionDate, customFields{}, createdBy, createdAt`. Normalize `status 'Not Run'→'Open'` (`app.js:26`) | `testcases` |
| `qa_bugs[]` | `id, code, fileId, testCaseId, title, module, severity, priority, status (name), description, steps, expectedResult, actualResult, platform, environment, browser, device, buildVersion, attachments (newline URLs), tester, assignee, reportDate, activity[], comments[], assignments[]`. Normalize `priority Highest/Critical→Urgent` (`utils.js:427`) | `bugs` |
| `qa_files[]` | `id, name, workspaceId, sharedWith[], createdBy, createdAt` | `files` |
| `qa_settings{}` | `users[] {email, password, role, workspaceIds, workspaceId}` → hash the password, legacy `workspaceId` → `workspaceIds` | `users` |
| | `workspaces[]` | `workspaces` |
| | `roles[] {value,label}` + `rolePermissions{role:{perm:bool}}`, merged with defaults (`app.js:34-39`) | `roles` |
| | `bugStatusMaster[] {code,name,color,order}`, `customFieldDefs[] {label}` | `config` (`_id:'app'`) |
| | `geminiApiKey` | `secrets` (`_id:'gemini'`) |
| | `theme` | dropped; becomes a per-browser cookie |
| `qa_activity_log[]` | `id, ts, actorEmail, actorRole, workspaceId, action, label` | `activity_log` |
| `qa_counters{}` | legacy (`IdGen.next`, no live caller) | dropped |
| `qa_trash` | never sent to the server (`server/app.js:5`) | not migrated |

Test cases or bugs with no `fileId` get `FILE-DEFAULT`, the same as `ensureDefaultFile` (`app.js:45-60`).

## Target layout

```
web/
├── proxy.ts                         redirect anonymous page loads to /login (pages only)
├── next.config.ts                   serverActions.bodySizeLimit, no other custom config
├── instrumentation.ts               opens the change stream once per process
├── app/
│   ├── globals.css                  = qa-app/css/style.css
│   ├── login/page.tsx
│   ├── page.tsx                     legacy shims: #bug=<id> → /bug/<id>; ?rptModule&rptRound → report
│   ├── bug/[id]/page.tsx            resolves workspace, redirects into /w/[ws]/bugs/…
│   ├── w/[ws]/                      ws = workspace id or "__all__" (admin) — replaces sessionStorage
│   │   ├── layout.tsx               sidebar, topbar, switcher, toasts, dialogs, shortcuts
│   │   ├── dashboard/ summary/ report/ activity/ import-export/
│   │   ├── testcases/  testcases/[fileId]/
│   │   ├── bugs/  bugs/[fileId]/  bugs/[fileId]/board/  bugs/[fileId]/[bugId]/
│   │   └── settings/ master/status/ users/ roles/ workspaces/
│   └── api/
│       ├── events/route.ts          SSE
│       ├── search/route.ts          topbar global search
│       ├── testforge/generate/route.ts
│       └── bug/analyze/route.ts
├── actions/                         'use server': files.ts testcases.ts bugs.ts master.ts users.ts roles.ts workspaces.ts settings.ts backup.ts auth.ts
├── lib/
│   ├── db.ts                        MongoClient singleton (globalThis cache in dev)
│   ├── auth.ts                      session, scrypt, requireUser, requirePermission, requireFileAccess
│   ├── live.ts                      change stream → subscriber fan-out
│   ├── activity.ts                  logActivity() — called inside every mutating action
│   ├── repo/                        only place that calls db.collection(); one module per collection
│   └── domain/                      pure ports from qa-app/js (no DOM, no App.state)
└── scripts/
    ├── migrate-kv.ts                kv_store → collections (idempotent, --dry-run)
    └── export-to-kv.ts              collections → kv_store blobs (rollback path)
```

## Collections and indexes

| Collection | `_id` | Indexes |
|------------|-------|---------|
| `users` | ObjectId | `{email:1}` unique (stored lowercase) |
| `workspaces` | old id | — |
| `roles` | role value | — |
| `config` | `'app'` | — |
| `secrets` | `'gemini'` | — (read only in route handlers) |
| `files` | old id | `{workspaceId:1}`, `{sharedWith:1}` |
| `testcases` | old id | `{fileId:1}` |
| `bugs` | old id | `{fileId:1}`, `{testCaseId:1}`, `{status:1}` |
| `activity_log` | old id | `{ts:-1}` |
| `code_locks` | workspace id or `'_shared'` | — (transaction serializer) |

No unique index on `code`: legacy data already has duplicates from concurrent creation under `KvMerge`. The migration reports them and doesn't renumber them.

## Write rules (the whole concurrency story)

```ts
// Display code: today's rule (utils.js:455), serialized per workspace scope.
await client.withSession(s => s.withTransaction(async () => {
  await codeLocks.updateOne({ _id: scope }, { $inc: { v: 1 } }, { upsert: true, session: s }); // write conflict = queue
  const max = await maxCodeInScope(coll, prefix, scope, s);   // files in scope → their rows → highest PREFIX-NNNN
  await coll.insertOne({ ...doc, code: `${prefix}-${String(max + 1).padStart(4, '0')}` }, { session: s });
}));

// Append-only logs: never replace the array.
await bugs.updateOne({ _id }, { $push: { comments: { at, email, text } } });

// Board move: from-status guard; 0 matched = someone moved it first → toast + refresh.
await bugs.updateOne({ _id, status: from }, { $set: { status: to }, $push: { activity: { at, from, to, note, attachment, email } } });

// Field edits: $set only the fields the form changed (no whole-doc replace).
```

## Steps

Every step has a check. Don't start a phase until the previous gate passes.

### Phase 0: Prep (1 day)
- [ ] **M0.1** Freeze the parity list: the pages in `app.js:118-131` plus the features in `README.md`. Each becomes a row of the G5 checklist. *Check:* the checklist file `docs/parity-checklist.md` exists.
- [ ] **M0.2** On the VM, `node -v`. Install Node 24 LTS if it is below 22.13. *Check:* `node -v` ≥ 24.
- [ ] **M0.3** `mongosh "$MONGO_URI" --eval 'db.hello().setName'` must print a set name. Then `db.kv_store.watch()` must open without error. *Check:* both pass. If the set name is empty, convert to a single-node replica set before Phase 6.
- [ ] **M0.4** `mongodump --uri "$MONGO_URI" --db "$DB_NAME" --out backup-$(date +%F)`. *Check:* the dump restores into a local `mongo:8 --replSet rs0` container.

### Phase 1: Scaffold (1–2 days)
- [ ] **M1.1** `npx create-next-app@16 web --typescript --app --no-tailwind --no-src-dir --import-alias "@/*" --use-npm`.
- [ ] **M1.2** Copy `qa-app/css/style.css` to `web/app/globals.css`. Load Plus Jakarta Sans and JetBrains Mono with `next/font/google`, replacing the Google Fonts `<link>` at `index.html:8`.
- [ ] **M1.3** `lib/db.ts` reads `MONGO_URI` and `DB_NAME` (the same env names as `server/.env`). Add `GET /api/health` → `{db:'ok'}`.
- [ ] **M1.4** `npm i -D vitest`; `npm test` = `vitest run`.
- **Gate G1:** `npm run build` passes and `/api/health` is ok against the restored dump.

### Phase 2: Domain logic (2–3 days)
- [ ] **M2.1** Copy pure logic into `lib/domain/*.ts`, adding types and changing no behavior: `BUG_FORM`, `TC_IMPORT`, `statusTransitionRule`, `compareRows`, `moduleAbbrev`, `IdGen.nextInScope`, `normPriority`, `bugCode`/`tcCode`, `computeBugResolutionStats`, `textToStepsHtml`/`stepsHtmlToText`, `detectLang` (all from `utils.js`); `ReportCalc` (`report.js`); `NotifCalc` (`notifications.js`); `WorkspaceCalc` (`workspace.js`); `DEFAULT_ROLES`, `PERMISSION_KEYS`, `DEFAULT_ROLE_PERMISSIONS` and `can()` (`auth.js`). `safeStepsHtml` stays client-only because it needs a DOM.
- [ ] **M2.2** Port `bugcode`, `bugform`, `filedelete`, `notifications`, `report`, `statusflow`, `tcimport` and `workspace` `.check.js` to Vitest, one `*.test.ts` each, with the same assertions.
- **Gate G2:** `npm test` is green, and every old assertion has a matching new one.

### Phase 3: Data (3–4 days)
- [ ] **M3.1** `lib/repo/*`: one module per collection. Nothing else imports `db`.
- [ ] **M3.2** `scripts/migrate-kv.ts` is self-contained (only `mongodb` and `node:crypto`) and runs with `node scripts/migrate-kv.ts [--dry-run]`. Node 24 strips the types. It reads `kv_store`, applies the inventory normalizations, upserts by `_id`, creates the indexes and prints a report: counts per collection, duplicate codes per scope, orphan rows moved to `FILE-DEFAULT`, users hashed. `kv_store` is never written.
- [ ] **M3.3** `scripts/export-to-kv.ts` rebuilds the 6 blobs from the collections (the reverse of M3.2) and writes them to `kv_store` with `rev + 1`. Passwords: users who existed at cutover get their old plaintext back from `kv_store.qa_settings`, which is untouched until M7.5. Users created or reset after cutover get a temporary password, printed for the admin.
- [ ] **M3.4** Rehearse on the restored dump: migrate, export, then diff the exported blobs against the originals.
- **Gate G3:** counts match blob lengths, and the diff is empty except for normalized fields and passwords. A script logs in every migrated user with their old password through `verifyPassword()`.

### Phase 4: Auth and shell (3 days)
- [ ] **M4.1** `lib/auth.ts`:
  - iron-session cookie `bugrail_session` = `{userId, sessionVersion}` (httpOnly, sameSite `lax`, 7 days).
  - `hashPassword`/`verifyPassword` via scrypt with a 16-byte salt.
  - `requireUser()` checks `sessionVersion` against the user doc.
  - `requirePermission(user, key)` uses `can()`.
  - `requireFileAccess(user, file, ws)` ports `validateFilesWrite`/`validateBugsWrite` (`server/app.js:64-167`) to one-document checks.
- [ ] **M4.2** `actions/auth.ts` `login`/`logout`, with `logActivity` (parity with `auth.js:246`). Login is rate-limited per IP using the TestForge limiter.
- [ ] **M4.3** `proxy.ts` matcher: `'/((?!api|_next/static|_next/image|login|favicon.ico).*)'`. With no cookie it redirects to `/login`. `/api` is excluded on purpose: those handlers check the session themselves, and TestForge bodies (up to 5 images) never pass through the proxy.
- [ ] **M4.4** `w/[ws]/layout.tsx` ports the sidebar, with nav visibility from `applyNavPermissions` (`app.js:213-235`). It also ports the topbar, the workspace switcher (commit `20f940e`: pick a workspace when the user has 2+), the theme cookie, toasts, `<dialog>`-based confirm/prompt/file dialogs (`utils.js:569-764`) and keyboard shortcuts (`app.js:402-419`).
- [ ] **M4.5** Legacy shims in `app/page.tsx`: a client effect reads `#bug=` → `/bug/<id>`, and `?rptModule&rptRound` → `/w/<ws>/report?...` with the same param names (`report.js:271`).
- **Gate G4:** for each seeded role, nav items match the old app logged in with the same role. Calling any action with no cookie gets a 401 or a redirect.

### Phase 5: Feature parity (10–13 days)
- [ ] **M5.1** Files: list, create, rename, share (`testcase_fileShare`), and delete with cascade, all in one transaction (`app.js:64-71`). Undo = re-insert the deleted docs with the same ids.
- [ ] **M5.2** Test cases: table (filter, sort with `compareRows`, page sizes 10/25/50/100, bulk update), form with custom fields, execute (status plus `executionDate`), duplicate (`testcase.js:624`) and detail. Codes come from the write rule above.
- [ ] **M5.3** Import and export: parse in the browser (`xlsx` 0.20.3), validate with `TC_IMPORT`, then `importTestCases(fileId, rows)`. The server re-validates and assigns all codes in one transaction. Template download and Excel/CSV export run client-side (`exceljs`). Set `experimental.serverActions.bodySizeLimit: '10mb'`.
- [ ] **M5.4** TestForge: port `/api/testforge/generate` verbatim (`server/app.js:218-331`: field filter, prompt builder, 10 requests per 5 min limiter, `TESTFORGE_ENABLED` gate). Add `requireUser()`. Read the key from `secrets` or `GEMINI_API_KEY`. The body no longer carries `apiKey`. Saving goes through `importTestCases`.
- [ ] **M5.5** Bugs:
  - list, plus a form that runs `BUG_FORM` rules on both client and server
  - create from a failed test case (autofill, `bugreport.js:849-850`) and the similar-bug warning
  - detail timeline (activity and comments via `$push`) and assignee with an `assignments` `$push`
  - board with native HTML5 drag and drop, `moveBugStatus` with the from-guard, and `statusTransitionRule` re-checked on the server
  - Excel/CSV export and import, and `/api/bug/analyze` (with `requireUser()`)
- [ ] **M5.6** Master status: CRUD. Rename = a transaction `{ config $set, bugs.updateMany({status: old}, {$set:{status: new}}) }`. Deleting a status that is in use stays blocked (`masterstatus.js:148`).
- [ ] **M5.7** Dashboard (Chart.js 4, plain, `useEffect`), Summary plus PDF (`jspdf` 4 and `jspdf-autotable`, loaded with dynamic import on click), Report with URL filters, the notifications bell (`NotifCalc`; seen-state stays in localStorage, `notifications.js:60`), and `/api/search` (6 hits per group, permission-filtered).
- [ ] **M5.8** Activity log page (paginated `{ts:-1}`). Every mutating action calls `logActivity()`; the client no longer writes the log.
- [ ] **M5.9** Settings: custom fields, Gemini key into `secrets` (masked), clear-all (admin plus confirm). Users: CRUD, and reset password = hash plus `sessionVersion++`. Roles matrix and workspaces (admin). Backup and restore JSON: admin only, no secrets in the backup; restore = one transaction replacing testcases and bugs, as today. Steps editor = `quill@2` mounted in a client component; render through the ported `safeStepsHtml`.
- **Gate G5:** a QA lead ticks every row of `docs/parity-checklist.md` on staging loaded with the prod dump.

### Phase 6: Live refresh (1–2 days)
- [ ] **M6.1** `lib/live.ts`: one `db.watch([{ $match: { 'ns.coll': { $in: ['testcases','bugs','files','config','workspaces','roles','users'] } } }])` per process, opened from `instrumentation.ts`. It fans `{coll, id}` out to subscribers and reopens with the last resume token on error.
- [ ] **M6.2** `app/api/events/route.ts`: `dynamic = 'force-dynamic'`, `requireUser()`, a `ReadableStream`, and the headers `text/event-stream`, `Cache-Control: no-cache, no-transform`, `X-Accel-Buffering: no`. It pings every 25 s (parity with `server/app.js:177-184`).
- [ ] **M6.3** `useLiveRefresh()`: `EventSource` → 300 ms debounce → `router.refresh()`, deferred while the user is busy. This ports `isUserBusy` from `app.js:197-205`: typing, an open modal other than the bug chat, or a drag in progress.
- **Gate G6:** with two browsers, an edit in A shows in B within 2 s, and an open form in B keeps its input.

### Phase 7: Cutover (1–2 days, then 2 weeks of watching)
- [ ] **M7.1** Rehearse the whole runbook on staging and time it.
- [ ] **M7.2** In `.github/workflows/deploy.yml`, replace the `server/` block with `cd /opt/qa-monitor/web && npm ci && npm run build && sudo systemctl restart bugrail`. The systemd `ExecStart` becomes `npm run start -- -p 3001` with `WorkingDirectory=/opt/qa-monitor/web`. Env: `MONGO_URI`, `DB_NAME`, `GEMINI_API_KEY`, `SESSION_PASSWORD` (32+ chars), `TESTFORGE_ENABLED`.
- [ ] **M7.3** Runbook:
  1. Announce a freeze.
  2. `systemctl stop bugrail`.
  3. `mongodump`.
  4. `node scripts/migrate-kv.ts`.
  5. Deploy `web/`.
  6. Start the service.
  7. Smoke test: log in, create a test case, create a bug, move it on the board, check the SSE refresh in a second browser.
  8. Lift the freeze.
- [ ] **M7.4** Rollback (first 48 h): stop the service, run `node scripts/export-to-kv.ts`, point the unit back at `server/`, start it.
- [ ] **M7.5** After 2 weeks stable: take a final `mongodump`, drop `kv_store`, delete `qa-app/` and `server/`.

**Estimate:** 22–30 dev days.

## Risks

| Risk | Mitigation |
|------|-----------|
| Atlas tier limits change streams | M0.3 checks this before any code. The fallback is an in-process emitter called from actions (single process, same as today) |
| `router.refresh()` lands mid-edit | Busy guard (M6.3). Client state in forms is kept by React; only server props refresh |
| Offline demo mode goes away | Accepted (Direction 8) |
| Rate limiter and SSE fan-out are per process | Same as today. Run one `next start` process |
| Gemini model `gemini-2.0-flash` (`server/app.js`) retired by Google | Check it in M5.4. The model name becomes `GEMINI_MODEL` env with today's value as the default |

## Done when
- Every row of `docs/parity-checklist.md` is ticked on prod data.
- No request handler reads `x-role`, `x-workspace` or `x-can-share`. `geminiApiKey` never reaches a browser (grep the client bundle).
- Two users adding comments to the same bug at the same second both see both comments.
- `KvMerge`, `rev`, `qa_unsynced_v2` and `offlineBoot` don't exist in `web/`.
