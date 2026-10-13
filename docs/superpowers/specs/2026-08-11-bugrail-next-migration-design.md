> **Superseded** (2026-10-13) by [`2026-10-13-bugrail-local-first-design.md`](2026-10-13-bugrail-local-first-design.md). Never built. Kept for history.

# BugRail Next Migration — Phase 1 (Test Case + Bug Report)

## Background

BugRail-QA-App (`qa-app/`) is currently a client-side-only vanilla JS/HTML app: all
data (test cases, bugs, files/folders, settings, users) lives in `localStorage`,
with no real server or database despite the UI claiming "disimpan di MySQL server".

This spec covers **Phase 1** of migrating to a real stack:
- Backend: Express.js + Prisma + PostgreSQL
- Frontend: Next.js (App Router) + Tailwind CSS

Phase 1 scope is **Auth + Test Case + Bug Report** only (the two modules that are
tightly coupled via `testCaseId` and shared file/folder grouping). Dashboard,
Summary/PDF export, Settings, Master Status CRUD, User Management, and
Import/Export are deferred to later phases — `qa-app/` keeps running unchanged
in the meantime.

The immediate trigger for this migration was a request to add a test-case table
grouped by Module (ID, Module, Role User, Scenario, Test Case, Type Test, Status,
Tgl Eksekusi) — this lands as `/testcase/summary` in the new frontend (section 4).

## 1. Architecture

```
BugRail-QA-App/
├── qa-app/              (existing app, untouched)
└── BugRail-Next/
    ├── backend/         Express + Prisma + PostgreSQL, REST API, port 4000
    └── frontend/        Next.js (App Router) + Tailwind, port 3000
```

- Two independent processes in local dev (`npm run dev` in each folder).
- Frontend never talks to Postgres directly — always through the backend REST API.
- Auth: Express sets a JWT in an httpOnly cookie on login. Next.js middleware reads
  that cookie to gate protected routes; every fetch to the backend sends it via
  `credentials: 'include'`. Passwords are bcrypt-hashed (replacing the old
  plaintext `DEFAULT_USERS` in `auth.js`).
- Fresh Postgres database — no migration of existing localStorage data (user chose
  to start clean; old data stays inspectable in `qa-app/` if ever needed).

## 2. Database Schema (Prisma)

```prisma
model User {
  id        String   @id @default(cuid())
  email     String   @unique
  password  String   // bcrypt hash
  role      Role     @default(USER)
  createdAt DateTime @default(now())
  bugs      Bug[]    @relation("BugTester")
}

enum Role {
  ADMIN
  USER
}

model FileGroup {          // "file" folder, shared by Test Case & Bug Report
  id        String     @id @default(cuid())
  name      String
  createdAt DateTime   @default(now())
  testCases TestCase[]
  bugs      Bug[]
}

model TestCase {
  id             String     @id            // old format: 3-letter Module prefix + counter, e.g. LOG-001
  fileId         String
  file           FileGroup  @relation(fields: [fileId], references: [id])
  module         String
  roleUser       String?
  scenario       String
  testCase       String
  preconditions  String?
  steps          String?
  testData       String?
  typeTest       TypeTest   @default(POSITIVE)
  expectedResult String?
  actualResult   String?
  status         TcStatus   @default(OPEN)
  executionDate  DateTime?
  createdAt      DateTime   @default(now())
  bugs           Bug[]
}

enum TypeTest { POSITIVE NEGATIVE }
enum TcStatus { OPEN PASSED FAILED BLOCKED RETEST }

model BugStatus {          // seeded with 6 rows; no CRUD endpoint/UI in phase 1
  code  String @id         // OPEN, IN_PROGRESS, RETEST, RESOLVED, CLOSED, REJECTED
  name  String @unique
  color String
  order Int
  bugs  Bug[]
}

model Bug {
  id             String     @id            // old format: BUG-001
  fileId         String
  file           FileGroup  @relation(fields: [fileId], references: [id])
  testCaseId     String?
  testCase       TestCase?  @relation(fields: [testCaseId], references: [id])
  module         String?
  scenario       String?
  expectedResult String?
  steps          String?
  title          String
  description    String?
  actualResult   String
  severity       Severity   @default(MEDIUM)
  priority       Priority   @default(MEDIUM)
  statusCode     String
  status         BugStatus  @relation(fields: [statusCode], references: [code])
  testerId       String
  tester         User       @relation("BugTester", fields: [testerId], references: [id])
  environment    String?
  browser        String?
  os             String?
  device         String?
  buildVersion   String?
  attachments    String?
  reportDate     DateTime   @default(now())
}

enum Severity { CRITICAL HIGH MEDIUM LOW }
enum Priority { HIGHEST HIGH MEDIUM LOW }

model IdCounter {          // backs per-module TestCase IDs and the BUG- counter
  key   String @id         // e.g. "TC:LOG", "BUG"
  value Int    @default(0)
}
```

Key differences from the old app:
- `Bug.tester` is now a real relation to `User` (`testerId`), not a free-text
  string — this is what the original "tester diambil dari user login" request
  required, now enforced at the DB level too.
- IDs keep the old human-readable format (`LOG-001`, `BUG-001`) instead of
  switching to auto-increment/UUID, generated via `IdCounter` inside a DB
  transaction to avoid collisions under concurrent requests.

## 3. API Endpoints (`/api` prefix, Express)

All routes except `/api/auth/login` require a valid JWT cookie (auth middleware).
Errors are consistently `{ error: "message" }` with an appropriate status code.

**Auth**
```
POST   /api/auth/login     { email, password } -> sets JWT cookie, returns { id, email, role }
POST   /api/auth/logout    clears cookie
GET    /api/auth/me        current user from cookie, or null
```

**Files**
```
GET    /api/files                  list all
POST   /api/files                  { name }
PATCH  /api/files/:id              { name } — rename
DELETE /api/files/:id              admin only; cascades test cases + bugs inside it
```

**Test Case**
```
GET    /api/testcases?fileId=&module=&typeTest=&status=&search=
POST   /api/testcases              create (fileId required)
GET    /api/testcases/:id
PATCH  /api/testcases/:id
DELETE /api/testcases/:id
POST   /api/testcases/:id/duplicate
GET    /api/testcases/by-module    rows grouped by module for the summary table
                                    (ID, Module, Role User, Scenario, Test Case,
                                    Type Test, Status, Execution Date); same query
                                    params as the list endpoint, server sorts by
                                    module then id
```

**Bug Report**
```
GET    /api/bugs?fileId=&module=&severity=&priority=&status=&testerId=&search=
POST   /api/bugs                   create (fileId required; testerId is forced
                                    server-side to the current user, any testerId
                                    in the request body is ignored)
GET    /api/bugs/:id
PATCH  /api/bugs/:id
DELETE /api/bugs/:id
```

**Bug Status**
```
GET    /api/bug-statuses           ordered list, for status dropdown/badge colors
                                    (read-only in phase 1)
```

## 4. Frontend Pages (Next.js App Router + Tailwind)

```
/login                     email+password form; redirects to /testcase if already logged in

/testcase                  file grid (card per file, test case count) — landing page
/testcase/[fileId]         table of test cases in that file: search, filter by
                            Module/TypeTest/Status; add/edit/duplicate/delete;
                            "Create Bug" button when status = Failed
/testcase/summary          table grouped by Module — ID, Module, Role User,
                            Scenario, Test Case, Type Test, Status, Tgl Eksekusi;
                            collapsible per-module sections — this is the feature
                            that triggered this migration

/bugreport                 file grid (card per file, bug count) — landing page
/bugreport/[fileId]        table of bugs in that file: search, filter by
                            Severity/Priority/Status/Tester; add/edit/delete;
                            Tester field is read-only, always the logged-in user
```

Layout: left sidebar (Test Case, Bug Report — Dashboard/Summary/Settings etc.
follow in later phases), topbar shows logged-in user's email+role and a logout
button. Next.js middleware checks the JWT cookie and redirects to `/login` when
absent.

Styling: plain Tailwind utility classes, no component library (shadcn etc.) in
phase 1 — can be layered in later if needed.

## Out of Scope (Phase 1)

- Dashboard, Summary charts/PDF export, Settings (theme, custom fields), Master
  Status Bug Report CRUD UI, User Management UI, Import/Export (Excel/CSV).
- Migrating existing `qa-app/` localStorage data into Postgres.
- Deployment/hosting — this phase targets local dev only.
