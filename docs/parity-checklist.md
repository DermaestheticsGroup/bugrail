# Parity checklist (G6)

Gate G6: a QA lead ticks every line below with 2 online browsers, 1 device that goes offline mid-session, and 1 vendor account.
Source of truth for behavior is `qa-app/js/*.js`. A line is ticked only after a person has done it in the new app.
Slice = which Phase 6 PR delivers it. Status in this file is the AUTHOR's claim; the tick column is the QA lead's.

| # | Feature (legacy source) | Slice | Built | QA tick |
|---|--------------------------|-------|-------|---------|
| **Files (shared by Test Case and Bug Report)** | | | | |
| F1 | List files visible to my workspace, with counts (`testcase.js:48-54`) | 6a | yes (Chrome) | |
| F2 | Create a file in the current workspace (`createFile`) | 6a | yes (Chrome) | |
| F3 | Rename a file (`editFile`) | 6a | yes (Chrome) | |
| F4 | Delete a file removes its test cases and bugs (`deleteFile`, `files.ts`) | 6a | yes (Chrome) | |
| F5 | Share a file into another workspace; unshare (`testcase_fileShare`) | 6a | yes (Chrome) | |
| F6 | Vendor sees own files plus files shared into its workspace, nothing else | 6a | yes (Chrome) | |
| **Test Case (`testcase.js`)** | | | | |
| T1 | List with search, filters (module, type, status), sort, pagination, reset filters | 6a | yes (Chrome) | |
| T2 | Create / edit via form with module combobox, add new module, custom fields | 6a | partly: module datalist and custom fields yes; no separate "add module" dialog | |
| T3 | Detail view | 6a | yes (Chrome) | |
| T4 | Execute (set status, actual result, evidence, execution date) | 6a | yes (Chrome) | |
| T5 | Duplicate | 6a | yes (Chrome) | |
| T6 | Delete one, bulk delete, bulk status update | 6a | bulk status: yes (Chrome); delete one and bulk delete: unit tests only (only admin holds testcase_delete by default) | |
| T7 | Display codes arrive from the server (`LOG-0001`) | done in Phase 5 | yes | |
| T8 | Create bug from a failed test case (prefill) | 6b | yes (Chrome) | |
| T9 | Import from Excel (`TC_IMPORT`), template | 6d | yes (Chrome); .xlsx and .csv, all-or-nothing; template is plain (no header styling or dropdowns) | |
| T10 | Export Excel / CSV, print | 6d | partial (Chrome): Excel (one sheet per module) and CSV; no styled sheets; print is the browser print of the page | |
| T11 | Translate active file (`translateActiveFile`) | 6d | UI and writes: yes (Chrome, MyMemory answered by a test stub); the real MyMemory service: not tested; text is sent to that third party, the confirm says so | |
| T12 | Generate test cases with AI (TestForge), online only | 6d | UI, review, edit, save: yes (Chrome, server answer stubbed). The real route's disabled message: yes. A real Gemini answer: NOT tested (needs `TESTFORGE_ENABLED=1` and a key) | |
| **Bug Report (`bugreport.js`)** | | | | |
| B1 | List, board (drag and drop), filters, sort, pagination | 6b | list, board drag and drop, filters: yes (Chrome); sort and pagination: unit tests only | |
| B2 | Create / edit form with test case link, similar-bug check, field lock, platform fields | 6b | yes (Chrome) | |
| B3 | Status change with transition rule and required note (`statusTransitionRule`) | 6b | yes (Chrome) | |
| B4 | Detail with timeline, comments, assignments, reopen count | 6b | yes (Chrome) | |
| B5 | Bulk delete, bulk status update | 6b | yes (Chrome), admin | |
| B6 | AI analyze a failed test case (online only) | 6b | button and graceful failure without a key: yes (Chrome); a real Gemini answer: not tested | |
| B7 | Import / export / template / print | 6d | partial (Chrome): Excel and CSV export only. Bug import, bug template and the single-bug print layout are NOT ported | |
| **Read-only screens** | | | | |
| R1 | Dashboard (`dashboard.js`) | 6c | yes (Chrome); module and tester filters only, SVG charts, PDF export is browser print | |
| R2 | Summary (`summary.js`) | 6c | yes (Chrome); analysis text and filters, no Excel export yet (6d) | |
| R3 | Report Go-Live with export (`report.js`) | 6c | yes (Chrome) for verdict, reasons, per-module table, must-fix, reopen, speed; export is browser print, no dedicated PDF layout | |
| R4 | Notifications bell (`notifications.js`, `NotifCalc`) | 6c | yes (Chrome); reminders, assignment, deep link, badge clears; status texts show codes not names | |
| R5 | Activity log (`activitylog.js`) | 6c | yes (Chrome); admin only by role matrix | |
| **Admin and tools** | | | | |
| A1 | Master status (`masterstatus.js`) | 6d | yes (Chrome); works offline; renaming keeps the code | |
| A2 | Custom field definitions (`settings.js`) | 6d | yes (Chrome) | |
| A3 | User management, online only (`usermanagement.js`) | 6d | yes (Chrome); a created user logs in | |
| A4 | Role permission matrix, online only | 6d | yes (Chrome) | |
| A5 | Workspaces, online only | 6d | yes (Chrome); add, rename, delete | |
| A6 | Settings: Gemini key, theme (per browser) | 6d | yes (Chrome); key stored server-side, theme stored but only sets `data-theme`, no dark stylesheet exists yet | |
| A7 | Import / export of whole data, backup and restore (online only) | 6d | partial (Chrome): JSON backup and restore of this device's synced data (works offline, merges by id). Not the legacy blob format, not a server backup (Phase 7) | |
| **Offline and safety (new behavior to confirm)** | | | | |
| O1 | Create bugs offline, reload offline, go online: codes appear within one push | 5 | yes (Chrome) | |
| O2 | A write the server refuses shows up for the user (rejected writes UI) | 6a | yes (Chrome) | |
| O3 | Clock more than 5 minutes off blocks writes with a banner | 5 | unit only | |
| O4 | Revoked access removes the data from the device on next pull | 1 | tests | |
