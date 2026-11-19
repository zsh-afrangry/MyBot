// Private diagnostic evidence only; never a business state store. Contract: docs/18.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {deflateSync, inflateSync} from 'node:zlib';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {normalizeTraceEvent, redactValue} from './index.js';

export const TRACE_LIMITS = Object.freeze({bodyBytes:4*1024*1024,storeBytes:256*1024*1024,eventCount:100000,retentionMs:30*86400000});
// Only registered readers can grant a body lookup; raw log JSON cannot forge this symbol.
export const EVIDENCE_STORE=Symbol('registered-evidence-store');
// Resolve companion assets through the host's module resolver so selective plugin
// capture admits them alongside this shared package before filesystem access.
const companionDirectory=path.dirname(fileURLToPath(import.meta.resolve('./trace_store.py')));
export const observabilityDirectory=()=>companionDirectory;
const schema=fs.readFileSync(fileURLToPath(import.meta.resolve('./execution-schema.sql')),'utf8');
export const traceId = (...parts) => createHash('sha256').update(JSON.stringify(parts)).digest('hex');
const safeCode=error=>/^[A-Z_]+$/.test(error?.code??'')?error.code:'trace_storage_error';
function regular(file) { const st=fs.lstatSync(file);if(!st.isFile()||st.isSymbolicLink())throw Error('Invalid trace file'); }

export function createExecutionStore(root, {source='trace-events',limits={},now=Date.now,onError}={}) {
  const budget={...TRACE_LIMITS,...limits};
  if(Object.values(budget).some(v=>!Number.isSafeInteger(v)||v<1))throw Error('Invalid trace limits');
  const file=path.join(path.resolve(root),'executions.sqlite');
  let db, warned=false;
  const failure=error=>{if(!warned){warned=true;try{(onError??(code=>console.warn('observability capture failed:',code)))(safeCode(error));}catch{}}return{status:'capture_failed',code:safeCode(error)};};
  const open=()=>{
    if(db)return db;
    fs.mkdirSync(root,{recursive:true,mode:0o700});
    if(fs.realpathSync(root)!==path.resolve(root))throw Error('Invalid trace directory');
    fs.chmodSync(root,0o700);
    if(fs.existsSync(file))regular(file);
    db=new DatabaseSync(file);db.exec('PRAGMA busy_timeout=250; PRAGMA journal_mode=WAL;');db.exec(schema);fs.chmodSync(file,0o600);
    return db;
  };
  const write=work=>{try{return work(open());}catch(error){return failure(error);}};
  return {
    file,
    detail(value) {if(value===undefined)return{status:'not_collected'};return write(conn=>{
      const bytes=Buffer.from(JSON.stringify(redactValue(value)));
      if(bytes.length>budget.bodyBytes)return{status:'too_large',bytes:bytes.length,limit:budget.bodyBytes};
      const at=now(),id=randomUUID(),sha256=createHash('sha256').update(bytes).digest('hex'),content=deflateSync(bytes);
      conn.exec('BEGIN IMMEDIATE');
      try{
        conn.prepare('DELETE FROM trace_details WHERE expires_ms <= ?').run(at);
        let size=Number(conn.prepare('SELECT COALESCE(SUM(length(content)),0) AS size FROM trace_details').get().size);
        if(content.length>budget.storeBytes){conn.exec('ROLLBACK');return{status:'capacity_exceeded'};}
        for(const row of conn.prepare('SELECT id,length(content) AS size FROM trace_details ORDER BY created_ms,id').all()){
          if(size+content.length<=budget.storeBytes)break;
          conn.prepare('DELETE FROM trace_details WHERE id=?').run(row.id);size-=Number(row.size);
        }
        conn.prepare('INSERT INTO trace_details VALUES (?,?,?,?,?,?)').run(id,at,at+budget.retentionMs,sha256,bytes.length,content);
        conn.exec('COMMIT');
      }catch(error){conn.exec('ROLLBACK');throw error;}
      return{status:'stored',id,sha256,bytes:bytes.length,expiresAt:new Date(at+budget.retentionMs).toISOString()};
    });},
    emit(input) {return write(conn=>{
      const at=now(),event=normalizeTraceEvent({at,source,...input,eventId:input.eventId??randomUUID()});
      if(!event.correlation.executionId||!event.correlation.spanId)throw Error('Trace identity required');
      conn.prepare('INSERT INTO trace_events VALUES (?,?,?,?,?)').run(event.eventId,event.correlation.executionId,event.correlation.spanId,event.epochMs,JSON.stringify(event));
      conn.prepare('DELETE FROM trace_events WHERE at_ms < ?').run(at-budget.retentionMs);
      conn.exec(`DELETE FROM trace_events WHERE rowid IN (SELECT rowid FROM trace_events ORDER BY at_ms DESC,event_id DESC LIMIT -1 OFFSET ${budget.eventCount})`);
      return event;
    });},
    close(){db?.close();db=undefined;},
  };
}

export function executionSpan(store, {executionId,spanId=traceId(randomUUID()),parentSpanId,business,correlation={},type,name}) {
  const identity={...correlation,executionId,spanId,...(parentSpanId?{parentSpanId}:{})};
  return {
    id:spanId,
    emit(status,data={}){return store.emit({kind:'execution.node',correlation:identity,data:{business,type,name,status,...data}});},
    detail(value){return store.detail(value);},
  };
}

export function readExecutionStore(file,{from=0,to=Date.now(),executionId,limit=100001}={}) {
  if(!fs.existsSync(file))return[];
  regular(file);const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('PRAGMA busy_timeout=250');
    const sql='SELECT record_json FROM trace_events WHERE at_ms BETWEEN ? AND ?'+(executionId?' AND execution_id=?':'')+' ORDER BY at_ms,rowid LIMIT ?';
    const rows=db.prepare(sql).all(from,to,...(executionId?[executionId]:[]),limit);
    if(rows.length===limit)throw Error('trace_read_limit');
    return rows.map(row=>JSON.parse(row.record_json));
  }finally{db.close();}
}

export function readExecutionDetail(file,reference,{now=Date.now()}={}) {
  if(reference?.status!=='stored')return reference??{status:'not_collected'};
  if(Date.parse(reference.expiresAt)<=now)return{...reference,status:'expired'};
  if(!fs.existsSync(file))return{...reference,status:'missing'};
  regular(file);const db=new DatabaseSync(file,{readOnly:true});
  try{
    db.exec('PRAGMA busy_timeout=250');
    const row=db.prepare('SELECT * FROM trace_details WHERE id=?').get(reference.id);
    if(!row)return{...reference,status:'evicted_or_missing'};
    if(row.expires_ms<=now)return{...reference,status:'expired'};
    const bytes=inflateSync(row.content,{maxOutputLength:TRACE_LIMITS.bodyBytes});
    if(createHash('sha256').update(bytes).digest('hex')!==reference.sha256)throw Error('Trace body integrity mismatch');
    return{...reference,content:JSON.parse(bytes.toString('utf8'))};
  }finally{db.close();}
}
