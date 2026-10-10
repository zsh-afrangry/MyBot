-- Reminder-list schema v1. Kept in Git; runtime applies it in one transaction.
-- Epoch values are UTC milliseconds. No credentials or conversation copies.
CREATE TABLE items (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  content TEXT,
  note TEXT,
  ddl TEXT,
  deadline_ms INTEGER,
  status TEXT NOT NULL CHECK(status IN ('active','completed','void','expired')),
  version INTEGER NOT NULL DEFAULT 1,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL,
  CHECK((ddl IS NULL) = (deadline_ms IS NULL))
);
CREATE INDEX items_active_deadline ON items(status,deadline_ms,created_ms);
CREATE TABLE settings (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  owner_id TEXT NOT NULL,
  times_json TEXT NOT NULL,
  enabled INTEGER NOT NULL CHECK(enabled IN (0,1)),
  version INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);
-- One mutation per trusted incoming message. Repeating identical parameters is
-- idempotent, while a retry with changed parameters requires a new user turn.
CREATE TABLE requests (
  message_key TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  result_json TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);
CREATE TABLE audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at_ms INTEGER NOT NULL,
  action TEXT NOT NULL,
  item_id TEXT,
  qq_message_id TEXT,
  session_key TEXT,
  run_id TEXT,
  details_json TEXT NOT NULL
);
CREATE TABLE deliveries (
  slot_key TEXT PRIMARY KEY,
  slot_ms INTEGER NOT NULL,
  settings_version INTEGER NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('prepared','delivered','failed','unknown','skipped')),
  item_ids_json TEXT NOT NULL,
  text TEXT NOT NULL,
  updated_ms INTEGER NOT NULL,
  cron_job_id TEXT
);
PRAGMA user_version=1;
