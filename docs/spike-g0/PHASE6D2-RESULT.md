# Phase 6d-2 result: import, export, backup and restore

Slice 6d is now 6d-1 (admin, merged), 6d-2 (this), and 6d-3 (TestForge and translate, print layout).

## Built
- `lib/client/io.ts`: legacy column sets and CSV (`arrayToCSV`, quoted cells, CRLF); test case export rows (plain-text steps, custom fields as columns, one sheet per module with its own numbering, sheet names cleaned, deduplicated and cut to 31 characters); bug export rows (code, test case label, status name, day, extra fields); the import template; `parseImport` reads every sheet through the existing `TC_IMPORT.parseSheet`; `importTestcases` is all-or-nothing and writes new Open cases without a code (the server numbers them, in file order per module); JSON backup of this device's synced tables and `restoreBackup`, which upserts by id with fresh clocks (existing rows keep their server code, new ones get none and are numbered on push).
- `components/import-export-screen.tsx`: the Import & Export page.
- Dependency: SheetJS `xlsx` 0.20.3 from the SheetJS CDN tarball (the npm package is stale and has known advisories). It is only loaded by this screen's chunk.

## Evidence
- `bun test`: 322 pass (12 new in `test/client-io.test.ts`: CSV quoting, multi-sheet import, sheet name fallback, all-or-nothing, Bug template refusal, template round trip, export rows, sheet names, backup round trip, restore keeps codes, tombstones skipped); `tsc` clean; `next build` passes.
- `scripts/g6d2-e2e.cjs` (headless Chrome 155) with real uploads and downloads: template download and re-import, a bad CSV refused with the row named, Excel and CSV exports (zip magic and legacy header checked), bug exports, backup JSON content, a non-backup file refused, restore into a second user merging instead of duplicating.

## Not done or not checked
- Bug Report import and its template, and the single-bug print layout, are not ported.
- Excel files are plain: the legacy styling (header fill, borders, dropdown validation on Type Test and Status) needs ExcelJS and was left out.
- The legacy Google Sheets helper (copy Apps Script) is not ported.
- Restore does not clear anything and does not touch rows the file does not name. It reads only this app's JSON, not the old `QA_Backup_*.json` blob.
- A very large export or restore runs on the main thread.
- The Excel files were checked as valid archives and re-read by SheetJS, not opened in Excel.
- Chrome only.
