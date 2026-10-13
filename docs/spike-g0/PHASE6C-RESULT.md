# Phase 6c result: Dashboard, Summary, Report, Notifications, Activity Log

## Built
- `lib/client/analytics.ts`: pure logic over local rows. `toDomain` maps snake_case rows (with status and assignment events folded into each bug) to the legacy records the domain calcs expect; dashboard stats, module bars, range filters, bug-per-file, the Summary analysis text (ported from `buildAnalysis`, bug statuses as codes), activity grouping and search, unread count.
- `components/analytics-screens.tsx`: Dashboard, Summary, Report, Activity Log. Charts are SVG and CSS bars, so there is no chart dependency to cache offline.
- `components/notif-bell.tsx`: the topbar bell, built from existing rows through `NotifCalc`. The last-seen time is kept per user on the device (`qa_notif_seen_<email>`, the legacy key).
- Report uses `ReportCalc` unchanged: verdict per module and for the app, reason sentence, must-fix list, reopen stats, fix speed against SLA, the PM/BA summary and next steps, and the round and module filters with their counts.

## Evidence
- `bun test`: 302 pass (20 new in `test/analytics.test.ts`); `tsc` clean; `next build` passes.
- `scripts/g6c-e2e.cjs` (headless Chrome 155) over data made through the UI: Dashboard numbers, module filter and reset, Summary analysis and filters, Report NO GO with its reason and must-fix list, the reminder, an assignment reaching a second user's bell with the badge clearing and the link opening the bug, Activity Log for admin (group filter, search, detail) and the refusal for a QA role.
- g5, g6a, g6b re-run on this head after the shell change (see the PR comment for the result).

## Differences from the legacy page, on purpose
- Charts are plain SVG and bars, not Chart.js.
- "Export PDF" is the browser's print. The legacy PDF layout and the Summary Excel export are not ported (print layout and Excel are 6d).
- Dashboard filters are module and tester; Summary adds file and date range, as legacy.
- Notification texts show status codes (OPEN, RESOLVED) rather than status names.

## Not done or not checked
- Chrome only. Sorting by every column and print output were not driven.
- Activity log is read from the local copy: it holds whatever has synced, with no 1000-entry cap enforced locally (the legacy FIFO cap).
- The Report must-fix and reopen lists were checked for the first item only in the browser.
