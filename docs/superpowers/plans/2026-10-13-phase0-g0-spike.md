# Phase 0: Gate G0 Spike Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove or disprove every assumption behind the local-first design (checks G0.1–G0.8) with a small throwaway Next.js app, then record the verdict in ADR-001 and ADR-004 before any feature work starts.

**Architecture:** A `spike/` Next.js 16 app at the repo root holds the real core units (`hlc`, `lww`, sync server, sync client) written test-first, because Phase 1 promotes them into `web/`. Everything around them (fake users, demo pages, scripts) is throwaway. Each G0 check is either a `bun test`, a script with a numeric pass/fail threshold, or a manual browser check with a recorded result.

**Tech Stack:** Bun 1.4.x (install, scripts, tests), Next.js 16.4.0 App Router, TypeScript, `@tursodatabase/database@0.8.3` (server, Node-API), `@tursodatabase/database-wasm@0.8.3` (browser, OPFS).

**Spec:** `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (read sections "LWW: the whole mechanism", "Sync protocol", "Auth and workspace isolation" and "Gates" before starting).

## Global Constraints

- `@tursodatabase/database` and `@tursodatabase/database-wasm` pinned to exactly `0.8.3` (no caret).
- `next` pinned to exactly `16.4.0`.
- Browser import path is `@tursodatabase/database-wasm/turbopack`.
- Every route sends `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`.
- HLC format: `"<ms:15>-<counter:5>-<deviceId>"`, zero-padded, string order = time order.
- Synced tables: no `UNIQUE` (besides primary key), no `FOREIGN KEY`, no rejecting `CHECK`, no `NOT NULL` beyond the primary key.
- Rows are keyed by `id` (TEXT UUID), never by `rowid`. Deletes are tombstones (`deleted_at`), never `DELETE`.
- Push batches are at most 500 rows; pull pages are at most 2000 rows.
- `server_seq` is set only by the server.
- No Turso Cloud, no `tursodb` process, no Vercel.
- The fake `x-spike-user` header in this spike is a test stand-in for the session. It must never be copied into `web/`; Phase 3 replaces it with iron-session.

## Review Focus

1. **Unknown table name in a push** (`tbl: "sqlite_master"` or `"files; DROP TABLE bugs"`): must be rejected, never interpolated into SQL. Pinned by a test in Task 4.
2. **The same push sent twice** (network dropped after the server committed): the second push must change nothing and must not bump `server_seq`. Pinned by a test in Task 4.
3. **More rows than one pull page:** the client must loop until `more` is false and end with every row exactly once. Pinned by a test in Task 5 (page size 3).
4. **A pushed row with no `hlc`** (or no `status_hlc` on a status table): it must be rejected with a reason. A NULL clock would otherwise make every later comparison false and freeze the row forever. Pinned by a test in Task 4.
5. **Observing an HLC from a device with a fast clock:** `now()` must still be strictly increasing afterwards and greater than the observed value. Pinned by a test in Task 2.

---

## File Structure

```
spike/
├── package.json              scripts + exact pins
├── tsconfig.json
├── next.config.ts            COOP/COEP headers, cacheComponents, partialPrefetching, experimental.useOffline, serverExternalPackages
├── db/
│   ├── sql.ts                SQL strings: synced tables, server-only sync_meta, client-only outbox/meta
│   └── tables.ts             table metadata (kind, columns, status columns)
├── lib/
│   ├── db-types.ts           minimal Db interface shared by Node and wasm engines
│   ├── hlc.ts                hybrid logical clock            (promoted to web/ in Phase 1)
│   ├── lww.ts                guarded upsert builder          (promoted)
│   ├── id-gen.ts             nextInScope port of utils.js    (promoted)
│   └── sync/
│       ├── users.ts          fake users for the spike        (throwaway)
│       ├── server.ts         push() / pull()                 (promoted, auth swapped in Phase 3)
│       └── client.ts         localWrite / pushOutbox / pullAll (promoted)
├── app/
│   ├── layout.tsx            offline badge + SW registration
│   ├── page.tsx              links to /opfs and /other
│   ├── other/page.tsx        second static route for the offline soft-nav check
│   ├── opfs/page.tsx         G0.1 / G0.2-wasm / G0.5-browser checks
│   ├── opfs/OpfsCheck.tsx    client component doing the work
│   ├── offline-badge.tsx     useOffline() indicator
│   ├── sw-register.tsx       registers /sw.js
│   └── api/
│       ├── sync/push/route.ts
│       ├── sync/pull/route.ts
│       └── spike/backup/route.ts
├── public/sw.js              shell + static cache
├── scripts/
│   ├── seed.ts               production-sized synthetic server.db
│   ├── converge.ts           3-client random convergence over HTTP (G0.8)
│   ├── load.ts               30-client load + bootstrap timing (G0.3, G0.5)
│   └── backup-check.ts       G0.7 verification
└── test/
    ├── hlc.test.ts
    ├── lww.test.ts
    ├── id-gen.test.ts
    ├── sync-server.test.ts
    └── sync-client.test.ts
```

---

### Task 1: Scaffold the spike app

**Files:**
- Create: `spike/package.json`, `spike/tsconfig.json`, `spike/next.config.ts`, `spike/app/layout.tsx`, `spike/app/page.tsx`, `spike/app/other/page.tsx`, `spike/.gitignore`
- Modify: `.gitignore` (repo root) only if it already ignores `node_modules` globally; otherwise rely on `spike/.gitignore`

**Interfaces:**
- Produces: a buildable Next 16 app in `spike/`, `bun test` wired, COOP/COEP on every route.

- [ ] **Step 1: Create the package and install exact versions**

```bash
mkdir -p spike && cd spike
cat > package.json <<'EOF'
{
  "name": "bugrail-spike",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "next dev -p 3100",
    "build": "next build",
    "start": "next start -p 3100",
    "test": "bun test"
  }
}
EOF
bun add --exact next@16.4.0 @tursodatabase/database@0.8.3 @tursodatabase/database-wasm@0.8.3
bun add react@^19 react-dom@^19
bun add -d typescript@^5 @types/react@^19 @types/react-dom@^19 @types/node@^24 @types/bun
```

Expected: `package.json` lists `"next": "16.4.0"`, `"@tursodatabase/database": "0.8.3"`, `"@tursodatabase/database-wasm": "0.8.3"` with no caret.

- [ ] **Step 2: Write config files**

`spike/tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./*"] },
    "types": ["bun"]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

`spike/next.config.ts`:

```ts
import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  experimental: { useOffline: true },
  // Native Node-API binding: keep it out of the server bundle.
  serverExternalPackages: ['@tursodatabase/database'],
  async headers() {
    return [
      {
        source: '/(.*)',
        headers: [
          // The wasm build allocates shared memory, which needs cross-origin isolation.
          { key: 'Cross-Origin-Opener-Policy', value: 'same-origin' },
          { key: 'Cross-Origin-Embedder-Policy', value: 'require-corp' },
        ],
      },
    ];
  },
};

export default nextConfig;
```

`spike/.gitignore`:

```
node_modules/
.next/
next-env.d.ts
*.db
*.db-wal
*.db-shm
data/
```

- [ ] **Step 3: Minimal pages**

`spike/app/layout.tsx`:

```tsx
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
```

`spike/app/page.tsx`:

```tsx
import Link from 'next/link';

export default function Home() {
  return (
    <main>
      <h1>BugRail G0 spike</h1>
      <nav>
        <Link href="/opfs">OPFS checks</Link> · <Link href="/other">Other page</Link>
      </nav>
    </main>
  );
}
```

`spike/app/other/page.tsx`:

```tsx
import Link from 'next/link';

export default function Other() {
  return (
    <main>
      <h1>Other page</h1>
      <Link href="/">Home</Link>
    </main>
  );
}
```

- [ ] **Step 4: Build and check headers**

```bash
cd spike && bun run build && (bun run start & sleep 5; curl -sI http://localhost:3100/ | grep -i cross-origin; kill %1)
```

Expected: build succeeds; output contains `cross-origin-opener-policy: same-origin` and `cross-origin-embedder-policy: require-corp`. If `cacheComponents`, `partialPrefetching` or `experimental.useOffline` is rejected by `next build`, record the exact error message in `spike/G0-NOTES.md` (create it) and remove only the rejected key.

- [ ] **Step 5: Commit**

```bash
git add spike/package.json spike/bun.lock spike/tsconfig.json spike/next.config.ts spike/.gitignore spike/app
git commit -m "chore(spike): scaffold Next 16 G0 spike with COOP/COEP"
```

---

### Task 2: Hybrid logical clock

**Files:**
- Create: `spike/lib/hlc.ts`
- Test: `spike/test/hlc.test.ts`

**Interfaces:**
- Produces: `createClock(deviceId: string, wall?: () => number): Clock`, where `interface Clock { now(): string; observe(hlc: string): void }`.

- [ ] **Step 1: Write the failing tests**

`spike/test/hlc.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { createClock } from '../lib/hlc';

describe('hlc', () => {
  test('format is ms:15-counter:5-device', () => {
    const c = createClock('dev-a', () => 1_700_000_000_000);
    expect(c.now()).toBe('001700000000000-00000-dev-a');
  });

  test('strictly increasing with a frozen wall clock', () => {
    const c = createClock('dev-a', () => 1000);
    let prev = '';
    for (let i = 0; i < 10_000; i++) {
      const next = c.now();
      expect(next > prev).toBe(true);
      prev = next;
    }
  });

  test('wall clock going backwards does not go backwards', () => {
    let wall = 5000;
    const c = createClock('dev-a', () => wall);
    const a = c.now();
    wall = 1000;
    expect(c.now() > a).toBe(true);
  });

  test('counter overflow rolls into the next millisecond', () => {
    const c = createClock('dev-a', () => 1000);
    let prev = '';
    for (let i = 0; i < 100_002; i++) prev = c.now();
    expect(prev.startsWith('000000000001001-')).toBe(true);
  });

  test('two devices at the same instant never produce equal values', () => {
    const a = createClock('dev-a', () => 1000);
    const b = createClock('dev-b', () => 1000);
    const ha = a.now();
    const hb = b.now();
    expect(ha).not.toBe(hb);
    expect(ha < hb).toBe(true); // tie broken by deviceId
  });

  // Review Focus 5
  test('after observing a fast-clock hlc, now() is greater and still increasing', () => {
    const c = createClock('dev-a', () => 1000);
    const remote = '000000009999999-00042-dev-z';
    c.observe(remote);
    const n1 = c.now();
    const n2 = c.now();
    expect(n1 > remote).toBe(true);
    expect(n2 > n1).toBe(true);
  });

  test('observing an older hlc changes nothing', () => {
    const c = createClock('dev-a', () => 5000);
    const before = c.now();
    c.observe('000000000000001-00000-dev-z');
    expect(c.now() > before).toBe(true);
  });

  test('deviceId containing dashes (UUID) still parses on observe', () => {
    const c = createClock('11111111-2222-3333-4444-555555555555', () => 1000);
    const h = c.now();
    const d = createClock('dev-b', () => 1);
    d.observe(h);
    expect(d.now() > h).toBe(true);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd spike && bun test test/hlc.test.ts`
Expected: FAIL, `Cannot find module '../lib/hlc'`.

- [ ] **Step 3: Implement**

`spike/lib/hlc.ts`:

```ts
export interface Clock {
  now(): string;
  observe(hlc: string): void;
}

const MAX_COUNTER = 99_999;
const pad = (n: number, width: number) => String(n).padStart(width, '0');

// "<ms:15>-<counter:5>-<deviceId>": zero-padded so plain string comparison is time order.
export function createClock(deviceId: string, wall: () => number = Date.now): Clock {
  let lastMs = 0;
  let counter = -1;

  return {
    now() {
      const ms = wall();
      if (ms > lastMs) {
        lastMs = ms;
        counter = 0;
      } else {
        counter += 1;
        if (counter > MAX_COUNTER) {
          lastMs += 1;
          counter = 0;
        }
      }
      return `${pad(lastMs, 15)}-${pad(counter, 5)}-${deviceId}`;
    },
    observe(hlc) {
      const [msPart, counterPart] = hlc.split('-');
      const ms = Number(msPart);
      const c = Number(counterPart);
      if (!Number.isFinite(ms) || !Number.isFinite(c)) return;
      if (ms > lastMs || (ms === lastMs && c > counter)) {
        lastMs = ms;
        counter = c;
      }
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd spike && bun test test/hlc.test.ts`
Expected: 8 pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add spike/lib/hlc.ts spike/test/hlc.test.ts
git commit -m "feat(spike): hybrid logical clock"
```

---

### Task 3: Schema, table metadata and the guarded upsert (G0.2, Node half)

**Files:**
- Create: `spike/db/sql.ts`, `spike/db/tables.ts`, `spike/lib/db-types.ts`, `spike/lib/lww.ts`, `spike/lib/schema.ts`
- Test: `spike/test/lww.test.ts`

**Interfaces:**
- Consumes: `createClock` (Task 2) in tests only.
- Produces:
  - `type SyncedTable = 'files' | 'file_shares' | 'bugs' | 'bug_events'`
  - `TABLES: Record<SyncedTable, TableDef>`, `interface TableDef { name: SyncedTable; kind: 'lww' | 'lww+status' | 'insert-only'; columns: string[]; statusCols: string[] }`
  - `isSyncedTable(x: unknown): x is SyncedTable`
  - `mergeSql(t: TableDef): string` and `mergeArgs(t: TableDef, row: Row): unknown[]`, where `type Row = Record<string, unknown>`
  - `interface Db` (see `db-types.ts`) and `applySchema(db: Db, files: ('schema' | 'server' | 'local')[]): Promise<void>`

- [ ] **Step 1: Write the schema as SQL strings**

Plain TypeScript strings work the same in `bun test`, `next build` (Turbopack) and the browser, so no loader config is needed.

`spike/db/sql.ts`:

```ts
// Synced tables: no UNIQUE (besides the key), FOREIGN KEY, CHECK or NOT NULL, so a sync write never fails on a constraint.
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT, created_by TEXT, created_at TEXT,
  hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS file_shares (
  id TEXT PRIMARY KEY, file_id TEXT, workspace_id TEXT,
  hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS bugs (
  id TEXT PRIMARY KEY, code TEXT, file_id TEXT, test_case_id TEXT, title TEXT, module TEXT,
  severity TEXT, priority TEXT, status_code TEXT, status_hlc TEXT, description TEXT, steps TEXT,
  expected_result TEXT, actual_result TEXT, platform TEXT, environment TEXT, browser TEXT,
  device TEXT, build_version TEXT, attachments TEXT, tester TEXT, assignee TEXT, report_date TEXT,
  extra TEXT, hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS bug_events (
  id TEXT PRIMARY KEY, bug_id TEXT, kind TEXT, at TEXT, email TEXT, from_status TEXT,
  to_status TEXT, note TEXT, attachment TEXT, text TEXT, assignee TEXT, server_seq INTEGER
);
CREATE INDEX IF NOT EXISTS files_seq ON files(server_seq);
CREATE INDEX IF NOT EXISTS file_shares_seq ON file_shares(server_seq);
CREATE INDEX IF NOT EXISTS bugs_seq ON bugs(server_seq);
CREATE INDEX IF NOT EXISTS bug_events_seq ON bug_events(server_seq);
CREATE INDEX IF NOT EXISTS bugs_file ON bugs(file_id);
CREATE INDEX IF NOT EXISTS bug_events_bug ON bug_events(bug_id);
`;

// Server-only.
export const SERVER_SQL = `
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value INTEGER);
INSERT INTO sync_meta (key, value) VALUES ('seq', 0) ON CONFLICT(key) DO NOTHING;
`;

// Client-only.
export const LOCAL_SQL = `
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, row_id TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;
```

- [ ] **Step 2: Write table metadata and the Db interface**

`spike/db/tables.ts`:

```ts
export type SyncedTable = 'files' | 'file_shares' | 'bugs' | 'bug_events';
export type TableKind = 'lww' | 'lww+status' | 'insert-only';

export interface TableDef {
  name: SyncedTable;
  kind: TableKind;
  columns: string[];
  statusCols: string[];
}

export const TABLES: Record<SyncedTable, TableDef> = {
  files: {
    name: 'files', kind: 'lww', statusCols: [],
    columns: ['id', 'name', 'workspace_id', 'created_by', 'created_at', 'hlc', 'deleted_at', 'updated_by', 'server_seq'],
  },
  file_shares: {
    name: 'file_shares', kind: 'lww', statusCols: [],
    columns: ['id', 'file_id', 'workspace_id', 'hlc', 'deleted_at', 'updated_by', 'server_seq'],
  },
  bugs: {
    name: 'bugs', kind: 'lww+status', statusCols: ['status_code'],
    columns: [
      'id', 'code', 'file_id', 'test_case_id', 'title', 'module', 'severity', 'priority',
      'status_code', 'status_hlc', 'description', 'steps', 'expected_result', 'actual_result',
      'platform', 'environment', 'browser', 'device', 'build_version', 'attachments', 'tester',
      'assignee', 'report_date', 'extra', 'hlc', 'deleted_at', 'updated_by', 'server_seq',
    ],
  },
  bug_events: {
    name: 'bug_events', kind: 'insert-only', statusCols: [],
    columns: ['id', 'bug_id', 'kind', 'at', 'email', 'from_status', 'to_status', 'note', 'attachment', 'text', 'assignee', 'server_seq'],
  },
};

export const SYNCED_TABLES = Object.keys(TABLES) as SyncedTable[];

export function isSyncedTable(x: unknown): x is SyncedTable {
  return typeof x === 'string' && Object.hasOwn(TABLES, x);
}
```

`spike/lib/db-types.ts`:

```ts
// The subset of the @tursodatabase DatabasePromise API (Node and wasm builds share it) that the sync code uses.
export interface Tx {
  run(sql: string, ...params: unknown[]): Promise<{ changes: number; lastInsertRowid: number }>;
  get(sql: string, ...params: unknown[]): Promise<any>;
  all(sql: string, ...params: unknown[]): Promise<any[]>;
  exec(sql: string): Promise<void>;
}

export interface Db extends Tx {
  transactionAsync<F extends (tx: Tx, ...args: any[]) => Promise<any>>(fn: F): (...args: any[]) => ReturnType<F>;
}

export type Row = Record<string, unknown>;
```

`spike/lib/schema.ts`:

```ts
import type { Db } from './db-types';
import { LOCAL_SQL, SCHEMA_SQL, SERVER_SQL } from '../db/sql';

const FILES = { schema: SCHEMA_SQL, server: SERVER_SQL, local: LOCAL_SQL } as const;

export async function applySchema(db: Db, files: (keyof typeof FILES)[]): Promise<void> {
  for (const f of files) await db.exec(FILES[f]);
}
```

- [ ] **Step 3: Write the failing lww tests**

`spike/test/lww.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { TABLES } from '../db/tables';
import { mergeArgs, mergeSql } from '../lib/lww';
import { applySchema } from '../lib/schema';
import type { Db, Row } from '../lib/db-types';

async function freshDb(): Promise<Db> {
  const db = (await connect(':memory:')) as unknown as Db;
  await applySchema(db, ['schema']);
  return db;
}

const bug = (over: Row): Row => ({
  id: 'b1', code: null, file_id: 'f1', title: 't0', description: 'd0',
  status_code: 'OPEN', status_hlc: '000000000001000-00000-a', hlc: '000000000001000-00000-a',
  ...over,
});

async function apply(db: Db, tbl: keyof typeof TABLES, row: Row) {
  return db.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
}

const get = (db: Db, id = 'b1') => db.get('SELECT * FROM bugs WHERE id = ?', id);

describe('lww merge on @tursodatabase/database', () => {
  test('insert when the row does not exist', async () => {
    const db = await freshDb();
    const r = await apply(db, 'bugs', bug({}));
    expect(r.changes).toBe(1);
    expect((await get(db)).title).toBe('t0');
  });

  test('newer hlc wins, older is ignored and reports 0 changes', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({}));
    await apply(db, 'bugs', bug({ title: 'new', hlc: '000000000002000-00000-b' }));
    const old = await apply(db, 'bugs', bug({ title: 'old', hlc: '000000000001500-00000-c' }));
    expect(old.changes).toBe(0);
    expect((await get(db)).title).toBe('new');
  });

  test('status clock is independent of the row clock', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({}));
    // A: description edit at t2 (status untouched)
    await apply(db, 'bugs', bug({ description: 'A', hlc: '000000000002000-00000-a' }));
    // B: status move at t3 with an older row hlc (B never saw A's edit)
    await apply(db, 'bugs', bug({ status_code: 'RETEST', status_hlc: '000000000003000-00000-b' }));
    const row = await get(db);
    expect(row.description).toBe('A');
    expect(row.status_code).toBe('RETEST');
    expect(row.hlc).toBe('000000000002000-00000-a');
    expect(row.status_hlc).toBe('000000000003000-00000-b');
  });

  test('code is first-non-null-wins and applies even with an older hlc', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({ title: 'local', hlc: '000000000005000-00000-a' }));
    await apply(db, 'bugs', bug({ code: 'BUG-0001', title: 'server', hlc: '000000000001000-00000-a' }));
    let row = await get(db);
    expect(row.code).toBe('BUG-0001');
    expect(row.title).toBe('local');
    await apply(db, 'bugs', bug({ code: 'BUG-0002', hlc: '000000000009000-00000-a' }));
    row = await get(db);
    expect(row.code).toBe('BUG-0001');
  });

  test('tombstone travels like any field', async () => {
    const db = await freshDb();
    await apply(db, 'bugs', bug({}));
    await apply(db, 'bugs', bug({ deleted_at: '2026-10-13T00:00:00Z', hlc: '000000000002000-00000-a' }));
    expect((await get(db)).deleted_at).toBe('2026-10-13T00:00:00Z');
  });

  test('insert-only tables ignore a second insert with the same id', async () => {
    const db = await freshDb();
    const e = { id: 'e1', bug_id: 'b1', kind: 'comment', text: 'first' };
    await apply(db, 'bug_events', e);
    const second = await apply(db, 'bug_events', { ...e, text: 'second' });
    expect(second.changes).toBe(0);
    expect((await db.get('SELECT text FROM bug_events WHERE id = ?', 'e1')).text).toBe('first');
  });

  test('random interleavings converge (1000 edits, two orders)', async () => {
    let seed = 42;
    const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    const ops: { tbl: 'bugs' | 'bug_events'; row: Row }[] = [];
    for (let i = 0; i < 1000; i++) {
      const id = `b${Math.floor(rand() * 20)}`;
      const t = `${String(1000 + i).padStart(15, '0')}-00000-d${Math.floor(rand() * 3)}`;
      const r = rand();
      if (r < 0.4) ops.push({ tbl: 'bugs', row: bug({ id, title: `t${i}`, hlc: t }) });
      else if (r < 0.7) ops.push({ tbl: 'bugs', row: bug({ id, status_code: `S${i}`, status_hlc: t }) });
      else if (r < 0.8) ops.push({ tbl: 'bugs', row: bug({ id, deleted_at: `x${i}`, hlc: t }) });
      else ops.push({ tbl: 'bug_events', row: { id: `e${i}`, bug_id: id, kind: 'comment', text: `c${i}` } });
    }
    const shuffled = [...ops];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    const a = await freshDb();
    const b = await freshDb();
    for (const op of ops) await apply(a, op.tbl, op.row);
    for (const op of shuffled) await apply(b, op.tbl, op.row);
    for (const t of ['bugs', 'bug_events']) {
      const ra = await a.all(`SELECT * FROM ${t} ORDER BY id`);
      const rb = await b.all(`SELECT * FROM ${t} ORDER BY id`);
      expect(rb).toEqual(ra);
    }
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd spike && bun test test/lww.test.ts`
Expected: FAIL, `Cannot find module '../lib/lww'`.

- [ ] **Step 5: Implement `lww.ts`**

`spike/lib/lww.ts`:

```ts
import type { TableDef } from '../db/tables';
import type { Row } from './db-types';

const NOT_PLAIN = new Set(['id', 'hlc', 'status_hlc', 'code', 'server_seq']);

// One guarded upsert per table. SQLite evaluates every SET against the pre-update row,
// so each CASE compares the stored value with the incoming one.
export function mergeSql(t: TableDef): string {
  const n = t.name;
  const cols = t.columns;
  const insert = `INSERT INTO ${n} (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
  if (t.kind === 'insert-only') return `${insert} ON CONFLICT(id) DO NOTHING`;

  const status = new Set(t.statusCols);
  const sets: string[] = [];
  for (const c of cols) {
    if (NOT_PLAIN.has(c)) continue;
    const clock = status.has(c) ? 'status_hlc' : 'hlc';
    sets.push(`${c} = CASE WHEN excluded.${clock} > ${n}.${clock} THEN excluded.${c} ELSE ${n}.${c} END`);
  }
  const where = [`excluded.hlc > ${n}.hlc`];
  if (t.kind === 'lww+status') {
    sets.push(`status_hlc = MAX(${n}.status_hlc, excluded.status_hlc)`);
    where.push(`excluded.status_hlc > ${n}.status_hlc`);
  }
  if (cols.includes('code')) {
    sets.push(`code = COALESCE(${n}.code, excluded.code)`);
    where.push(`(${n}.code IS NULL AND excluded.code IS NOT NULL)`);
  }
  sets.push(`hlc = MAX(${n}.hlc, excluded.hlc)`);
  sets.push(`server_seq = excluded.server_seq`);
  return `${insert} ON CONFLICT(id) DO UPDATE SET ${sets.join(', ')} WHERE ${where.join(' OR ')}`;
}

export function mergeArgs(t: TableDef, row: Row): unknown[] {
  return t.columns.map((c) => row[c] ?? null);
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd spike && bun test test/lww.test.ts`
Expected: 7 pass. If any test fails because the engine rejects or misreads the SQL (`ON CONFLICT … DO UPDATE … WHERE`, scalar `MAX` on TEXT, `excluded.`), that is a **G0.2 failure**: copy the exact error into `G0-NOTES.md` and stop; do not rewrite the SQL to work around it without updating the spec.

- [ ] **Step 7: Commit**

```bash
git add spike/db spike/lib/db-types.ts spike/lib/lww.ts spike/lib/schema.ts spike/test/lww.test.ts
git commit -m "feat(spike): schema, table metadata and guarded LWW upsert"
```

---

### Task 4: Code generator port and sync server (push/pull, isolation)

**Files:**
- Create: `spike/lib/id-gen.ts`, `spike/lib/sync/users.ts`, `spike/lib/sync/server.ts`
- Test: `spike/test/id-gen.test.ts`, `spike/test/sync-server.test.ts`

**Interfaces:**
- Consumes: `TABLES`, `isSyncedTable`, `SyncedTable` (Task 3); `mergeSql`, `mergeArgs` (Task 3); `Db`, `Tx`, `Row` (Task 3); `applySchema` (Task 3).
- Produces:
  - `nextInScope(prefix: string, codesInScope: (string | null)[]): string`
  - `interface User { id: string; email: string; role: 'admin' | 'user'; workspaceIds: string[] }`, `USERS: Record<string, User>` with keys `admin`, `alice` (ws-a), `bob` (ws-a), `vendor` (ws-v)
  - `interface PushRow { tbl: SyncedTable; row: Row }`
  - `interface PushResult { accepted: string[]; rejected: { id: string; reason: string }[]; server: PushRow[] }`
  - `interface PullResult { rows: PushRow[]; next: number; more: boolean }`
  - `push(db: Db, user: User, rows: unknown[]): Promise<PushResult>`
  - `pull(db: Db, user: User, since: number, limit?: number): Promise<PullResult>`

- [ ] **Step 1: Write the failing id-gen test**

`spike/test/id-gen.test.ts` (same cases as `qa-app/test/bugcode.check.js`):

```ts
import { expect, test } from 'bun:test';
import { nextInScope } from '../lib/id-gen';

test('empty scope starts at 0001', () => expect(nextInScope('BUG', [])).toBe('BUG-0001'));
test('highest in use + 1, gaps stay', () => expect(nextInScope('BUG', ['BUG-0001', 'BUG-0007', 'BUG-0003'])).toBe('BUG-0008'));
test('other prefixes and junk are ignored', () => expect(nextInScope('BUG', ['LOG-0042', 'BUG-x', null, 'BUG-0002'])).toBe('BUG-0003'));
test('grows past 4 digits', () => expect(nextInScope('BUG', ['BUG-9999'])).toBe('BUG-10000'));
```

- [ ] **Step 2: Run, verify FAIL, implement, verify PASS**

Run: `cd spike && bun test test/id-gen.test.ts` → FAIL (`Cannot find module`).

`spike/lib/id-gen.ts` (port of `qa-app/js/utils.js:450-462`):

```ts
// Next display number in a scope = highest number still in use + 1. Deleting rows frees
// their numbers; gaps in the middle stay (people refer to these numbers).
export function nextInScope(prefix: string, codesInScope: (string | null)[]): string {
  const re = new RegExp(`^${prefix}-(\\d+)$`);
  const max = codesInScope.reduce((m, c) => {
    const hit = String(c ?? '').match(re);
    return hit ? Math.max(m, parseInt(hit[1], 10)) : m;
  }, 0);
  return `${prefix}-${String(max + 1).padStart(4, '0')}`;
}
```

Run again → 4 pass.

- [ ] **Step 3: Write the failing sync-server tests**

`spike/lib/sync/users.ts`:

```ts
// shortcut: hard-coded users stand in for the session in the spike only; Phase 3 replaces this with iron-session + the users table.
export interface User { id: string; email: string; role: 'admin' | 'user'; workspaceIds: string[] }

export const USERS: Record<string, User> = {
  admin: { id: 'admin', email: 'admin@bugrail.test', role: 'admin', workspaceIds: [] },
  alice: { id: 'alice', email: 'alice@bugrail.test', role: 'user', workspaceIds: ['ws-a'] },
  bob: { id: 'bob', email: 'bob@bugrail.test', role: 'user', workspaceIds: ['ws-a'] },
  vendor: { id: 'vendor', email: 'qa@vendor.test', role: 'user', workspaceIds: ['ws-v'] },
};
```

`spike/test/sync-server.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applySchema } from '../lib/schema';
import { pull, push } from '../lib/sync/server';
import { USERS } from '../lib/sync/users';
import type { Db, Row } from '../lib/db-types';

let db: Db;
const h = (ms: number, dev = 'a') => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const file = (id: string, ws: string, over: Row = {}): Row => ({ id, name: id, workspace_id: ws, hlc: h(1), ...over });
const bug = (id: string, fileId: string, over: Row = {}): Row => ({
  id, file_id: fileId, title: id, module: 'Login', status_code: 'OPEN', status_hlc: h(1), hlc: h(1), ...over,
});

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applySchema(db, ['schema', 'server']);
  await push(db, USERS.admin, [
    { tbl: 'files', row: file('fa', 'ws-a') },
    { tbl: 'files', row: file('fv', 'ws-v') },
    { tbl: 'bugs', row: bug('ba', 'fa') },
    { tbl: 'bugs', row: bug('bv', 'fv') },
    { tbl: 'bug_events', row: { id: 'ea', bug_id: 'ba', kind: 'comment', text: 'secret' } },
  ]);
});

describe('push', () => {
  test('accepts rows, bumps server_seq, assigns codes per workspace', async () => {
    const all = await pull(db, USERS.admin, 0);
    expect(all.rows.length).toBe(5);
    expect(all.next).toBe(7); // 5 inserts + 2 code assignments
    const ba = await db.get('SELECT code FROM bugs WHERE id = ?', 'ba');
    const bv = await db.get('SELECT code FROM bugs WHERE id = ?', 'bv');
    expect(ba.code).toBe('BUG-0001');
    expect(bv.code).toBe('BUG-0001'); // separate scope (ws-v)
  });

  test('returns the server row when the server assigned a code', async () => {
    const r = await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b2', 'fa', { hlc: h(5) }) }]);
    expect(r.accepted).toEqual(['b2']);
    expect(r.server.find((s) => s.row.id === 'b2')?.row.code).toBe('BUG-0002');
  });

  test('ignores a client-supplied code and server_seq', async () => {
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('b3', 'fa', { code: 'BUG-9999', server_seq: 1e9, hlc: h(5) }) }]);
    const row = await db.get('SELECT code, server_seq FROM bugs WHERE id = ?', 'b3');
    expect(row.code).toBe('BUG-0002');
    expect(row.server_seq).toBeLessThan(1e9);
  });

  test('older write loses and the server row comes back', async () => {
    await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('ba', 'fa', { title: 'newer', hlc: h(10, 'b') }) }]);
    const r = await push(db, USERS.alice, [{ tbl: 'bugs', row: bug('ba', 'fa', { title: 'older', hlc: h(5, 'c') }) }]);
    expect(r.accepted).toEqual(['ba']);
    expect(r.server[0].row.title).toBe('newer');
  });

  // Review Focus 2
  test('the same push twice changes nothing the second time', async () => {
    const rows = [{ tbl: 'bugs', row: bug('b4', 'fa', { hlc: h(7) }) }];
    await push(db, USERS.alice, rows);
    const seqBefore = (await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value;
    await push(db, USERS.alice, rows);
    const seqAfter = (await db.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value;
    expect(seqAfter).toBe(seqBefore);
  });

  // Review Focus 1
  test('unknown or malicious table names are rejected, not executed', async () => {
    const r = await push(db, USERS.admin, [
      { tbl: 'sqlite_master', row: { id: 'x', hlc: h(9) } },
      { tbl: 'files; DROP TABLE bugs', row: { id: 'y', hlc: h(9) } },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['unknown table', 'unknown table']);
    expect((await db.get('SELECT count(*) AS n FROM bugs')).n).toBe(2);
  });

  // Review Focus 4
  test('rows without id, hlc or status_hlc are rejected', async () => {
    const r = await push(db, USERS.alice, [
      { tbl: 'bugs', row: { file_id: 'fa', hlc: h(9), status_hlc: h(9) } },
      { tbl: 'bugs', row: { id: 'n1', file_id: 'fa', status_hlc: h(9) } },
      { tbl: 'bugs', row: { id: 'n2', file_id: 'fa', hlc: h(9) } },
    ]);
    expect(r.rejected.map((x) => x.reason)).toEqual(['missing id', 'missing hlc', 'missing status_hlc']);
  });
});

describe('isolation', () => {
  test('vendor pull contains only ws-v rows', async () => {
    const r = await pull(db, USERS.vendor, 0);
    expect(r.rows.map((x) => x.row.id).sort()).toEqual(['bv', 'fv']);
  });

  test('vendor cannot write into another workspace', async () => {
    const r = await push(db, USERS.vendor, [
      { tbl: 'files', row: file('fx', 'ws-a', { hlc: h(9) }) },
      { tbl: 'bugs', row: bug('bx', 'fa', { hlc: h(9) }) },
      { tbl: 'bugs', row: bug('ba', 'fa', { title: 'hacked', hlc: h(99) }) },
      { tbl: 'bug_events', row: { id: 'ex', bug_id: 'ba', kind: 'comment', text: 'x' } },
      { tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } },
    ]);
    expect(r.accepted).toEqual([]);
    expect(r.rejected.length).toBe(5);
    expect((await db.get('SELECT title FROM bugs WHERE id = ?', 'ba')).title).toBe('ba');
  });

  test('a file shared into ws-v becomes visible to the vendor, and unsharing hides it', async () => {
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } }]);
    let ids = (await pull(db, USERS.vendor, 0)).rows.map((x) => x.row.id);
    expect(ids).toContain('fa');
    expect(ids).toContain('ba');
    expect(ids).toContain('ea');
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(10), deleted_at: 'now' } }]);
    ids = (await pull(db, USERS.vendor, 0)).rows.map((x) => x.row.id);
    expect(ids).not.toContain('fa');
    expect(ids).not.toContain('ba');
  });

  test('vendor can write inside a file shared into ws-v', async () => {
    await push(db, USERS.alice, [{ tbl: 'file_shares', row: { id: 'fa:ws-v', file_id: 'fa', workspace_id: 'ws-v', hlc: h(9) } }]);
    const r = await push(db, USERS.vendor, [{ tbl: 'bugs', row: bug('bnew', 'fa', { hlc: h(12) }) }]);
    expect(r.accepted).toEqual(['bnew']);
  });
});

describe('pull', () => {
  test('pages by server_seq with no gaps or duplicates', async () => {
    const seen: string[] = [];
    let since = 0;
    for (;;) {
      const page = await pull(db, USERS.admin, since, 2);
      seen.push(...page.rows.map((r) => r.row.id as string));
      since = page.next;
      if (!page.more) break;
    }
    expect(seen.sort()).toEqual(['ba', 'bv', 'ea', 'fa', 'fv']);
  });
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd spike && bun test test/sync-server.test.ts`
Expected: FAIL, `Cannot find module '../lib/sync/server'`.

- [ ] **Step 5: Implement the sync server**

`spike/lib/sync/server.ts`:

```ts
import { TABLES, SYNCED_TABLES, isSyncedTable, type SyncedTable } from '../../db/tables';
import { mergeArgs, mergeSql } from '../lww';
import { nextInScope } from '../id-gen';
import type { Db, Row, Tx } from '../db-types';
import type { User } from './users';

export interface PushRow { tbl: SyncedTable; row: Row }
export interface PushResult { accepted: string[]; rejected: { id: string; reason: string }[]; server: PushRow[] }
export interface PullResult { rows: PushRow[]; next: number; more: boolean }

export const MAX_PUSH = 500;
export const MAX_PULL = 2000;

const isAdmin = (u: User) => u.role === 'admin';
const inList = (n: number) => Array(n).fill('?').join(', ');

// Files the user may see: owned by one of their workspaces or shared into one.
function visibleFilesSql(u: User): { sql: string; params: string[] } {
  if (isAdmin(u)) return { sql: 'SELECT id FROM files', params: [] };
  const w = u.workspaceIds;
  if (w.length === 0) return { sql: 'SELECT id FROM files WHERE 0', params: [] };
  return {
    sql: `SELECT id FROM files WHERE workspace_id IN (${inList(w.length)})
          UNION SELECT file_id FROM file_shares WHERE deleted_at IS NULL AND workspace_id IN (${inList(w.length)})`,
    params: [...w, ...w],
  };
}

function visibilityFilter(tbl: SyncedTable, u: User): { sql: string; params: string[] } {
  if (isAdmin(u)) return { sql: '1', params: [] };
  const vf = visibleFilesSql(u);
  const w = u.workspaceIds;
  if (w.length === 0) return { sql: '0', params: [] };
  switch (tbl) {
    case 'files': return { sql: `id IN (${vf.sql})`, params: vf.params };
    case 'bugs': return { sql: `file_id IN (${vf.sql})`, params: vf.params };
    case 'bug_events': return { sql: `bug_id IN (SELECT id FROM bugs WHERE file_id IN (${vf.sql}))`, params: vf.params };
    case 'file_shares':
      return {
        sql: `workspace_id IN (${inList(w.length)}) OR file_id IN (SELECT id FROM files WHERE workspace_id IN (${inList(w.length)}))`,
        params: [...w, ...w],
      };
  }
}

async function fileVisible(tx: Tx, u: User, fileId: unknown): Promise<boolean> {
  if (isAdmin(u)) return true;
  const vf = visibleFilesSql(u);
  return !!(await tx.get(`SELECT 1 AS ok FROM (${vf.sql}) v WHERE v.id = ?`, ...vf.params, fileId));
}

async function ownsFile(tx: Tx, u: User, fileId: unknown): Promise<boolean> {
  if (isAdmin(u)) return true;
  const f = await tx.get('SELECT workspace_id FROM files WHERE id = ?', fileId);
  return !!f && u.workspaceIds.includes(f.workspace_id);
}

// shortcut: workspace membership only; the role permission matrix (can()) and status transition rules arrive in Phase 3.
async function denyReason(tx: Tx, u: User, tbl: SyncedTable, row: Row): Promise<string | null> {
  if (typeof row.id !== 'string' || !row.id) return 'missing id';
  if (TABLES[tbl].kind !== 'insert-only' && typeof row.hlc !== 'string') return 'missing hlc';
  if (TABLES[tbl].kind === 'lww+status' && typeof row.status_hlc !== 'string') return 'missing status_hlc';
  if (isAdmin(u)) return null;
  switch (tbl) {
    case 'files': {
      const existing = await tx.get('SELECT workspace_id FROM files WHERE id = ?', row.id);
      if (existing) {
        if (!u.workspaceIds.includes(existing.workspace_id)) return 'file belongs to another workspace';
        if (row.workspace_id !== existing.workspace_id) return 'only admin can move a file';
        return null;
      }
      return u.workspaceIds.includes(row.workspace_id as string) ? null : 'cannot create a file in another workspace';
    }
    case 'file_shares':
      return (await ownsFile(tx, u, row.file_id)) ? null : 'only the owning workspace can share a file';
    case 'bugs': {
      const existing = await tx.get('SELECT file_id FROM bugs WHERE id = ?', row.id);
      if (existing && !(await fileVisible(tx, u, existing.file_id))) return 'bug not visible';
      return (await fileVisible(tx, u, row.file_id)) ? null : 'file not visible';
    }
    case 'bug_events': {
      const b = await tx.get('SELECT file_id FROM bugs WHERE id = ?', row.bug_id);
      return b && (await fileVisible(tx, u, b.file_id)) ? null : 'bug not visible';
    }
  }
}

const comparable = (tbl: SyncedTable, row: Row) =>
  JSON.stringify(TABLES[tbl].columns.filter((c) => c !== 'server_seq').map((c) => row[c] ?? null));

export async function push(db: Db, user: User, input: unknown[]): Promise<PushResult> {
  const rows = input.slice(0, MAX_PUSH);
  const run = db.transactionAsync(async (tx: Tx) => {
    let seq = Number((await tx.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value);
    const result: PushResult = { accepted: [], rejected: [], server: [] };
    const sent = new Map<string, PushRow>();

    for (const item of rows as { tbl?: unknown; row?: Row }[]) {
      const row = { ...(item?.row ?? {}) };
      const id = String(row.id ?? '');
      const tbl = item?.tbl;
      if (!isSyncedTable(tbl)) { result.rejected.push({ id, reason: 'unknown table' }); continue; }
      const reason = await denyReason(tx, user, tbl, row);
      if (reason) { result.rejected.push({ id, reason }); continue; }
      if (TABLES[tbl].columns.includes('code')) row.code = null; // the server owns codes
      row.server_seq = seq + 1;
      const r = await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
      if (r.changes > 0) seq += 1;
      result.accepted.push(id);
      sent.set(`${tbl}:${id}`, { tbl, row });
    }

    // Assign display codes: scope = owning workspace of the bug's file.
    const pending = await tx.all(
      `SELECT b.id, f.workspace_id FROM bugs b JOIN files f ON f.id = b.file_id
       WHERE b.code IS NULL AND b.deleted_at IS NULL`,
    );
    for (const p of pending) {
      const codes = await tx.all(
        `SELECT b.code FROM bugs b JOIN files f ON f.id = b.file_id
         WHERE f.workspace_id = ? AND b.deleted_at IS NULL AND b.code IS NOT NULL`,
        p.workspace_id,
      );
      seq += 1;
      await tx.run('UPDATE bugs SET code = ?, server_seq = ? WHERE id = ? AND code IS NULL',
        nextInScope('BUG', codes.map((c) => c.code)), seq, p.id);
    }

    await tx.run("UPDATE sync_meta SET value = ? WHERE key = 'seq'", seq);

    for (const [, s] of sent) {
      const current = await tx.get(`SELECT * FROM ${s.tbl} WHERE id = ?`, s.row.id);
      if (current && comparable(s.tbl, current) !== comparable(s.tbl, s.row)) result.server.push({ tbl: s.tbl, row: current });
    }
    return result;
  });
  return run();
}

export async function pull(db: Db, user: User, since: number, limit = MAX_PULL): Promise<PullResult> {
  const pageSize = Math.min(limit, MAX_PULL);
  const all: (PushRow & { seq: number })[] = [];
  for (const tbl of SYNCED_TABLES) {
    const f = visibilityFilter(tbl, user);
    const rows = await db.all(
      `SELECT * FROM ${tbl} WHERE server_seq > ? AND (${f.sql}) ORDER BY server_seq LIMIT ?`,
      since, ...f.params, pageSize + 1,
    );
    for (const row of rows) all.push({ tbl, row, seq: Number(row.server_seq) });
  }
  all.sort((a, b) => a.seq - b.seq);
  const page = all.slice(0, pageSize);
  const next = page.length ? page[page.length - 1].seq : since;
  return { rows: page.map(({ tbl, row }) => ({ tbl, row })), next, more: all.length > pageSize };
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `cd spike && bun test test/sync-server.test.ts test/id-gen.test.ts`
Expected: all pass. A failure caused by the engine (for example `UNION` inside `IN (…)`, or `transactionAsync` behaviour) is a **G0.2 finding**: record the error in `G0-NOTES.md` before changing SQL.

- [ ] **Step 7: Commit**

```bash
git add spike/lib/id-gen.ts spike/lib/sync/users.ts spike/lib/sync/server.ts spike/test/id-gen.test.ts spike/test/sync-server.test.ts
git commit -m "feat(spike): sync server push/pull with workspace isolation and server-assigned codes"
```

---

### Task 5: Sync client and offline scenarios (G0.8, in-process)

**Files:**
- Create: `spike/lib/sync/client.ts`
- Test: `spike/test/sync-client.test.ts`

**Interfaces:**
- Consumes: `push`, `pull`, `PushRow`, `PushResult`, `PullResult` (Task 4); `mergeSql`, `mergeArgs`, `TABLES` (Task 3); `Clock` (Task 2).
- Produces:
  - `interface Transport { push(rows: PushRow[]): Promise<PushResult>; pull(since: number): Promise<PullResult> }`
  - `localWrite(db: Db, tbl: SyncedTable, row: Row): Promise<void>` (merge + outbox in one transaction)
  - `pushOutbox(db: Db, t: Transport): Promise<PushResult | null>` (null when the outbox is empty)
  - `pullAll(db: Db, t: Transport, clock?: Clock): Promise<number>` (rows applied)
  - `httpTransport(base: string, user: string): Transport`

- [ ] **Step 1: Write the failing scenario tests**

`spike/test/sync-client.test.ts`:

```ts
import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applySchema } from '../lib/schema';
import { pull, push } from '../lib/sync/server';
import { USERS } from '../lib/sync/users';
import { localWrite, pullAll, pushOutbox, type Transport } from '../lib/sync/client';
import type { Db, Row } from '../lib/db-types';

let server: Db;
const h = (ms: number, dev: string) => `${String(ms).padStart(15, '0')}-00000-${dev}`;
const direct = (user: keyof typeof USERS, pageSize?: number): Transport => ({
  push: (rows) => push(server, USERS[user], rows),
  pull: (since) => pull(server, USERS[user], since, pageSize),
});
async function device(): Promise<Db> {
  const db = (await connect(':memory:')) as unknown as Db;
  await applySchema(db, ['schema', 'local']);
  return db;
}
const bugRow = (over: Row): Row => ({ id: 'X', file_id: 'fa', title: 't', description: 'd', status_code: 'OPEN', status_hlc: h(1, 'a'), hlc: h(1, 'a'), ...over });
const serverBug = (id = 'X') => server.get('SELECT * FROM bugs WHERE id = ?', id);

beforeEach(async () => {
  server = (await connect(':memory:')) as unknown as Db;
  await applySchema(server, ['schema', 'server']);
  await push(server, USERS.admin, [
    { tbl: 'files', row: { id: 'fa', name: 'fa', workspace_id: 'ws-a', hlc: h(1, 'a') } },
    { tbl: 'bugs', row: bugRow({}) },
  ]);
});

describe('offline scenarios (G0.8)', () => {
  test('G0.1-equivalent: offline writes reach the server after push', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ id: 'N1', title: 'offline', hlc: h(5, 'a'), status_hlc: h(5, 'a') }));
    await localWrite(a, 'bugs', bugRow({ id: 'N2', title: 'offline2', hlc: h(6, 'a'), status_hlc: h(6, 'a') }));
    await pushOutbox(a, direct('alice'));
    expect((await serverBug('N1')).title).toBe('offline');
    expect((await serverBug('N2')).code).toMatch(/^BUG-\d{4}$/);
    expect((await a.get('SELECT count(*) AS n FROM outbox')).n).toBe(0);
  });

  test('true LWW: an older offline edit pushed later loses', async () => {
    const a = await device();
    const b = await device();
    await pullAll(a, direct('alice'));
    await pullAll(b, direct('bob'));
    await localWrite(a, 'bugs', bugRow({ title: 'A at t1', hlc: h(10, 'a') }));
    await localWrite(b, 'bugs', bugRow({ title: 'B at t2', hlc: h(20, 'b') }));
    await pushOutbox(b, direct('bob'));
    await pushOutbox(a, direct('alice'));
    expect((await serverBug()).title).toBe('B at t2');
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT title FROM bugs WHERE id = 'X'")).title).toBe('B at t2');
  });

  test('concurrent offline inserts both survive everywhere', async () => {
    const a = await device();
    const b = await device();
    await localWrite(a, 'bugs', bugRow({ id: 'A1', hlc: h(5, 'a') }));
    await localWrite(b, 'bugs', bugRow({ id: 'B1', hlc: h(5, 'b') }));
    await pushOutbox(a, direct('alice'));
    await pushOutbox(b, direct('bob'));
    await pullAll(a, direct('alice'));
    await pullAll(b, direct('bob'));
    for (const d of [a, b]) {
      const ids = (await d.all('SELECT id FROM bugs ORDER BY id')).map((r) => r.id);
      expect(ids).toEqual(['A1', 'B1', 'X']);
    }
  });

  test('rebase by id: an unpushed edit survives a pull and pushes after', async () => {
    const a = await device();
    await pullAll(a, direct('alice'));
    await localWrite(a, 'bugs', bugRow({ title: 'mine', hlc: h(30, 'a') }));
    await push(server, USERS.bob, [{ tbl: 'bugs', row: bugRow({ description: 'theirs', hlc: h(20, 'b') }) }]);
    await pullAll(a, direct('alice'));
    expect((await a.get("SELECT title FROM bugs WHERE id = 'X'")).title).toBe('mine');
    await pushOutbox(a, direct('alice'));
    expect((await serverBug()).title).toBe('mine');
  });

  test('status clock: a status move and a description edit both survive', async () => {
    const a = await device();
    const b = await device();
    await pullAll(a, direct('alice'));
    await pullAll(b, direct('bob'));
    await localWrite(a, 'bugs', { ...(await a.get("SELECT * FROM bugs WHERE id = 'X'")), status_code: 'RETEST', status_hlc: h(40, 'a') });
    await localWrite(b, 'bugs', { ...(await b.get("SELECT * FROM bugs WHERE id = 'X'")), description: 'edited', hlc: h(41, 'b') });
    await pushOutbox(a, direct('alice'));
    await pushOutbox(b, direct('bob'));
    const s = await serverBug();
    expect(s.status_code).toBe('RETEST');
    expect(s.description).toBe('edited');
  });

  test('two concurrent comments both remain', async () => {
    const a = await device();
    const b = await device();
    await localWrite(a, 'bug_events', { id: 'ca', bug_id: 'X', kind: 'comment', text: 'from A' });
    await localWrite(b, 'bug_events', { id: 'cb', bug_id: 'X', kind: 'comment', text: 'from B' });
    await pushOutbox(a, direct('alice'));
    await pushOutbox(b, direct('bob'));
    const texts = (await server.all("SELECT text FROM bug_events WHERE bug_id = 'X' ORDER BY id")).map((r) => r.text);
    expect(texts).toEqual(['from A', 'from B']);
  });

  // Review Focus 3
  test('pull loops across pages and applies every row once', async () => {
    for (let i = 0; i < 7; i++) {
      await push(server, USERS.admin, [{ tbl: 'bugs', row: bugRow({ id: `P${i}`, hlc: h(50 + i, 'a') }) }]);
    }
    const a = await device();
    await pullAll(a, direct('alice', 3));
    expect((await a.get('SELECT count(*) AS n FROM bugs')).n).toBe(8);
    expect((await a.get("SELECT value FROM meta WHERE key = 'since'")).value).toBe(
      String((await server.get("SELECT value FROM sync_meta WHERE key = 'seq'")).value),
    );
  });

  test('a write made while a push is in flight stays in the outbox', async () => {
    const a = await device();
    await localWrite(a, 'bugs', bugRow({ id: 'F1', hlc: h(60, 'a') }));
    const slow: Transport = {
      push: async (rows) => {
        await localWrite(a, 'bugs', bugRow({ id: 'F2', hlc: h(61, 'a') }));
        return push(server, USERS.alice, rows);
      },
      pull: (since) => pull(server, USERS.alice, since),
    };
    await pushOutbox(a, slow);
    const left = (await a.all('SELECT row_id FROM outbox')).map((r) => r.row_id);
    expect(left).toEqual(['F2']);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd spike && bun test test/sync-client.test.ts`
Expected: FAIL, `Cannot find module '../lib/sync/client'`.

- [ ] **Step 3: Implement the client**

`spike/lib/sync/client.ts`:

```ts
import { TABLES, isSyncedTable, type SyncedTable } from '../../db/tables';
import { mergeArgs, mergeSql } from '../lww';
import type { Clock } from '../hlc';
import type { Db, Row, Tx } from '../db-types';
import type { PullResult, PushResult, PushRow } from './server';

export interface Transport {
  push(rows: PushRow[]): Promise<PushResult>;
  pull(since: number): Promise<PullResult>;
}

export async function localWrite(db: Db, tbl: SyncedTable, row: Row): Promise<void> {
  const write = db.transactionAsync(async (tx: Tx) => {
    await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
    await tx.run('INSERT INTO outbox (tbl, row_id) VALUES (?, ?)', tbl, row.id);
  });
  await write();
}

export async function pushOutbox(db: Db, t: Transport): Promise<PushResult | null> {
  const entries = await db.all(
    'SELECT tbl, row_id, MAX(seq) AS seq FROM outbox GROUP BY tbl, row_id ORDER BY MIN(seq) LIMIT 500',
  );
  if (entries.length === 0) return null;
  const maxSeq = Math.max(...entries.map((e) => Number(e.seq)));
  const rows: PushRow[] = [];
  for (const e of entries) {
    if (!isSyncedTable(e.tbl)) continue;
    const row = await db.get(`SELECT * FROM ${e.tbl} WHERE id = ?`, e.row_id);
    if (row) rows.push({ tbl: e.tbl, row });
  }
  const result = await t.push(rows);
  const settle = db.transactionAsync(async (tx: Tx) => {
    for (const s of result.server) await tx.run(mergeSql(TABLES[s.tbl]), ...mergeArgs(TABLES[s.tbl], s.row));
    // Only entries that existed when the push started; later writes stay queued.
    for (const e of entries) {
      await tx.run('DELETE FROM outbox WHERE tbl = ? AND row_id = ? AND seq <= ?', e.tbl, e.row_id, maxSeq);
    }
  });
  await settle();
  return result;
}

export async function pullAll(db: Db, t: Transport, clock?: Clock): Promise<number> {
  let applied = 0;
  for (;;) {
    const sinceRow = await db.get("SELECT value FROM meta WHERE key = 'since'");
    const page = await t.pull(Number(sinceRow?.value ?? 0));
    const apply = db.transactionAsync(async (tx: Tx) => {
      for (const { tbl, row } of page.rows) {
        if (!isSyncedTable(tbl)) continue;
        if (clock && typeof row.hlc === 'string') clock.observe(row.hlc);
        await tx.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], row));
      }
      await tx.run(
        "INSERT INTO meta (key, value) VALUES ('since', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        String(page.next),
      );
    });
    await apply();
    applied += page.rows.length;
    if (!page.more) return applied;
  }
}

export function httpTransport(base: string, user: string): Transport {
  // shortcut: x-spike-user stands in for the session cookie in the spike only.
  const headers = { 'content-type': 'application/json', 'x-spike-user': user };
  return {
    async push(rows) {
      const res = await fetch(`${base}/api/sync/push`, { method: 'POST', headers, body: JSON.stringify({ rows }) });
      if (!res.ok) throw new Error(`push ${res.status}`);
      return res.json();
    },
    async pull(since) {
      const res = await fetch(`${base}/api/sync/pull?since=${since}`, { headers });
      if (!res.ok) throw new Error(`pull ${res.status}`);
      return res.json();
    },
  };
}
```

Note: the outbox delete uses `seq <= maxSeq` per `(tbl, row_id)`, so a write to the same row made during the push (higher `seq`) stays queued and is pushed next time.

- [ ] **Step 4: Run to verify it passes**

Run: `cd spike && bun test`
Expected: every test in `test/` passes.

- [ ] **Step 5: Commit**

```bash
git add spike/lib/sync/client.ts spike/test/sync-client.test.ts
git commit -m "feat(spike): sync client with outbox, paged pull and offline scenario tests"
```

---

### Task 6: Sync route handlers and the 3-client convergence script (G0.8 over HTTP)

**Files:**
- Create: `spike/lib/server-db.ts`, `spike/app/api/sync/push/route.ts`, `spike/app/api/sync/pull/route.ts`, `spike/scripts/converge.ts`

**Interfaces:**
- Consumes: `push`, `pull`, `USERS` (Task 4); `localWrite`, `pushOutbox`, `pullAll`, `httpTransport` (Task 5); `createClock` (Task 2); `applySchema` (Task 3).
- Produces: `getServerDb(): Promise<Db>`; HTTP `POST /api/sync/push` (body `{rows}`) and `GET /api/sync/pull?since=N`, both returning 401 for an unknown `x-spike-user`; every response carries a `Date` header.

- [ ] **Step 1: Server DB singleton and routes**

`spike/lib/server-db.ts`:

```ts
import { connect } from '@tursodatabase/database';
import { applySchema } from './schema';
import type { Db } from './db-types';

const g = globalThis as unknown as { __bugrailDb?: Promise<Db> };

export function getServerDb(): Promise<Db> {
  g.__bugrailDb ??= (async () => {
    const db = (await connect(process.env.BUGRAIL_DB_PATH ?? 'data/server.db')) as unknown as Db;
    await applySchema(db, ['schema', 'server']);
    return db;
  })();
  return g.__bugrailDb;
}
```

`spike/app/api/sync/push/route.ts`:

```ts
import { getServerDb } from '@/lib/server-db';
import { push } from '@/lib/sync/server';
import { USERS } from '@/lib/sync/users';

export async function POST(req: Request) {
  const user = USERS[req.headers.get('x-spike-user') ?? ''];
  if (!user) return new Response('unauthorized', { status: 401, headers: { date: new Date().toUTCString() } });
  const body = await req.json().catch(() => null);
  if (!body || !Array.isArray(body.rows)) return new Response('bad request', { status: 400 });
  const result = await push(await getServerDb(), user, body.rows);
  return Response.json(result, { headers: { date: new Date().toUTCString() } });
}
```

`spike/app/api/sync/pull/route.ts`:

```ts
import { getServerDb } from '@/lib/server-db';
import { pull } from '@/lib/sync/server';
import { USERS } from '@/lib/sync/users';

export async function GET(req: Request) {
  const user = USERS[req.headers.get('x-spike-user') ?? ''];
  if (!user) return new Response('unauthorized', { status: 401, headers: { date: new Date().toUTCString() } });
  const since = Number(new URL(req.url).searchParams.get('since') ?? 0);
  if (!Number.isFinite(since) || since < 0) return new Response('bad request', { status: 400 });
  const result = await pull(await getServerDb(), user, since);
  return Response.json(result, { headers: { date: new Date().toUTCString() } });
}
```

- [ ] **Step 2: Build, start, check 401 and a round trip**

```bash
cd spike && mkdir -p data && rm -f data/server.db* && bun run build && (bun run start &) && sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:3100/api/sync/pull?since=0
curl -s -H 'x-spike-user: admin' 'http://localhost:3100/api/sync/pull?since=0'
```

Expected: `401`, then `{"rows":[],"next":0,"more":false}`. If the build fails importing `@tursodatabase/database`, record the exact error in `G0-NOTES.md`; that is a G0.4/G0.2 finding, not something to work around silently.

- [ ] **Step 3: Write the convergence script**

`spike/scripts/converge.ts`:

```ts
// G0.8 over HTTP: 3 devices make random offline edits, sync in random order, and must converge.
import { connect } from '@tursodatabase/database';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../lib/schema';
import { createClock } from '../lib/hlc';
import { httpTransport, localWrite, pullAll, pushOutbox } from '../lib/sync/client';
import type { Db } from '../lib/db-types';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const ROUNDS = Number(process.env.ROUNDS ?? 300);
let seed = Number(process.env.SEED ?? 7);
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pick = <T>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

const dir = mkdtempSync(join(tmpdir(), 'g0-converge-'));
const names = ['alice', 'bob', 'admin'] as const;
const devices: { name: string; db: Db; clock: ReturnType<typeof createClock> }[] = [];
for (const name of names) {
  const db = (await connect(join(dir, `${name}.db`))) as unknown as Db;
  await applySchema(db, ['schema', 'local']);
  devices.push({ name, db, clock: createClock(`dev-${name}`) });
}
const t = (name: string) => httpTransport(BASE, name);

const fileId = `f-${crypto.randomUUID()}`;
const a = devices[0];
await localWrite(a.db, 'files', { id: fileId, name: 'converge', workspace_id: 'ws-a', hlc: a.clock.now() });
const bugIds = Array.from({ length: 5 }, () => crypto.randomUUID());
for (const id of bugIds) {
  const now = a.clock.now();
  await localWrite(a.db, 'bugs', { id, file_id: fileId, title: 'seed', status_code: 'OPEN', status_hlc: now, hlc: now });
}
await pushOutbox(a.db, t(a.name));
for (const d of devices) await pullAll(d.db, t(d.name), d.clock);

for (let i = 0; i < ROUNDS; i++) {
  const d = pick(devices);
  const id = pick(bugIds);
  const r = rand();
  if (r < 0.15) {
    await pushOutbox(d.db, t(d.name));
    await pullAll(d.db, t(d.name), d.clock);
    continue;
  }
  const cur = await d.db.get('SELECT * FROM bugs WHERE id = ?', id);
  if (r < 0.5) await localWrite(d.db, 'bugs', { ...cur, title: `${d.name}-${i}`, hlc: d.clock.now() });
  else if (r < 0.75) await localWrite(d.db, 'bugs', { ...cur, status_code: pick(['OPEN', 'RETEST', 'CLOSED']), status_hlc: d.clock.now() });
  else await localWrite(d.db, 'bug_events', { id: crypto.randomUUID(), bug_id: id, kind: 'comment', at: new Date().toISOString(), text: `${d.name}-${i}` });
}

for (let pass = 0; pass < 2; pass++) {
  for (const d of devices) {
    while (await pushOutbox(d.db, t(d.name))) { /* drain */ }
    await pullAll(d.db, t(d.name), d.clock);
  }
}

const dump = async (db: Db) => JSON.stringify({
  bugs: await db.all(`SELECT id, code, title, status_code, status_hlc, hlc, deleted_at FROM bugs WHERE file_id = ? ORDER BY id`, fileId),
  events: await db.all(`SELECT id, text FROM bug_events WHERE bug_id IN (SELECT id FROM bugs WHERE file_id = ?) ORDER BY id`, fileId),
});
const dumps = await Promise.all(devices.map((d) => dump(d.db)));
const ok = dumps.every((x) => x === dumps[0]);
const coded = JSON.parse(dumps[0]).bugs.every((b: { code: string | null }) => /^BUG-\d{4,}$/.test(String(b.code)));
console.log(JSON.stringify({ check: 'G0.8', rounds: ROUNDS, converged: ok, allCoded: coded }));
process.exit(ok && coded ? 0 : 1);
```

- [ ] **Step 4: Run it three times with different seeds**

```bash
cd spike && for s in 1 2 3; do SEED=$s bun scripts/converge.ts || echo "FAIL seed $s"; done
```

Expected: three lines `{"check":"G0.8",…,"converged":true,"allCoded":true}` and no `FAIL`. Copy the output into `G0-NOTES.md`.

- [ ] **Step 5: Commit**

```bash
git add spike/lib/server-db.ts spike/app/api/sync spike/scripts/converge.ts spike/G0-NOTES.md
git commit -m "feat(spike): sync routes and 3-device HTTP convergence check (G0.8)"
```

---

### Task 7: Production-sized seed, load test and bootstrap timing (G0.3, G0.5 Node half)

**Files:**
- Create: `spike/scripts/seed.ts`, `spike/scripts/load.ts`

**Interfaces:**
- Consumes: `applySchema`, `mergeSql`, `mergeArgs`, `TABLES`, `nextInScope`, `httpTransport`, `localWrite`, `pushOutbox`, `pullAll`, `createClock`.
- Produces: `data/server.db` sized like production; load and bootstrap numbers in `G0-NOTES.md`.

Before starting, ask the human partner for production sizes: the length of `qa_files`, `qa_testcases` and `qa_bugs`, plus the total of `activity + comments + assignments` across bugs, and `db.kv_store.stats().size`. Until they arrive, use the defaults below; the script prints the resulting DB size so the two can be compared. Test cases have the same table kind as bugs, so the spike seeds their count as extra `bugs` rows.

- [ ] **Step 1: Seed script**

`spike/scripts/seed.ts`:

```ts
// Build a production-sized server.db. Usage:
// bun scripts/seed.ts --db data/server.db --files 150 --rows 6000 --events 18000
// Workspaces: file-0 is ws-v (the vendor's), file-1, file-5, … are ws-a (alice/bob), the rest ws-2/ws-3/ws-0.
import { connect } from '@tursodatabase/database';
import { statSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { applySchema } from '../lib/schema';
import { TABLES } from '../db/tables';
import { mergeArgs, mergeSql } from '../lib/lww';
import type { Db } from '../lib/db-types';

const { values } = parseArgs({
  options: {
    db: { type: 'string', default: 'data/server.db' },
    files: { type: 'string', default: '150' },
    rows: { type: 'string', default: '6000' },
    events: { type: 'string', default: '18000' },
  },
});
const n = (k: keyof typeof values) => Number(values[k]);
const db = (await connect(values.db!)) as unknown as Db;
await applySchema(db, ['schema', 'server']);

const hlc = '000000000000001-00000-migrate';
const text = (len: number) => 'lorem ipsum dolor sit amet '.repeat(Math.ceil(len / 27)).slice(0, len);
let seq = 0;
const insert = (tbl: keyof typeof TABLES, row: Record<string, unknown>) =>
  db.run(mergeSql(TABLES[tbl]), ...mergeArgs(TABLES[tbl], { ...row, server_seq: ++seq }));

const wsOf = (fileIndex: number) => (fileIndex === 0 ? 'ws-v' : fileIndex % 4 === 1 ? 'ws-a' : `ws-${fileIndex % 4}`);
const fileIds: string[] = [];
for (let i = 0; i < n('files'); i++) {
  const id = `file-${i}`;
  fileIds.push(id);
  await insert('files', { id, name: `File ${i}`, workspace_id: wsOf(i), hlc });
}
const bugIds: string[] = [];
const perScope = new Map<string, number>();
for (let i = 0; i < n('rows'); i++) {
  const id = `bug-${i}`;
  const fileId = fileIds[i % fileIds.length];
  const scope = wsOf(i % fileIds.length);
  const next = (perScope.get(scope) ?? 0) + 1;
  perScope.set(scope, next);
  bugIds.push(id);
  await insert('bugs', {
    id, code: `BUG-${String(next).padStart(4, '0')}`, file_id: fileId, title: text(60), module: 'Login',
    severity: 'Major', priority: 'High', status_code: 'OPEN', status_hlc: hlc, description: text(400),
    steps: text(600), expected_result: text(150), actual_result: text(150), hlc,
  });
}
for (let i = 0; i < n('events'); i++) {
  await insert('bug_events', { id: `ev-${i}`, bug_id: bugIds[i % bugIds.length], kind: 'comment', at: '2026-10-01T00:00:00Z', text: text(200) });
}
await db.run("UPDATE sync_meta SET value = ? WHERE key = 'seq'", seq);
await db.exec('PRAGMA wal_checkpoint(TRUNCATE)').catch(() => {});
console.log(JSON.stringify({ seeded: seq, bytes: statSync(values.db!).size }));
```

Run:

```bash
cd spike && rm -f data/server.db* && bun scripts/seed.ts
```

Expected: one JSON line with `seeded` = files + rows + events and `bytes` > 0. Record it.

- [ ] **Step 2: Load script**

`spike/scripts/load.ts`:

```ts
// G0.3: CLIENTS devices push+pull every INTERVAL_MS for DURATION_MS. G0.5: time each cold bootstrap.
import { connect } from '@tursodatabase/database';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applySchema } from '../lib/schema';
import { createClock } from '../lib/hlc';
import { httpTransport, localWrite, pullAll, pushOutbox } from '../lib/sync/client';
import type { Db } from '../lib/db-types';

const BASE = process.env.BASE ?? 'http://localhost:3100';
const CLIENTS = Number(process.env.CLIENTS ?? 30);
const INTERVAL_MS = Number(process.env.INTERVAL_MS ?? 10_000);
const DURATION_MS = Number(process.env.DURATION_MS ?? 600_000);
const dir = mkdtempSync(join(tmpdir(), 'g0-load-'));

const cycles: number[] = [];
const bootstraps: number[] = [];
let errors = 0;

async function client(i: number) {
  const user = i === 0 ? 'vendor' : i % 2 ? 'alice' : 'admin';
  const t = httpTransport(BASE, user);
  const clock = createClock(`load-${i}`);
  const db = (await connect(join(dir, `c${i}.db`))) as unknown as Db;
  await applySchema(db, ['schema', 'local']);
  const b0 = performance.now();
  await pullAll(db, t, clock);
  bootstraps.push(performance.now() - b0);

  const fileId = user === 'vendor' ? 'file-0' : 'file-1'; // ws-v / ws-a in seed.ts
  const end = Date.now() + DURATION_MS;
  while (Date.now() < end) {
    await new Promise((r) => setTimeout(r, INTERVAL_MS * (0.5 + Math.random())));
    try {
      const now = clock.now();
      await localWrite(db, 'bugs', { id: crypto.randomUUID(), file_id: fileId, title: `load ${i}`, status_code: 'OPEN', status_hlc: now, hlc: now });
      const c0 = performance.now();
      await pushOutbox(db, t);
      await pullAll(db, t, clock);
      cycles.push(performance.now() - c0);
    } catch (e) {
      errors += 1;
      console.error(`client ${i}:`, (e as Error).message);
    }
  }
}

const pct = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))] ?? NaN;
await Promise.all(Array.from({ length: CLIENTS }, (_, i) => client(i)));
const report = {
  check: 'G0.3/G0.5', clients: CLIENTS, cycles: cycles.length, errors,
  p50ms: Math.round(pct(cycles, 0.5)), p95ms: Math.round(pct(cycles, 0.95)),
  bootstrapP95ms: Math.round(pct(bootstraps, 0.95)), bootstrapMaxms: Math.round(Math.max(...bootstraps)),
};
console.log(JSON.stringify(report));
process.exit(report.errors === 0 && report.p95ms < 1000 && report.bootstrapMaxms < 10_000 ? 0 : 1);
```

- [ ] **Step 3: Smoke run, then the real run**

```bash
cd spike && bun run build && (bun run start &) && sleep 5
CLIENTS=3 DURATION_MS=20000 INTERVAL_MS=2000 bun scripts/load.ts   # smoke: exits 0
bun scripts/load.ts                                                  # real: 30 clients, 10 min
```

Expected (real run): exit code 0, `errors: 0`, `p95ms < 1000` (**G0.3**), `bootstrapMaxms < 10000` (**G0.5, Node side**). Record the JSON line in `G0-NOTES.md` with the seed sizes. Note: 30 clients bootstrap at once at the start, which is harsher than real use; if only `bootstrapMaxms` fails, rerun with `CLIENTS=1 DURATION_MS=1000` to get the single-device bootstrap time and record both numbers.

- [ ] **Step 4: Commit**

```bash
git add spike/scripts/seed.ts spike/scripts/load.ts spike/G0-NOTES.md
git commit -m "feat(spike): production-sized seed and 30-client load test (G0.3, G0.5)"
```

---

### Task 8: Browser checks: OPFS, wasm merge and browser bootstrap (G0.1, G0.2 wasm half, G0.5 browser half)

**Files:**
- Create: `spike/app/opfs/page.tsx`, `spike/app/opfs/OpfsCheck.tsx`

**Interfaces:**
- Consumes: `applySchema`, `mergeSql`, `mergeArgs`, `TABLES`, `httpTransport`, `pullAll`, `Db`.
- Produces: a `/opfs` page that prints one line per check: `crossOriginIsolated`, `boots` (increments per reload), `persist`, `wasmMerge`, `bootstrapMs`/`bootstrapRows`.

- [ ] **Step 1: Page and client component**

`spike/app/opfs/page.tsx`:

```tsx
import OpfsCheck from './OpfsCheck';

export default function Page() {
  return (
    <main>
      <h1>OPFS checks</h1>
      <OpfsCheck />
    </main>
  );
}
```

`spike/app/opfs/OpfsCheck.tsx`:

```tsx
'use client';
import { useEffect, useState } from 'react';
import { TABLES } from '@/db/tables';
import { mergeArgs, mergeSql } from '@/lib/lww';
import { applySchema } from '@/lib/schema';
import { httpTransport, pullAll } from '@/lib/sync/client';
import type { Db } from '@/lib/db-types';

type Line = [string, string];

async function open(name: string): Promise<Db> {
  const { connect } = await import('@tursodatabase/database-wasm/turbopack');
  return (await connect(name)) as unknown as Db;
}

async function wasmMergeCheck(): Promise<string> {
  const db = await open('selftest.db');
  await db.exec('DROP TABLE IF EXISTS bugs');
  await applySchema(db, ['schema']);
  const t = TABLES.bugs;
  const base = { id: 'b1', title: 't0', description: 'd0', status_code: 'OPEN', status_hlc: '000000000001000-00000-a', hlc: '000000000001000-00000-a' };
  await db.run(mergeSql(t), ...mergeArgs(t, base));
  await db.run(mergeSql(t), ...mergeArgs(t, { ...base, description: 'A', hlc: '000000000002000-00000-a' }));
  await db.run(mergeSql(t), ...mergeArgs(t, { ...base, status_code: 'RETEST', status_hlc: '000000000003000-00000-b' }));
  const old = await db.run(mergeSql(t), ...mergeArgs(t, { ...base, title: 'old', hlc: '000000000001500-00000-c' }));
  const row = await db.get("SELECT * FROM bugs WHERE id = 'b1'");
  const ok = row.description === 'A' && row.status_code === 'RETEST' && row.title === 't0' && old.changes === 0;
  return ok ? 'PASS' : `FAIL ${JSON.stringify(row)}`;
}

export default function OpfsCheck() {
  const [lines, setLines] = useState<Line[]>([]);
  const add = (k: string, v: string) => setLines((ls) => [...ls, [k, v]]);

  useEffect(() => {
    (async () => {
      add('userAgent', navigator.userAgent);
      add('crossOriginIsolated', String(globalThis.crossOriginIsolated));
      try {
        const db = await open('spike.db');
        await db.exec('CREATE TABLE IF NOT EXISTS boots (id INTEGER PRIMARY KEY AUTOINCREMENT, at TEXT)');
        await db.run('INSERT INTO boots (at) VALUES (?)', new Date().toISOString());
        add('boots (reload: must grow)', String((await db.get('SELECT count(*) AS n FROM boots')).n));
      } catch (e) {
        add('opfs', `FAIL ${(e as Error).message}`);
      }
      add('persist', String(await navigator.storage?.persist?.()));
      try {
        add('wasmMerge (G0.2)', await wasmMergeCheck());
      } catch (e) {
        add('wasmMerge (G0.2)', `FAIL ${(e as Error).message}`);
      }
    })();
  }, []);

  async function bootstrap() {
    const name = `boot-${Date.now()}.db`;
    const db = await open(name);
    await applySchema(db, ['schema', 'local']);
    const t0 = performance.now();
    const rows = await pullAll(db, httpTransport(location.origin, 'admin'));
    add('bootstrapMs (G0.5 < 10000)', String(Math.round(performance.now() - t0)));
    add('bootstrapRows', String(rows));
  }

  return (
    <section>
      <button type="button" onClick={bootstrap}>Run full bootstrap</button>
      <pre data-testid="results">{lines.map(([k, v]) => `${k}: ${v}`).join('\n')}</pre>
    </section>
  );
}
```

- [ ] **Step 2: Build and run against the seeded DB**

```bash
cd spike && bun run build && BUGRAIL_DB_PATH=data/server.db bun run start
```

- [ ] **Step 3: Chrome check (agent can drive this with the Interceptor skill)**

Open `http://localhost:3100/opfs`, read the results, reload twice, click "Run full bootstrap".
Expected: `crossOriginIsolated: true`; `boots` grows by 1 per reload; `persist: true` (Chrome may return `false` for a site that isn't installed or bookmarked; record the value as-is); `wasmMerge (G0.2): PASS`; `bootstrapMs` < 10000. Screenshot the result block.

- [ ] **Step 4: Edge, Firefox and Safari (human partner)**

Ask the human partner to repeat Step 3 in current Edge, Firefox and Safari on their Mac and paste back the `results` block from each. Safari: `localhost` is a secure context, so OPFS is available.

- [ ] **Step 5: Record and commit**

Add a table to `G0-NOTES.md`: one row per browser with version, `crossOriginIsolated`, `boots` after two reloads, `persist`, `wasmMerge`, `bootstrapMs`. **G0.1** passes when all four browsers open the DB, keep it across reloads and run the merge; `persist` values are recorded for the risk register. **G0.2** passes when Task 3 tests and `wasmMerge` all pass.

```bash
git add spike/app/opfs spike/G0-NOTES.md
git commit -m "feat(spike): browser OPFS, wasm merge and bootstrap checks (G0.1, G0.2, G0.5)"
```

---

### Task 9: Offline shell: service worker, instant navigation and `useOffline` (G0.6)

**Files:**
- Create: `spike/public/sw.js`, `spike/app/sw-register.tsx`, `spike/app/offline-badge.tsx`
- Modify: `spike/app/layout.tsx`

**Interfaces:**
- Consumes: Next config from Task 1 (`cacheComponents`, `partialPrefetching`, `experimental.useOffline`).
- Produces: an app that reloads offline from the SW cache and soft-navigates offline between prefetched routes.

- [ ] **Step 1: Service worker**

`spike/public/sw.js`:

```js
// Shell + static cache. API calls always go to the network (sync handles offline data).
const CACHE = 'bugrail-spike-v1';
const SHELL = ['/', '/opfs', '/other'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

const put = (req, res) => caches.open(CACHE).then((c) => c.put(req, res));

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;

  if (url.pathname.startsWith('/_next/static/')) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req).then((res) => { put(req, res.clone()); return res; })),
    );
    return;
  }

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => { put(req, res.clone()); return res; })
        .catch(() => caches.match(req).then((hit) => hit || caches.match('/'))),
    );
  }
});
```

- [ ] **Step 2: Registration and offline badge**

`spike/app/sw-register.tsx`:

```tsx
'use client';
import { useEffect } from 'react';

export default function SwRegister() {
  useEffect(() => {
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
  }, []);
  return null;
}
```

`spike/app/offline-badge.tsx`:

```tsx
'use client';
import { useOffline } from 'next/offline';

export default function OfflineBadge() {
  const offline = useOffline();
  return <p data-testid="conn">{offline ? 'offline' : 'online'}</p>;
}
```

Replace `spike/app/layout.tsx`:

```tsx
import OfflineBadge from './offline-badge';
import SwRegister from './sw-register';

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <OfflineBadge />
        <SwRegister />
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Build and run the offline checks in Chrome**

```bash
cd spike && bun run build && BUGRAIL_DB_PATH=data/server.db bun run start
```

1. Open `http://localhost:3100/`, wait until DevTools → Application → Service Workers shows `sw.js` activated, then visit `/opfs` once (caches the wasm chunk).
2. DevTools → Network → Offline.
3. Reload `/`. Expected: page renders, badge shows `offline`.
4. Click "Other page". Expected: soft navigation renders `/other` without a browser error page.
5. Navigate to `/opfs` and reload while still offline. Expected: page renders, `boots` grows, `wasmMerge: PASS` (the wasm came from cache).
6. Go back online. Expected: badge returns to `online` within about 3 s.

Record each step's result and a screenshot in `G0-NOTES.md`. **G0.6** passes when steps 3–6 behave as expected. Ask the human partner to run steps 1–6 in Safari as well.

- [ ] **Step 4: Commit**

```bash
git add spike/public/sw.js spike/app/sw-register.tsx spike/app/offline-badge.tsx spike/app/layout.tsx spike/G0-NOTES.md
git commit -m "feat(spike): service worker, offline badge and offline navigation check (G0.6)"
```

---

### Task 10: Bun as the production runtime (G0.4)

**Files:**
- Modify: `spike/G0-NOTES.md`

**Interfaces:**
- Consumes: everything built so far; `scripts/converge.ts`, `scripts/load.ts`.
- Produces: the runtime decision for ADR-004.

- [ ] **Step 1: Build and start under Bun's runtime**

```bash
cd spike && rm -rf .next && bun --bun next build && (BUGRAIL_DB_PATH=data/server.db bun --bun next start -p 3100 &) && sleep 5
curl -s -H 'x-spike-user: admin' 'http://localhost:3100/api/sync/pull?since=0' | head -c 200
```

Expected: build succeeds and the pull returns JSON rows (proves the native `@tursodatabase/database` binding loads under Bun).

- [ ] **Step 2: Same checks under Bun**

```bash
cd spike && for s in 1 2 3; do SEED=$s bun scripts/converge.ts || echo "FAIL seed $s"; done
bun scripts/load.ts
```

Expected: G0.8 converges for all seeds, and the load JSON meets the G0.3 thresholds.

- [ ] **Step 3: Same load under Node for comparison**

```bash
pkill -f 'next start' ; cd spike && rm -rf .next && npx next build && (BUGRAIL_DB_PATH=data/server.db node node_modules/next/dist/bin/next start -p 3100 &) && sleep 5
bun scripts/load.ts
```

- [ ] **Step 4: Record and commit**

Add both load JSON lines to `G0-NOTES.md`. **G0.4** passes when Step 1 and Step 2 pass under Bun. Production runtime = Bun if G0.4 passes and Bun's p95 is not worse than Node's by more than 20%; otherwise Node 24.

```bash
git add spike/G0-NOTES.md
git commit -m "docs(spike): record Bun vs Node runtime results (G0.4)"
```

---

### Task 11: Backup while writing (G0.7)

**Files:**
- Create: `spike/app/api/spike/backup/route.ts`, `spike/scripts/backup-check.ts`

**Interfaces:**
- Consumes: `getServerDb` (Task 6), load script (Task 7).
- Produces: a verified backup method for the spec's Operations section.

- [ ] **Step 1: In-process `VACUUM INTO` route**

`spike/app/api/spike/backup/route.ts`:

```ts
import { getServerDb } from '@/lib/server-db';

// shortcut: unauthenticated spike-only endpoint; production runs backups from a systemd timer through an admin-only path.
export async function POST(req: Request) {
  const target = new URL(req.url).searchParams.get('to');
  if (!target || !/^[\w./-]+\.db$/.test(target)) return new Response('bad target', { status: 400 });
  const db = await getServerDb();
  const t0 = performance.now();
  try {
    await db.exec(`VACUUM INTO '${target}'`);
    return Response.json({ ok: true, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    return Response.json({ ok: false, error: (e as Error).message }, { status: 500 });
  }
}
```

`spike/scripts/backup-check.ts`:

```ts
// G0.7: open the backup copy and compare row counts with the live DB at roughly the same moment.
import { connect } from '@tursodatabase/database';
import type { Db } from '../lib/db-types';

const copy = process.argv[2];
if (!copy) throw new Error('usage: bun scripts/backup-check.ts <copy.db>');
const db = (await connect(copy, { readonly: true })) as unknown as Db;
const counts: Record<string, number> = {};
for (const t of ['files', 'bugs', 'bug_events']) counts[t] = (await db.get(`SELECT count(*) AS n FROM ${t}`)).n;
const integrity = await db.get('PRAGMA integrity_check').catch((e: Error) => ({ integrity_check: `unsupported: ${e.message}` }));
console.log(JSON.stringify({ check: 'G0.7', copy, counts, integrity }));
process.exit(counts.bugs > 0 ? 0 : 1);
```

- [ ] **Step 2: Run a backup during load**

```bash
cd spike && bun run build && (BUGRAIL_DB_PATH=data/server.db bun run start &) && sleep 5
(CLIENTS=10 DURATION_MS=60000 INTERVAL_MS=2000 bun scripts/load.ts &) ; sleep 20
curl -s -X POST 'http://localhost:3100/api/spike/backup?to=data/backup-test.db'
bun scripts/backup-check.ts data/backup-test.db
```

Expected: the POST returns `{"ok":true,…}` and the check prints counts close to the seeded sizes, with `integrity_check` `ok` or recorded as unsupported. **G0.7** passes when the copy opens and has rows.

- [ ] **Step 3: Fallback if `VACUUM INTO` is unsupported**

If Step 2 returns `ok: false`, test the fallback: stop the app, `cp data/server.db* data/fallback/`, start the app, run `bun scripts/backup-check.ts data/fallback/server.db`, and record how long the app was down. The spec's Operations section already names this fallback.

- [ ] **Step 4: Commit**

```bash
git add spike/app/api/spike/backup spike/scripts/backup-check.ts spike/G0-NOTES.md
git commit -m "feat(spike): backup-while-writing check (G0.7)"
```

---

### Task 12: Record the G0 verdict

**Files:**
- Modify: `docs/adr/ADR-001-self-hosted-turso-own-sync.md`, `docs/adr/ADR-004-bun-runtime.md`, `README.md` (only if a fallback was taken), `docs/superpowers/specs/2026-10-13-bugrail-local-first-design.md` (only if a fallback was taken)
- Keep: `spike/G0-NOTES.md` (evidence)

**Interfaces:**
- Consumes: every result recorded in `spike/G0-NOTES.md`.
- Produces: the go/no-go for Phase 1.

- [ ] **Step 1: Append the results table to ADR-001**

Add a section to `docs/adr/ADR-001-self-hosted-turso-own-sync.md`, filling each row from `G0-NOTES.md`:

```markdown
## G0 results (YYYY-MM-DD)

| Check | Result | Evidence |
|-------|--------|----------|
| G0.1 Browsers (Chrome, Edge, Firefox, Safari) | PASS/FAIL per browser | spike/G0-NOTES.md § Browsers |
| G0.2 Guarded upsert on both engines | PASS/FAIL | bun test output; /opfs wasmMerge |
| G0.3 30 clients × 10 min, p95 < 1 s, 0 errors | p95 = … ms, errors = … | load JSON |
| G0.4 Bun runtime | PASS/FAIL | Task 10 notes |
| G0.5 Cold bootstrap < 10 s | Node … ms, browser … ms | load JSON; /opfs |
| G0.6 Offline reload + soft navigation | PASS/FAIL | screenshots |
| G0.7 Backup while writing | VACUUM INTO / fallback, … ms | backup-check JSON |
| G0.8 Convergence (3 seeds) | PASS/FAIL | converge JSON |

Verdict: proceed to Phase 1 / switch to fallback (state which).
```

- [ ] **Step 2: Apply the "If G0 fails" rules from the spec**

- G0.1 fails only in a non-Chromium browser: list it as unsupported in ADR-001 Consequences.
- G0.1 fails in Chrome or Edge: stop and tell the human partner; Phase 1 does not start.
- G0.2, G0.3 or G0.7 fail on the server engine: change spec D2 and ADR-001 to `bun:sqlite`/`node:sqlite` on the server, keeping the same SQL and schema.
- G0.4 fails: ADR-004 records Node 24 as the runtime.

- [ ] **Step 3: Close ADR-004**

Change `## Status` to `Accepted (YYYY-MM-DD): production runtime is Bun` or `Node 24 LTS`, citing the Task 10 numbers.

- [ ] **Step 4: Commit**

```bash
git add docs/adr docs/superpowers/specs README.md spike/G0-NOTES.md
git commit -m "docs: record gate G0 results in ADR-001 and decide runtime in ADR-004"
```

- [ ] **Step 5: Report**

Tell the human partner the verdict, any fallback taken, and that Phase 1 (scaffold and schema in `web/`, promoting `hlc.ts`, `lww.ts`, `id-gen.ts`, `db/tables.ts` and `lib/sync/*` from the spike) is next.
