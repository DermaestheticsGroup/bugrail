# Phase 6b result: Bug Report

## Built
- `lib/client/bug-model.ts`: the legacy search, filters, sort and paging over local rows; status master (live rows, or the defaults); board grouping (an unknown status gets its own column instead of being dropped); reopen count; status-rule check for a batch; test case prefill; similar-bug check; platform inference for old bugs; `extra` reader.
- `lib/client/bugs.ts`: create, edit, limited edit (status and priority only), status moves for one or many bugs, comments, delete, each with the legacy validation (`BUG_FORM.errors`), the transition rule, the required note, assignment and status events, and an activity row.
- `components/bug-screen.tsx`: table with filters, sort, paging, selection and a bulk bar; board with drag and drop plus a "Move to" select; bug form (test case picker and prefill, "from test case" boxes, similar-bug hint, conditional browser/device, field lock for limited edit, AI analyze button); detail page with the timeline (Comments, Activity, All), comments, reopen count and attachments. `components/status-note.tsx`: the reason and attachment dialog. `components/file-list.tsx`: the file list, now shared by Test Case and Bug Report.
- "Create Bug" on a Failed test case opens the form linked and prefilled; `#bug=<id>` links open the detail page.
- Bug events get monotonic HLC ids, so events written in the same millisecond keep their order (a flaky test found this).
- Service worker: documents and payloads are cached when a route is opened as a real page load. Anything not cached gets a readable offline page that lists the routes that do work, instead of a bare error.

## Evidence
- `bun test`: all pass (see the PR for the count); `tsc` clean; `next build` passes.
- `scripts/g6b-e2e.cjs` (headless Chrome 155): create-from-test-case prefill and link; legacy validation messages; AI analyze without a key fails gracefully; create with a server code within 15 s; similar-bug hint; QA rule blocks a move out of Open in the form; comments reach a second user and replies come back; `#bug=` link; board drag and drop; the note dialog (cancel changes nothing, empty note refused, with a note it moves and is recorded); reopen count after Retest; PM limited edit (title locked, priority changes); bulk status with a note and bulk delete; the deletion reaches another browser.
- `scripts/g5-e2e.cjs` (offline, sync, isolation, user switch) was ported to the new Bug Report UI and passes; `scripts/g6a-e2e.cjs` still passes after the shared file list refactor.

## Browser finding worth knowing
- A route reloads offline only if it was opened as a real page load while online. Opening it only through soft navigation caches its payload but not its document, and a stale payload for a never-loaded document cannot render. I tried having the page tell the worker to fetch the document; the worker fetch returned the same HTML but the reload still failed, so I did not keep it. The offline page makes the limit visible instead.

## Not done or not checked
- No real Gemini answer was exercised (no key); only the failure path.
- Sorting and paging have unit tests but were not driven in the browser; drag and drop was driven with Playwright's `dragTo`, not a real pointer on a touch device.
- Print uses `window.print()` of the whole page (the legacy single-bug print layout is not ported); Excel/CSV import and export of bugs and the import template are slice 6d.
- Assignee list comes from the config users of the file's workspace; a user created after the config was cached shows up after the next config refresh.
- Reopen count counts REOPENED and RETEST status events, as the legacy did for `to === 'Reopened' || 'Retest'`.
- Chrome only.
- The note-required half of the transition rule is enforced in the client only; the server does not check it on push. Known gap.
