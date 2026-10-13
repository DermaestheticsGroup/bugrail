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
