CREATE TABLE IF NOT EXISTS trace_events (
  event_id TEXT PRIMARY KEY, execution_id TEXT NOT NULL, span_id TEXT NOT NULL,
  at_ms INTEGER NOT NULL, record_json TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS trace_execution ON trace_events(execution_id, at_ms);
CREATE INDEX IF NOT EXISTS trace_time ON trace_events(at_ms);
CREATE TABLE IF NOT EXISTS trace_details (
  id TEXT PRIMARY KEY, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
  sha256 TEXT NOT NULL, size INTEGER NOT NULL, content BLOB NOT NULL
);
CREATE INDEX IF NOT EXISTS trace_expiry ON trace_details(expires_ms);
CREATE TABLE IF NOT EXISTS trace_cache_origins (
  cache_key TEXT PRIMARY KEY, execution_id TEXT NOT NULL, span_id TEXT,
  created_ms INTEGER NOT NULL
);
