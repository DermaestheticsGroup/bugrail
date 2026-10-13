# Phase 6 plan: feature parity

Spec: `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (Client). Checklist: `docs/parity-checklist.md`.
Rule: port behavior from `qa-app/js`, keep pure logic in `web/lib/domain` (already ported in Phase 2), put local reads and writes in `web/lib/client/repo.ts`, keep screens thin.

Slices, each one PR with a review loop and a browser e2e:
- 6a Files and Test Case, plus the rejected-writes UI.
- 6b Bug Report (list, board, form, status flow, detail, bulk, AI analyze).
- 6c Dashboard, Summary, Report, Notifications, Activity.
- 6d Master status, custom fields, users, roles, workspaces, settings, import/export, TestForge, backup.

G6 itself (a QA lead ticking the checklist with real browsers) is a human gate and cannot be closed by tests.
