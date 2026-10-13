-- Browser-only. Pushes the server refused, kept for the UI instead of dropped.
CREATE TABLE IF NOT EXISTS rejected (row_id TEXT NOT NULL, tbl TEXT NOT NULL, reason TEXT, at TEXT, PRIMARY KEY (tbl, row_id));
