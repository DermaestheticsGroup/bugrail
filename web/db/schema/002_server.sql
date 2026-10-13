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
