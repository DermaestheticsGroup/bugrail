# BugRail — QA Test Management & Bug Tracking

Web app for managing Test Cases and Bug Reports, fully integrated. Two parts:

- **`qa-app/`** — frontend (Vanilla JS, HTML, CSS). Runs standalone with localStorage, or connects to the MongoDB backend.
- **`server/`** — Express + MongoDB backend, storage API replacing localStorage so data syncs across browsers/devices.

## Migration in progress

BugRail is moving to a single Next.js 16 app in `web/`. It will be local-first: each browser keeps a Turso database that syncs with a self-hosted Turso database on the VM. It will work offline, and workspaces will be isolated on the server, so vendor accounts see only their own workspace. `qa-app/` and `server/` stay in production until cutover.

Quick Start (`web/`):

```
cd web
bun install
bun run dev    # http://localhost:3001
bun test
```

Production runs Node 24; Bun is for local development only.

- Design: [`docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md`](docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md)
- Decisions: [`docs/adr/`](docs/adr/)

## Features

- Realtime dashboard stats (Chart.js): Test Case status, Bug severity, per-module progress.
- Test Case management: CRUD, filter, sort, bulk update, import/export Excel/CSV.
- Bug Report integrated with Test Case (auto-fill from Failed → Create Bug).
- Summary & PDF export, JSON backup/restore.
- Auth & user management, activity log.
- TestForge — generate test cases with Gemini AI.
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
web/       Next.js 16 local-first app (in progress)
docs/      specs (superpowers/specs), decisions (adr), plans, reviews
```
