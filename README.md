# BugRail — QA Test Management & Bug Tracking

Web app for managing Test Cases and Bug Reports, fully integrated. Two parts:

- **`qa-app/`** — frontend (Vanilla JS, HTML, CSS). Runs standalone with localStorage, or connects to the MongoDB backend.
- **`server/`** — Express + MongoDB backend, storage API replacing localStorage so data syncs across browsers/devices.

## Migration in progress

BugRail is moving to a single Next.js 16 app in `web/`. It will be local-first: each browser keeps a Turso database that syncs with a self-hosted Turso database on the VM. It will work offline, and workspaces will be isolated on the server, so vendor accounts see only their own workspace. `qa-app/` and `server/` stay in production until cutover. All phases are built; what remains is the human gate G6 (`docs/parity-checklist.md`), a migration check on a real production dump (G4), and the cutover itself.

Quick Start (`web/`):

```
cd web
bun install
bun run dev    # http://localhost:3001
bun test
```

`bun run dev` and `bun test` set `BUGRAIL_DEV_AUTH=1`, which turns on the dev users and the `x-dev-user` header. Without it, or with `NODE_ENV=production`, the header is ignored and no dev users are seeded. Never set it on a deployed server.

## Runtime

Production runs Node 24 (`node node_modules/next/dist/bin/next start`); Bun is local tooling only (install, scripts, tests). CI (`.github/workflows/web-ci.yml`) installs and tests under Bun, then builds and runs a smoke script under Node 24. Reason: under load Bun's p95 was 107 ms against Node's 57 ms (ADR-004).

- Cutover, backup, restore and rollback: [`docs/runbook-cutover.md`](docs/runbook-cutover.md). Units and env template: [`deploy/`](deploy/).
- Design: [`docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md`](docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md)
- Decisions: [`docs/adr/`](docs/adr/)

## Rewind

Rewind, the bug-recording app built from a claude.ai/design export, runs inside `web/` at `/rewind`. It uses BugRail's sign-in, theme and service worker, and each half links to the other from its sidebar.

- Code: `web/app/rewind/` (route and layout), `web/app/rewind/_app/` (the app), `web/lib/rewind/` (its databases), `web/app/api/rewind/` (APIs, signed-in users only).
- Data: a local-first Turso database per browser (`rewind.db` in OPFS), separate from BugRail's. It syncs to Turso Cloud through `/api/rewind/sync` only when `REWIND_TURSO_DATABASE_URL` (and `REWIND_TURSO_AUTH_TOKEN`) are set. Run `bun run rewind:migrate` once to create the remote schema and seed the demo data.
- Design source: `web/design/rewind/`. `bun run rewind:gen` regenerates `_app/view.tsx` and `_app/hover.css` from `template.html`; do not edit those two files by hand.
- Browser check: `web/scripts/rewind-e2e.cjs` (same harness as the g6 scripts). Seed a DB with `bun scripts/e2e-seed.ts <db path>`, serve it on port 3200 with `next start`, then from `web/` run `CHROME=<chrome binary> [PLAYWRIGHT_CORE=<path>] node scripts/rewind-e2e.cjs <outdir> <alphaWsId>` (`<alphaWsId>` is the seeded Alpha workspace's id).

## Features

- Realtime dashboard stats (Chart.js): Test Case status, Bug severity, per-module progress.
- Test Case management: CRUD, filter, sort, bulk update, import/export Excel/CSV.
- Bug Report integrated with Test Case (auto-fill from Failed → Create Bug).
- Summary & PDF export, JSON backup/restore.
- Auth & user management, activity log.
- TestForge — generate test cases with Gemini AI.
- Rewind (`/rewind`) — record, share and debug bugs with full context. See [Rewind](#rewind).
- Dark/Light mode, keyboard shortcuts, responsive.

## Running

### Frontend only (no backend)

Open `qa-app/index.html` directly in browser. All data stored in Local Storage. Details in [`qa-app/README.md`](qa-app/README.md).

### With backend (MongoDB, synced data)

```
cd server
npm install
copy .env.example .env   # set MONGO_URI, DB_NAME, GEMINI_API_KEY (for TestForge)
npm start
```

API runs at `http://localhost:3001`. Frontend reads API URL from `API_BASE` in `qa-app/js/utils.js`. Endpoint & data structure details in [`server/README.md`](server/README.md).

## Structure

```
qa-app/    frontend (index.html, css/, js/)
server/    backend Express + MongoDB (server.js, app.js, db.js)
web/       Next.js 16 local-first app (feature complete, awaiting G6 and cutover), Rewind included under /rewind
deploy/    systemd units (app, nightly backup) and the env template
docs/      specs (superpowers/specs), decisions (adr), plans, reviews
```
