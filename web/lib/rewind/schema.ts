// Shared by the browser's local Turso DB and the server migration. Rows store the
// prototype's objects as JSON so the UI state maps 1:1 onto synced rows.
export const SCHEMA = [
  "CREATE TABLE IF NOT EXISTS jams (id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS comments (id TEXT PRIMARY KEY, data TEXT NOT NULL, position INTEGER NOT NULL, updated_at INTEGER NOT NULL)",
  "CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL)",
];
