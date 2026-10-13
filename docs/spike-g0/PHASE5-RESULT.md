# Phase 5 result: client shell and offline

## Built
- Browser database: `lib/client/db.ts` opens the wasm Turso build on OPFS, one file per user (`bugrail-<userId>.db`), local migrations applied. `lib/client/serialize.ts` queues transactions on the single connection.
- Local writes: `lib/client/repo.ts` (`upsertRow`, `softDelete`, `addEvent`, `createFile/Bug/Testcase`, `liveRows`). Every write stamps a fresh HLC (and `status_hlc` only when a status column changes) and lands in the outbox. New rows get no code; the server assigns it.
- Sync engine: `lib/client/sync-engine.ts`. Push 1 s after the last write, pull on an SSE poke (500 ms debounce), on `online`, on tab visible and every 30 s; one network call at a time; 401 marks the session expired and keeps the outbox; failures are shown and retried. Clock guard: writes are refused past 5 minutes of skew against the server `Date` header.
- Shell: provider in `app/w/[ws]/layout.tsx` (database and engine stay open across soft navigation), nav gated by the local role matrix, workspace picker (admin also gets "all"), sync badge (online/offline, pending count, last pull), clock banner, online-only pages show "needs a connection". Routes under `/w/[ws]/<screen>`; Dashboard, Bug Report and Test Case have minimal real content (counts, list, quick add); every other screen is a placeholder for Phase 6.
- Boot: render first, authenticate second. A device with a stored user and local data opens at once, even offline; `/api/config` verifies in the background and only a 401 ends the session. A different user signing in closes and wipes the previous user's local database (warns when it holds unsent changes); a failed wipe aborts the login. A user mismatch or 401 in the background verify stops the sync engine and event stream before returning to the login screen.
- Server side added: `/api/config` (per-user filtered workspaces, members, roles, permission matrix), test case display codes on push, regex-safe prefixes in the server `nextInScope`.
- Service worker: shell and hashed assets cached, document and RSC requests network-first with a cached fallback (query-insensitive for RSC), `/api/*` never cached.

## Gate G5 evidence (headless Google Chrome 155, `scripts/g5-e2e.cjs`)
- Login lands in the shell, `crossOriginIsolated` true.
- Two online bugs get their codes within 15 s of being added.
- A bug created offline shows as pending, the badge says offline; an offline reload reopens the app with its data; offline soft navigation between screens works; on reconnect the code appears within 15 s and nothing stays pending.
- A second user in the same workspace bootstraps all bugs; a bug created in browser A reaches browser B within 15 s.
- A vendor sees no Alpha bugs and no Alpha workspace name.
- No uncaught page errors. 236 `bun test` tests pass, `tsc` clean, `next build` passes.

## Bugs the browser run found
- Typing in the add form while the previous add was still writing was lost; the field now clears before the write.
- Two quick adds each created a Default file; concurrent callers now share one lookup.
- Concurrent transactions on the one wasm connection are queued (`serializeTx`).
- Own settled writes (the assigned code) refresh the list at once; only other people's changes wait while the user is typing or dragging.

## Not done or not checked
- Chrome only. Safari, Firefox and Edge are untested, so G0.1, G0.2 (wasm half), G0.5 (browser half) and G0.6 remain open for them.
- The concurrent cold bootstrap (about 20 s at 30 clients) is unchanged: no paging, caching or staggering was added.
- Production-sized data is still untested (no production dump).
- Not built: toasts and dialogs, keyboard shortcuts, UI for parked rejected writes (they are stored, nothing shows them), the full login screen, the "different user" warning dialog and the close-then-wipe of OPFS files in a real browser (logic unit-tested in `test/client-switch-user.test.ts`, not exercised in Chrome), the `storage.persist()` result is requested but not shown.
- The clock banner and the 401 redirect have unit tests only, no browser test.
- `scripts/g5-e2e.cjs` needs a local Chrome and playwright-core; it is not in CI.
- Offline soft navigation works for routes whose links are on the page (prefetched) or visited before; an offline hard load of a never-visited URL falls back to a 503.
- Phase 6 screens, Phase 7 operations and cutover are untouched.
