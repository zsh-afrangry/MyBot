-- Document 29. Versioned impressions, immutable raw mirror and rebuildable masked indexes.
CREATE TABLE memory_aux(singleton INTEGER PRIMARY KEY CHECK(singleton=1), state_json TEXT NOT NULL CHECK(json_valid(state_json)));
CREATE TABLE memory_records(id TEXT PRIMARY KEY, version INTEGER NOT NULL, kind TEXT NOT NULL, about TEXT NOT NULL,
 basis TEXT NOT NULL, text TEXT NOT NULL, state TEXT NOT NULL, valid_from TEXT NOT NULL, recorded_at TEXT NOT NULL,
 external INTEGER NOT NULL, attrs_json TEXT NOT NULL, p2_json TEXT);
CREATE UNIQUE INDEX memory_portrait_active ON memory_records(about) WHERE kind='portrait' AND state='active';
CREATE TABLE memory_versions(id TEXT NOT NULL,version INTEGER NOT NULL,body_json TEXT NOT NULL,actor TEXT NOT NULL,
 run_id TEXT NOT NULL,at TEXT NOT NULL,PRIMARY KEY(id,version));
CREATE TABLE memory_sources(record_id TEXT NOT NULL,version INTEGER NOT NULL,position INTEGER NOT NULL,raw_id TEXT,record_ref TEXT,
 PRIMARY KEY(record_id,version,position),CHECK((raw_id IS NULL)!=(record_ref IS NULL)));
CREATE TABLE memory_raw(seq INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT UNIQUE NOT NULL,session_id TEXT NOT NULL,
 event_seq INTEGER,origin TEXT NOT NULL,text TEXT NOT NULL,body_json TEXT NOT NULL,at TEXT NOT NULL,run_id TEXT);
CREATE TRIGGER memory_raw_no_update BEFORE UPDATE ON memory_raw BEGIN SELECT RAISE(ABORT,'Raw memory is append only'); END;
CREATE TRIGGER memory_raw_no_delete BEFORE DELETE ON memory_raw BEGIN SELECT RAISE(ABORT,'Raw memory is append only'); END;
CREATE TABLE memory_masks(id TEXT PRIMARY KEY,raw_id TEXT,text_hash TEXT,needle TEXT,group_hash TEXT NOT NULL);
CREATE TABLE memory_cursors(name TEXT PRIMARY KEY,after_seq INTEGER NOT NULL,version INTEGER NOT NULL);
CREATE TABLE memory_batches(id TEXT PRIMARY KEY,cursor_name TEXT NOT NULL,cursor_version INTEGER NOT NULL,after_seq INTEGER NOT NULL,
 through_seq INTEGER NOT NULL,raw_ids_json TEXT NOT NULL,run_id TEXT NOT NULL,generation INTEGER NOT NULL,state TEXT NOT NULL);
CREATE VIRTUAL TABLE memory_record_fts USING fts5(id UNINDEXED,text,tokenize='trigram');
CREATE VIRTUAL TABLE memory_raw_fts USING fts5(id UNINDEXED,text,tokenize='trigram');
PRAGMA user_version=3;
