-- Document 25 P2, schema version 2. One bounded snapshot per isolated owner.
-- Facts, summaries, forgetting barriers and replay receipts commit together.
CREATE TABLE memory_state (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL CHECK (version = 2),
  owner_id TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 0),
  state_json TEXT NOT NULL CHECK (json_valid(state_json))
);
PRAGMA user_version = 2;
