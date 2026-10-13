-- Browser-only. Pushes the server refused, kept for the UI instead of dropped.
CREATE TABLE IF NOT EXISTS rejected (row_id TEXT PRIMARY KEY, tbl TEXT, reason TEXT, at TEXT);
