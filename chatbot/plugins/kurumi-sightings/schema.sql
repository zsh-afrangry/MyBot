CREATE TABLE IF NOT EXISTS sightings (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  url TEXT NOT NULL,
  title TEXT NOT NULL,
  excerpt TEXT NOT NULL,
  seen_at INTEGER NOT NULL,
  seen_date TEXT NOT NULL,
  withdrawn_at INTEGER,
  UNIQUE (url, seen_date)
);
CREATE INDEX IF NOT EXISTS sightings_by_date ON sightings(seen_date, seen_at DESC, id);
