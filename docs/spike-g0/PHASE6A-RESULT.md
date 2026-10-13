# Phase 6a result: Files and Test Case

## Built
- `lib/client/files-testcase.ts`: rename, share and unshare (share id `<file>:<workspace>`, revived instead of duplicated), cascade delete (tombstones the file, its test cases and bugs), test case save/edit/execute/duplicate/bulk status/bulk delete, each with an activity-log row.
- `lib/client/testcase-model.ts`: the legacy search (every word, reaches inside step HTML), filters, natural sort by visible code, paging.
- `components/testcase-screen.tsx`: file list (own plus shared-with-you), file editor with sharing, file view (search, filters, sort, paging, selection, bulk bar, form, run, detail, duplicate, delete), under `/w/<ws>/testcases[/<fileId>]`.
- `components/rejected-panel.tsx`: writes the server refused are listed with the reason and can be discarded (O2). `Shell` shows it on every screen.
- Activity rows are logged under a workspace the author belongs to (a vendor editing a shared file logs under its own workspace); before this the server refused them.

## Evidence
- `bun test` passes (includes `effectiveSelection` cases); `tsc` clean; `next build` passes.
- `scripts/g6a-e2e.cjs` (headless Chrome 155, three users plus an admin): create, rename, share and unshare a file; create test cases with codes within 15 s; search and reset; execute and filter by status; duplicate gets its own code; bulk status; vendor sees nothing before sharing, sees the file within 15 s of sharing and loses it within 15 s of unsharing; a write the server refuses after an admin removes a permission shows its reason and is discarded and reverts; an admin deleting a file removes it for the vendor and for QA.

## Not done or not checked
- No dialog for adding a new module (the module field suggests existing ones and accepts any new text), no toast or undo (browser `confirm` is used), no import, export, print, translate or TestForge (slice 6d), no Create Bug from a test case (6b).
- Bulk delete in the browser was not exercised: the only role with `testcase_delete` by default is admin, and the check used admin for file deletes only. The logic has unit tests.
- Chrome only; the page keeps visited screens mounted but hidden, so each hidden copy keeps querying the database (works, wasteful).
- Rejected writes: the panel shows the row id and table, not a human label.
