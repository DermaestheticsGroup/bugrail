// Same SQL as the sibling .sql files (the checked source), as strings so the browser can run it without fs.
// test/schema.test.ts proves each pair builds the same schema; edit both together.
export const CORE_SQL = `
-- Synced tables: no UNIQUE (besides the key), FOREIGN KEY, CHECK or NOT NULL, so a sync write never fails on a constraint.
CREATE TABLE IF NOT EXISTS files (
  id TEXT PRIMARY KEY, name TEXT, workspace_id TEXT, created_by TEXT, created_at TEXT,
  hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS file_shares (
  id TEXT PRIMARY KEY, file_id TEXT, workspace_id TEXT,
  hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS testcases (
  id TEXT PRIMARY KEY, code TEXT, file_id TEXT, module TEXT, role_user TEXT, scenario TEXT, test_case TEXT,
  preconditions TEXT, steps TEXT, test_data TEXT, expected_result TEXT, type_test TEXT, status TEXT,
  status_hlc TEXT, actual_result TEXT, evidence TEXT, execution_date TEXT, custom_fields TEXT,
  created_by TEXT, created_at TEXT, extra TEXT, hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
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
CREATE TABLE IF NOT EXISTS bug_status_master (
  id TEXT PRIMARY KEY, name TEXT, color TEXT, sort_order INTEGER,
  hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS custom_field_defs (
  id TEXT PRIMARY KEY, label TEXT, hlc TEXT, deleted_at TEXT, updated_by TEXT, server_seq INTEGER
);
CREATE TABLE IF NOT EXISTS activity_log (
  id TEXT PRIMARY KEY, ts TEXT, actor_email TEXT, actor_role TEXT, workspace_id TEXT,
  action TEXT, label TEXT, server_seq INTEGER
);
CREATE INDEX IF NOT EXISTS files_seq ON files(server_seq);
CREATE INDEX IF NOT EXISTS file_shares_seq ON file_shares(server_seq);
CREATE INDEX IF NOT EXISTS testcases_seq ON testcases(server_seq);
CREATE INDEX IF NOT EXISTS bugs_seq ON bugs(server_seq);
CREATE INDEX IF NOT EXISTS bug_events_seq ON bug_events(server_seq);
CREATE INDEX IF NOT EXISTS bug_status_master_seq ON bug_status_master(server_seq);
CREATE INDEX IF NOT EXISTS custom_field_defs_seq ON custom_field_defs(server_seq);
CREATE INDEX IF NOT EXISTS activity_log_seq ON activity_log(server_seq);
CREATE INDEX IF NOT EXISTS bugs_file ON bugs(file_id);
CREATE INDEX IF NOT EXISTS bug_events_bug ON bug_events(bug_id);
CREATE INDEX IF NOT EXISTS testcases_file ON testcases(file_id);
`;

export const SERVER_SQL = `
-- Server-only, never sent to a browser.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT, name TEXT, role TEXT, workspace_ids TEXT, password_hash TEXT,
  session_version INTEGER, access_version INTEGER, created_at TEXT, server_seq INTEGER
);
-- One account per email, case-insensitive; the app checks first but concurrent creates only meet here.
CREATE UNIQUE INDEX IF NOT EXISTS users_email ON users(lower(email));
CREATE TABLE IF NOT EXISTS secrets (key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS sync_meta (key TEXT PRIMARY KEY, value INTEGER);
INSERT INTO sync_meta (key, value) VALUES ('seq', 0) ON CONFLICT(key) DO NOTHING;
INSERT INTO sync_meta (key, value) VALUES ('schema_version', 0) ON CONFLICT(key) DO NOTHING;
`;

export const WORKSPACES_SQL = `
-- Server-only. Admin-managed; delivery to browsers arrives with the client shell.
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
-- Unique names, case-insensitive; the app checks first but concurrent writes only meet here.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_name ON workspaces(lower(name));
`;

export const LOCAL_SQL = `
-- Browser-only.
CREATE TABLE IF NOT EXISTS outbox (seq INTEGER PRIMARY KEY AUTOINCREMENT, tbl TEXT, row_id TEXT);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
`;

export const LOCAL_REJECTED_SQL = `
-- Browser-only. Pushes the server refused, kept for the UI instead of dropped.
CREATE TABLE IF NOT EXISTS rejected (row_id TEXT NOT NULL, tbl TEXT NOT NULL, reason TEXT, at TEXT, PRIMARY KEY (tbl, row_id));
`;

// [file number, file name, sql]; every script is IF NOT EXISTS so re-running is safe.
export type Migration = readonly [number, string, string];

export const MIGRATIONS: Record<'server' | 'local', Migration[]> = {
  server: [[1, '001_core.sql', CORE_SQL], [2, '002_server.sql', SERVER_SQL], [5, '005_workspaces.sql', WORKSPACES_SQL]],
  local: [[1, '001_core.sql', CORE_SQL], [3, '003_local.sql', LOCAL_SQL], [4, '004_local_rejected.sql', LOCAL_REJECTED_SQL]],
};

// One version for both scopes, so a client and server compare like with like.
export const SCHEMA_VERSION = Math.max(...[...MIGRATIONS.server, ...MIGRATIONS.local].map(([n]) => n));
