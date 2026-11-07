// Document 29 private persistence: SQL, CAS rows and append-only raw bytes. No ingress or host reader.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {memoryPaths} from '../continuity/store.js';
import {NOTICE_V3,SCHEMA_V3} from './policy.js';
export {NOTICE_V3,SCHEMA_V3};
const fail=code=>Object.assign(Error(code),{code});
const stamp=()=>new Date().toISOString();
function rowRecord(row, sources) {
  return {id: row.id, version: row.version, kind: row.kind, about: row.about, basis: row.basis, text: row.text,
    state: row.state, valid_from: row.valid_from, recorded_at: row.recorded_at, external: Boolean(row.external), attrs: JSON.parse(row.attrs_json), sources};
}
export class RecordStore {
  constructor({workspace, ownerId, readonly = false, requireNotice = true}) {
    const paths = memoryPaths(workspace);
    if (requireNotice && fs.readFileSync(paths.notice, 'utf8') !== NOTICE_V3) throw fail('memory_v3_requires_explicit_migration');
    if (!fs.existsSync(paths.file) || fs.statSync(paths.file).mode & 0o077) throw fail('unsafe_memory_state');
    this.db = new DatabaseSync(paths.file, {readOnly: readonly}); this.workspace = workspace;
    try {
      this.db.exec('PRAGMA busy_timeout=2000'); if (!readonly) this.db.exec('PRAGMA synchronous=FULL');
      if (this.db.prepare('PRAGMA user_version').get().user_version !== 3) throw fail('memory_v3_schema_required');
      this.ownerId = this.aux().ownerId;
      if (!/^\d{5,12}$/.test(this.ownerId) || (ownerId && ownerId !== this.ownerId)) throw fail('memory_owner_mismatch');
    } catch (error) {this.db.close(); throw error;}
  }
  close() {this.db.close();}
  aux() {return JSON.parse(this.db.prepare('SELECT state_json FROM memory_aux WHERE singleton=1').get().state_json);}
  saveAux(value) {this.db.prepare('UPDATE memory_aux SET state_json=? WHERE singleton=1').run(JSON.stringify(value));}
  atomic(fn) {this.db.exec('BEGIN IMMEDIATE'); try {const result = fn(); this.db.exec('COMMIT'); return result;} catch (e) {this.db.exec('ROLLBACK'); throw e;}}
  bump() {const aux = this.aux(); aux.revision++; this.saveAux(aux);}
  raw(rawId) {const row = this.db.prepare('SELECT * FROM memory_raw WHERE id=?').get(rawId); return row ? {...row, body: JSON.parse(row.body_json)} : null;}
  rawRows() {return this.db.prepare('SELECT * FROM memory_raw ORDER BY seq').all();}
  appendRaw({rawId, sessionId, eventSeq = null, origin, body, at, runId = null, content}) {
    // Internal only: callers derive origin, never accept it in tool parameters.
    const rawText = content ?? '', json = JSON.stringify(body);
    const old = this.raw(rawId);
    if (old) {if (old.body_json !== json || old.origin !== origin || old.session_id !== sessionId || old.text !== rawText) throw fail('raw_identity_conflict'); return old.id;}
    this.db.prepare('INSERT INTO memory_raw(id,session_id,event_seq,origin,text,body_json,at,run_id) VALUES(?,?,?,?,?,?,?,?)')
      .run(rawId, sessionId, eventSeq, origin, rawText, json, at, runId); return rawId;
  }
  sources(recordId, version) {return this.db.prepare('SELECT raw_id,record_ref FROM memory_sources WHERE record_id=? AND version=? ORDER BY position').all(recordId, version).map(s => s.raw_id ? {rawId: s.raw_id} : {recordId: s.record_ref});}
  record(recordId) {const row = this.db.prepare('SELECT * FROM memory_records WHERE id=?').get(recordId); return row ? rowRecord(row, this.sources(recordId,row.version)) : null;}
  records() {return this.db.prepare('SELECT id FROM memory_records ORDER BY recorded_at,id').all().map(row => this.record(row.id));}
  saveRecord(record, {actor = 'memory', runId, p2} = {}) {
    if (!runId || !actor) throw fail('memory_actor_required');
    this.db.prepare(`INSERT INTO memory_records VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET
      version=excluded.version,kind=excluded.kind,about=excluded.about,basis=excluded.basis,text=excluded.text,state=excluded.state,
      valid_from=excluded.valid_from,recorded_at=excluded.recorded_at,external=excluded.external,attrs_json=excluded.attrs_json,p2_json=excluded.p2_json`)
      .run(record.id, record.version, record.kind, record.about, record.basis, record.text, record.state, record.valid_from, record.recorded_at, Number(record.external), JSON.stringify(record.attrs), p2 ? JSON.stringify(p2) : null);
    this.db.prepare('INSERT INTO memory_versions VALUES(?,?,?,?,?,?)').run(record.id,record.version,JSON.stringify(record),actor,runId,stamp());
    record.sources.forEach((s,i) => this.db.prepare('INSERT INTO memory_sources VALUES(?,?,?,?,?)').run(record.id,record.version,i,s.rawId ?? null,s.recordId ?? null));
    return record;
  }

}
