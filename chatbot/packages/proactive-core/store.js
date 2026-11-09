// Private execution control, not conversation/memory storage. No production path default.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {error,time} from './policy.js';

export class WakeStore {
  constructor(file) {
    if (!path.isAbsolute(file)) throw error('invalid_wake_store');
    fs.mkdirSync(path.dirname(file),{recursive:true,mode:0o700});
    if (fs.lstatSync(file,{throwIfNoEntry:false})?.isSymbolicLink()) throw error('invalid_wake_store');
    this.db = new DatabaseSync(file);fs.chmodSync(file,0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wake_control (
        scope TEXT PRIMARY KEY, epoch INTEGER NOT NULL DEFAULT 0,
        paused INTEGER NOT NULL DEFAULT 0, last_activity INTEGER);
      CREATE TABLE IF NOT EXISTS wake_run (
        run_id TEXT PRIMARY KEY, scope TEXT NOT NULL, event_key TEXT NOT NULL,
        epoch INTEGER NOT NULL, created INTEGER NOT NULL, expires INTEGER NOT NULL,
        status TEXT NOT NULL, binding TEXT NOT NULL, text_hash TEXT, receipt TEXT, reason TEXT,
        UNIQUE(scope,event_key));
      CREATE INDEX IF NOT EXISTS wake_active ON wake_run(scope,status,expires);
      CREATE TABLE IF NOT EXISTS wake_message (
        message_key TEXT PRIMARY KEY, run_id TEXT NOT NULL, call_id TEXT NOT NULL,
        text_hash TEXT NOT NULL, created INTEGER NOT NULL, status TEXT NOT NULL, receipt TEXT,
        UNIQUE(run_id,call_id));`);
  }
  close() {this.db.close();}
  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try {const value=fn();this.db.exec('COMMIT');return value;}
    catch (e) {this.db.exec('ROLLBACK');throw e;}
  }
  control(scope) {
    this.db.prepare('INSERT OR IGNORE INTO wake_control(scope) VALUES(?)').run(scope);
    return this.db.prepare('SELECT * FROM wake_control WHERE scope=?').get(scope);
  }
  get(id) {
    const row=this.db.prepare('SELECT * FROM wake_run WHERE run_id=?').get(id);
    return row && {...row,binding:JSON.parse(row.binding),receipt:row.receipt?JSON.parse(row.receipt):null};
  }
  recover(now) {
    time(now);
    this.db.prepare(`UPDATE wake_message SET status='unknown' WHERE status='sending'
      AND run_id IN (SELECT run_id FROM wake_run WHERE expires<=?)`).run(now);
    // Only expired leases: a second connection cannot cancel a live process.
    return this.db.prepare(`UPDATE wake_run SET status=CASE WHEN status='sending' THEN 'unknown' ELSE 'interrupted' END,
      reason='lease_expired' WHERE status IN ('running','sending') AND expires<=?`).run(now).changes;
  }
  claim({runId,eventKey,binding,now,expires}) {
    time(now);time(expires);
    if (expires<=now || typeof eventKey!=='string' || !eventKey || eventKey.length>180) throw error('invalid_wake_event');
    return this.transaction(() => {
      const scope=binding.subjectKey, control=this.control(scope);this.recover(now);
      if (control.paused) return {skip:'paused'};
      if (this.db.prepare('SELECT 1 FROM wake_run WHERE scope=? AND event_key=?').get(scope,eventKey)) return {skip:'duplicate'};
      if (this.db.prepare("SELECT 1 FROM wake_run WHERE scope=? AND status IN ('running','sending')").get(scope)) return {skip:'busy'};
      this.db.prepare('INSERT INTO wake_run(run_id,scope,event_key,epoch,created,expires,status,binding) VALUES(?,?,?,?,?,?,?,?)')
        .run(runId,scope,eventKey,control.epoch,now,expires,'running',JSON.stringify(binding));
      return {run:this.get(runId)};
    });
  }
  assertLive(id,now,statuses=['running']) {
    time(now);
    const run=this.get(id);
    if (!run || !statuses.includes(run.status) || now<run.created || now>=run.expires) throw error('wake_not_current');
    const control=this.control(run.scope);
    if (control.paused || control.epoch!==run.epoch) throw error('wake_not_current');
    return run;
  }
  invalidate(scope,{paused,activityAt}={}) {
    if (paused!==undefined && typeof paused!=='boolean') throw error('invalid_pause');
    if (activityAt!==undefined) time(activityAt);
    return this.transaction(() => {
      const current=this.control(scope);
      if (activityAt!==undefined && current.last_activity!==null && activityAt<current.last_activity) throw error('activity_clock_reversed');
      this.db.prepare('UPDATE wake_control SET epoch=epoch+1,paused=?,last_activity=? WHERE scope=?')
        .run(paused===undefined?current.paused:Number(paused),activityAt??current.last_activity,scope);
      this.db.prepare("UPDATE wake_run SET status='cancelled',reason='scope_invalidated' WHERE scope=? AND status='running'").run(scope);
      return this.control(scope);
    });
  }
  beginSend(id,now,textHash) {
    return this.transaction(() => {
      this.assertLive(id,now);
      this.db.prepare("UPDATE wake_run SET status='sending',text_hash=? WHERE run_id=?").run(textHash,id);
    });
  }
  finish(id,status,reason=null) {
    if (!['silent','completed','failed','cancelled'].includes(status)) throw error('invalid_wake_result');
    this.db.prepare("UPDATE wake_run SET status=?,reason=? WHERE run_id=? AND status='running'").run(status,reason,id);
    return this.get(id);
  }
  receipt(id,value) {
    const confirmed=value?.status==='sent' && typeof value.messageId==='string' && value.messageId.length>0 && value.messageId.length<=160;
    const receipt=confirmed?{status:'sent',messageId:value.messageId}:{status:'unknown'};
    // Actual receipts are facts even if the user paused while HTTP was in flight.
    this.db.prepare("UPDATE wake_run SET status=?,receipt=? WHERE run_id=? AND status IN ('sending','unknown')")
      .run(confirmed?'delivered':'unknown',JSON.stringify(receipt),id);
    return this.get(id);
  }
  beginMessage(id,callId,textHash,now) {
    if (typeof callId!=='string'||!callId||callId.length>180) throw error('invalid_wake_call');
    return this.transaction(()=>{
      this.assertLive(id,now);
      const prior=this.db.prepare('SELECT * FROM wake_message WHERE run_id=? AND call_id=?').get(id,callId);
      if (prior) {
        if (prior.text_hash!==textHash) throw error('wake_call_reused');
        return {...prior,duplicate:true};
      }
      const key='proactive:'+id+':'+callId;
      this.db.prepare('INSERT INTO wake_message VALUES(?,?,?,?,?,?,NULL)').run(key,id,callId,textHash,now,'sending');
      return this.db.prepare('SELECT * FROM wake_message WHERE message_key=?').get(key);
    });
  }
  messageReceipt(key,value) {
    const sent=value?.status==='sent'&&typeof value.messageId==='string'&&value.messageId.length>0&&value.messageId.length<=160;
    this.db.prepare("UPDATE wake_message SET status=?,receipt=? WHERE message_key=? AND status IN ('sending','unknown')")
      .run(sent?'delivered':'unknown',JSON.stringify(sent?{status:'sent',messageId:value.messageId}:{status:'unknown'}),key);
    return this.db.prepare('SELECT * FROM wake_message WHERE message_key=?').get(key);
  }
  messages(id) {
    return this.db.prepare('SELECT message_key,status,receipt FROM wake_message WHERE run_id=? ORDER BY created,rowid').all(id)
      .map(row=>({...row,receipt:row.receipt?JSON.parse(row.receipt):null}));
  }
}
