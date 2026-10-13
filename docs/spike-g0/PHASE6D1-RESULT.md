# Phase 6d-1 result: admin screens

Slice 6d is split in two. 6d-1 (this) is Master status, custom fields, Settings, Users, Roles, Workspaces. 6d-2 is import/export, TestForge, translate, backup/restore and the print layout.

## Built
- `lib/client/admin-model.ts`: master status and custom field writes as local synced writes (they work offline). Status code generated from the name (legacy rule), immutable; rename keeps the code, and since bugs store codes nothing else changes. A status a bug still uses cannot be deleted. The first edit turns the default statuses into real rows.
- `components/admin-screens.tsx`: Master Status, Settings (custom fields, Gemini key, theme per browser), User Management, Role Permission matrix, Workspaces. The last three plus the key go through `/api/admin/*` and are online-only.
- `AppProvider.refresh()` now also refetches the shell config, because users, roles and workspaces live in the config, not in synced rows.

## Evidence
- `bun test`: all pass (7 new in `test/admin-model.test.ts`); `tsc` clean; `next build` passes.
- `scripts/g6d1-e2e.cjs` (headless Chrome 155): master status defaults, add, duplicate and bad colour refused, rename, delete; custom field add, duplicate refused, remove; Gemini key saved; theme stored; workspace add, rename, delete; user create then that user logs in, then delete; role matrix change persists across reload; a QA role is refused users, roles, workspaces and master status.

## Not done or not checked
- Theme: the choice is stored per browser and sets `data-theme`, but there is no dark stylesheet in the new app yet.
- The legacy "delete all data" and similar bulk actions on Settings are not ported (they belong with backup/restore in 6d-2).
- Last-admin and self-delete protections are enforced by the server code from Phase 3, not re-driven here.
- Chrome only.
