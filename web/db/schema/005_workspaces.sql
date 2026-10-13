-- Server-only. Admin-managed; delivery to browsers arrives with the client shell.
CREATE TABLE IF NOT EXISTS workspaces (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
-- Unique names, case-insensitive; the app checks first but concurrent writes only meet here.
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_name ON workspaces(lower(name));
