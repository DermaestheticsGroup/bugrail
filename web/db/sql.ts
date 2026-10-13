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
