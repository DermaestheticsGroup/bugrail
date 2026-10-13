# Phase 3 result: server side

## Built
- Auth: iron-session cookie `bugrail_session` (7 days, httpOnly, lax), scrypt passwords with timing-safe compare, login rate limit (10 per 15 min per IP), `requireUser()` in every route, `session_version` checked on each request. `/api/auth/{login,logout,me}`.
- `proxy.ts` redirects page loads without the cookie to `/login`. Route handlers still verify the session; the proxy is a convenience.
- Push enforces the role matrix through `can()` (saved matrix in `secrets.role_permissions`, seed matrix otherwise) and the bug status transition rule (`statusTransitionRule`, by code). `bumpAccess` targets now come from the `users` table.
- Pull: `testcases` gets file-based visibility; `bug_status_master` and `custom_field_defs` go to every user.
- `/api/events` SSE (sync pokes only), fed by `push` through `broadcast(touchedWorkspaces)`.
- Admin routes (`/api/admin/{users,roles,workspaces,settings}`): create/update/delete users, reset password (bumps `session_version`), role and workspace changes bump `access_version`, last-admin guard, permission matrix save, workspace CRUD, Gemini key.
- AI routes `/api/testforge/generate` and `/api/bug/analyze`: ported from `server/app.js`, key from `secrets` or env, per-user rate limit.

## Gate G3 evidence
- `bun test`: 151 pass; `tsc --noEmit` clean; `next build` passes.
- Real HTTP smoke against `next start` (dev auth off): anonymous pull 401, page redirect 307 to `/login`, bad login 401, login 200, `/me`, admin route 403 for a QA user, admin user list without hashes, admin push accepted, SSE poke delivered to the QA user's stream, QA pull returned the file, logout then `/me` 401.

## Rulings
- No `agent.db` or `/sync` proxy: the spec's own sync replaced the v2 plan's agent. Codes are assigned inside the push transaction (Phase 1).
- Dev users got real role names (`qa_internal`, `qa_vendor`) and a `pm` user (`pm_ba`), because the matrix now applies to them.
- `workspaces` is a server-only table for now; `roles`, `workspaces` and `users_public` reach the browser in Phase 5 (needs a server-owned table kind in the client merge).

## Not done or not checked
- "Note required" half of `statusTransitionRule` is not enforced on push (the note is a separate `bug_events` row). Only ok/not-ok is.
- Rate limit is in memory per process.
- No `users_public` / `roles` / `workspaces` pull to browsers yet (Phase 5).
- Backup-restore bump of everyone's `access_version` is not wired.
- Legacy converge/load harnesses were not re-run against session auth (they use the dev header).
- AI routes were tested with an injected `ask`, not against Gemini.
- `/login` is a bare form; the shell is Phase 5.
