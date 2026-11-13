-- Same schema the Val Town version created via std/sqlite.
CREATE TABLE IF NOT EXISTS seen_checkins (
  fsq_id         TEXT PRIMARY KEY,
  fsq_created_at INTEGER NOT NULL,
  pds_at_uri     TEXT NOT NULL,
  pds_cid        TEXT NOT NULL,
  processed_at   INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX IF NOT EXISTS idx_seen_created ON seen_checkins(fsq_created_at);

CREATE TABLE IF NOT EXISTS sync_state (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
