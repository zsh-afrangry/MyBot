// Read-only diagnostics, snapshots and presentation. No domain constructors,
// gateways, external APIs or writes; incomplete/missing sources stay explicit.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {normalizeTraceEvent,correlationFrom,redactText} from '../../chatbot/packages/observability/index.js';
import {allowedMembers,sessionFor} from '../../chatbot/packages/access-control/index.js';
import {pairCalls,collectErrors,localTime,groupTurns} from './log-query-views.mjs';
const readJson = file => JSON.parse(fs.readFileSync(file,'utf8'));
const exists = file => fs.existsSync(file);
function database(file,work) {
 if(!exists(file))return {available:false,reason:'source_missing'};
 const db=new DatabaseSync(file,{readOnly:true});
 try{db.exec('PRAGMA busy_timeout=2000; BEGIN');const result=work(db);db.exec('COMMIT');return result;}finally{db.close();}
}
const table=(db,name)=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const config=root=>{try{return readJson(path.join(root,'openclaw.json'));}catch(e){if(e.code==='ENOENT')return{};throw e;}};
export function stateSnapshot(root,kind,{expand=false,now=Date.now()}={}) {
 if(!['memory','reminders','reminder-list','documents','cron'].includes(kind))throw Error('Unknown snapshot kind');
 const cfg=config(root),file=path.join(root,'state','openclaw.sqlite');let data;
 if(kind==='memory'){
  const workspace=cfg.agents?.entries?.main?.workspace??path.join(root,'workspace');
  data=database(path.join(workspace,'.kurumi-memory','state.sqlite'),db=>{
   const version=db.prepare('PRAGMA user_version').get().user_version;
   if(version===2){const row=db.prepare('SELECT revision,state_json FROM memory_state WHERE singleton=1').get();const state=JSON.parse(row.state_json);
    return {available:true,version,revision:row.revision,count:state.facts.length,items:state.facts.map(r=>({id:r.id,...(expand?{text:r.text}:{})})),summaries:state.summaries.length};}
   if(version===3){const aux=JSON.parse(db.prepare('SELECT state_json FROM memory_aux WHERE singleton=1').get().state_json);
    const items=db.prepare('SELECT id,version,kind,state'+(expand?',text':'')+' FROM memory_records ORDER BY id').all();return{available:true,version,revision:aux.revision,generation:aux.generation,count:items.length,items};}
   throw Error('Unsupported memory snapshot schema');
  });
 } else if(kind==='reminders')data=database(path.join(root,'state','personal-reminders','reminders.sqlite'),db=>({available:true,items:db.prepare('SELECT reminder_id AS id,status,scheduled_at_utc AS scheduledAtUtc,failure_code AS failureCode'+(expand?',content':'')+' FROM reminders ORDER BY scheduled_at_utc,reminder_id').all()}));
 else if(kind==='reminder-list')data=database(path.join(root,'state','personal-reminder-list','list.sqlite'),db=>{
  const row=db.prepare('SELECT enabled,version,times_json FROM settings WHERE singleton=1').get();
  const marker=path.join(root,'state','personal-reminder-list','data-source.json');
  const remote=exists(marker);return{available:true,storage:remote?'remote':'sqlite',settings:row?{enabled:!!row.enabled,version:row.version,times:JSON.parse(row.times_json)}:null,
   items:remote?[]:db.prepare('SELECT id,status,version'+(expand?',title,content,note,ddl':'')+' FROM items ORDER BY id').all(),...(remote?{reason:'remote_items_not_read_offline'}:{})};
 });
 else if(kind==='documents'){
  const dir=path.join(cfg.plugins?.entries?.['kurumi-papers']?.config?.root??path.join(root,'documents'),'records');
  const items=[];if(exists(dir))for(const name of fs.readdirSync(dir).filter(n=>/^(doc|pdf)_[a-f0-9]{32}\.json$/.test(n)).sort()){
   const r=readJson(path.join(dir,name));items.push({id:r.id,kind:r.kind,nameVersion:r.nameVersion??0,bytes:r.bytes,...(expand?{filename:r.filename,title:r.title}:{})});
  }data={available:exists(dir),count:items.length,items,metadataOnly:true};
 }else data=database(file,db=>{
  if(!table(db,'cron_jobs'))return {available:false,reason:'table_missing'};
  return{available:true,items:db.prepare('SELECT job_id AS id,enabled,payload_kind AS payloadKind,state_json FROM cron_jobs ORDER BY job_id').all().map(row=>{
   const state=JSON.parse(row.state_json??'{}');return{id:row.id,enabled:!!row.enabled,payloadKind:row.payloadKind,nextRunAtMs:state.nextRunAtMs,lastRunAtMs:state.lastRunAtMs,lastStatus:state.lastStatus};
  })};
 });
 return {schemaVersion:1,view:'snapshot',kind,snapshotAt:new Date(now).toISOString(),snapshotOfCurrentState:true,...data,...(Array.isArray(data.items)?{count:data.items.length}:{})};
}
export function readCronRuns(root,from,to){
 const result=database(path.join(root,'state','openclaw.sqlite'),db=>{
  if(!table(db,'cron_run_receipts'))return[];
  return db.prepare('SELECT receipt_id,job_id,request_run_id,status,started_at_ms,finished_at_ms,delivery_attempt_state FROM cron_run_receipts WHERE started_at_ms BETWEEN ? AND ? OR finished_at_ms BETWEEN ? AND ? ORDER BY started_at_ms,receipt_id').all(from,to,from,to).map(r=>normalizeTraceEvent({
   at:r.finished_at_ms??r.started_at_ms,source:'cron-runs',kind:'cron.run_state',correlation:correlationFrom({cronJobId:r.job_id,runId:r.request_run_id}),
   data:{receiptId:r.receipt_id,status:r.status,startedAtMs:r.started_at_ms,finishedAtMs:r.finished_at_ms,durationMs:r.finished_at_ms==null?null:r.finished_at_ms-r.started_at_ms,exitCode:null,exitCodeAvailable:false,deliveryState:r.delivery_attempt_state,snapshotOfCurrentState:true}
  }));
 });return Array.isArray(result)?result:[];
}
export function knownWarning(item){
 // Only the exact diagnosed optional remote catalog refresh notice is collapsed.
 // outbound/session warnings can indicate lost policy; never hide by subsystem.
 const message=item.data?.message;
 return item.source==='openclaw-runtime'&&message==='remote model catalog refresh failed; next check in 6 hours, or run openclaw models refresh'
  ?{...item,data:{...item.data,known:true,knownCode:'optional_remote_catalog_refresh'}}:item;
}
export function selectRecentTurns(events,count){
 if(!Number.isSafeInteger(count)||count<1||count>5000)throw Error('last-turns must be 1..5000');
 const anchors=events.filter(e=>e.kind==='agent.inbound').sort((a,b)=>a.epochMs-b.epochMs),selected=anchors.slice(-count),chosen=new Set(selected),bySession=new Map();
 for(const a of anchors){const key=a.correlation.sessionKey??a.correlation.sessionId;if(!bySession.has(key))bySession.set(key,[]);bySession.get(key).push(a);}
 return events.filter(e=>{
  const key=e.correlation.sessionKey??e.correlation.sessionId,list=bySession.get(key);if(!key||!list)return false;
  let low=0,high=list.length;while(low<high){const mid=(low+high)>>>1;if(list[mid].epochMs<=e.epochMs)low=mid+1;else high=mid;}
  return chosen.has(list[low-1]);
 });
}
export function queryStatistics(events){
 const sourceMap=new Map(),errorEvents=new Set(collectErrors(events).items.map(e=>JSON.stringify([e.at,e.source,e.kind,e.correlation])));
 for(const e of events){const r=sourceMap.get(e.source)??{source:e.source,count:0,failures:0};r.count++;if(errorEvents.has(JSON.stringify([e.at,e.source,e.kind,e.correlation])))r.failures++;sourceMap.set(e.source,r);}
 const sourceByCall=new Map(events.filter(e=>e.correlation.toolCallId).map(e=>[e.correlation.toolCallId,e.source]));
 const toolMap=new Map();for(const c of pairCalls(events)){
  const tool=c.actualTool??c.tool??c.declaredTool??'unknown',r=toolMap.get(tool)??{tool,count:0,failures:0,measured:0,durationMs:0};r.count++;if(['error','deny'].includes(c.outcome)||c.businessOutcome==='error'){r.failures++;const source=sourceMap.get(sourceByCall.get(c.toolCallId));if(source)source.failures++;}
  if(Number.isFinite(c.durationMs)&&c.durationMs>=0){r.measured++;r.durationMs+=c.durationMs;}toolMap.set(tool,r);
 }
 const turns=groupTurns(events).turns;
 const modelTurns=turns.map((turn,index)=>{
  const next=turns.slice(index+1).find(t=>t.session===turn.session),members=events.filter(e=>(e.correlation.sessionKey??e.correlation.sessionId)===turn.session&&e.epochMs>=turn.epochMs&&(!next||e.epochMs<next.epochMs)),samples=members.filter(e=>e.kind==='agent.model_usage'),usage={};
  for(const e of samples)for(const[k,v]of Object.entries(e.data.usage??{}))if(Number.isFinite(v)&&v>=0)usage[k]=(usage[k]??0)+v;
  const unique=new Map(samples.map(e=>[JSON.stringify([e.data.provider,e.data.model]),{provider:e.data.provider,model:e.data.model}]));
  return{at:turn.at,sessionKey:turn.session,runId:turn.runId,models:[...unique.values()],usage,usageAvailable:samples.some(e=>e.data.usageAvailable),compacted:members.some(e=>e.kind==='session.compaction'),fallbackKnown:false};
 });
 const rates=rows=>rows.map(r=>({...r,failureRate:r.failures/r.count,...(r.measured?{averageDurationMs:r.durationMs/r.measured}:{})}));
 return {view:'stats',total:events.length,sources:rates([...sourceMap.values()]),tools:rates([...toolMap.values()]),modelTurns,models:events.filter(e=>e.kind==='agent.model_usage').map(e=>({at:e.at,correlation:e.correlation,...e.data}))};
}
const columns={time:e=>localTime(e.epochMs),source:e=>e.source,kind:e=>e.kind,tool:e=>e.data?.tool??'',outcome:e=>e.data?.businessOutcome??e.data?.status??e.data?.decision??'',durationMs:e=>e.data?.durationMs??'',runId:e=>e.correlation.runId??'',messageId:e=>e.correlation.qqMessageId??''};
export function tabularEvents(events,{fields='time,source,kind,tool,outcome',format='table'}={}){
 const names=fields.split(',');if(!names.length||new Set(names).size!==names.length||names.some(n=>!Object.hasOwn(columns,n)))throw Error('Invalid table fields');
 const escape=value=>String(value).replace(/[\x00-\x1f\x7f]/g,' ').replaceAll('|','\\|');
 const rows=events.map(e=>names.map(n=>escape(columns[n](e))));
 return format==='markdown'?['| '+names.join(' | ')+' |','| '+names.map(()=>'---').join(' | ')+' |',...rows.map(r=>'| '+r.join(' | ')+' |')]:[names.join('\t'),...rows.map(r=>r.join('\t'))];
}
export function eventFingerprint(value){return createHash('sha256').update(JSON.stringify({...value,sourceRef:undefined})).digest('hex');}
export async function followQueries({read,emit,from,to=Date.now,intervalMs=1000,signal}){
 if(!Number.isInteger(intervalMs)||intervalMs<100||intervalMs>60000)throw Error('Invalid follow interval');
 let cursor=from,seen=new Map();
 while(!signal?.aborted){
  const end=to(),events=await read(cursor,end),fresh=[];
  for(const e of events){const key=eventFingerprint(e);if(!seen.has(key)){fresh.push(e);seen.set(key,e.epochMs);} }
  if(fresh.length)await emit(fresh,cursor,end);
  cursor=Math.max(from,end-5000);for(const [key,at]of seen)if(at<cursor)seen.delete(key);
  await new Promise(resolve=>{if(signal?.aborted)return resolve();const done=()=>{clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();};const timer=setTimeout(done,intervalMs);signal?.addEventListener('abort',done,{once:true});});
 }
}

// Explicitly selected private-message source. Never scans unrelated contacts,
// groups or media tables and never exposes raw data/URLs, even with expand.
export function readStoredQQMessages(snowlumaRoot,runtimeRoot,from,to,{messageId,peer,expand=false,previews=[]}={}) {
 if(!messageId&&!peer)throw Error('snowluma-messages requires message-id or peer');
 if(messageId&&(!/^-?[1-9]\d{0,15}$/.test(messageId)||!Number.isSafeInteger(Number(messageId))))throw Error('Invalid stored QQ message id');
 if(peer&&!/^\d{5,12}$/.test(peer))throw Error('Invalid peer');
 const subjects=allowedMembers(config(runtimeRoot)),byPeer=new Map(subjects.map(r=>[r.qq,r]));
 if(peer&&!byPeer.has(peer))throw Error('Stored QQ peer is not enabled in Fusion');
 const root=path.join(snowlumaRoot,'runtime','data'),events=[];
 if(!exists(root))return events;
 for(const entry of fs.readdirSync(root,{withFileTypes:true})) {
  if(!entry.isDirectory()||!/^\d{5,12}$/.test(entry.name))continue;
  const file=path.join(root,entry.name,'messages.db');if(!exists(file)||fs.lstatSync(file).isSymbolicLink())continue;
  database(file,db=>{
   const where=['is_group=0','timestamp>=?','timestamp<=?'],params=[Math.floor(from/1000),Math.floor(to/1000)];
   if(messageId){where.push('message_hash=?');params.push(Number(messageId));}
   if(peer){where.push('session_id=?');params.push(Number(peer));}
   else {where.push('session_id IN ('+subjects.map(()=>'?').join(',')+')');params.push(...subjects.map(r=>Number(r.qq)));}
   for(const row of db.prepare('SELECT message_hash,session_id,private_direction,timestamp,data FROM messages WHERE '+where.join(' AND ')+' ORDER BY timestamp,message_hash').all(...params)) {
    let record;try{record=JSON.parse(row.data);}catch{continue;}
    const id=String(row.message_hash),subject=byPeer.get(String(row.session_id)),bot=String(record.self_id);
    if(!subject||record.message_type!=='private'||bot!==entry.name||String(record.message_id)!==id||!Array.isArray(record.message))continue;
    const sender=String(record.user_id),outbound=sender===bot;
    if(outbound?(row.private_direction!==1||String(record.target_id)!==subject.qq):(sender!==subject.qq||![-1,0].includes(row.private_direction)))continue;
    const at=row.timestamp*1000;if(!Number.isSafeInteger(at)||at<from||at>to)continue;
    const text=record.message.filter(s=>s.type==='text'&&typeof s.data?.text==='string').map(s=>s.data.text).join('');
    const safe=redactText(text),preview=previews.find(e=>e.correlation.qqMessageId===id&&e.correlation[outbound?'recipientId':'senderId']===subject.qq&&e.kind===(outbound?'qq.outbound':'qq.inbound'))?.data.text;
    const storedComparison=typeof preview!=='string'?'unavailable':preview===safe?'equal':safe.startsWith(preview)?'prefix':'different';
    events.push(normalizeTraceEvent({at,source:'snowluma-messages',kind:'qq.stored_message',
     correlation:correlationFrom({qqMessageId:id,sessionKey:sessionFor(subject),senderId:sender,recipientId:outbound?subject.qq:bot}),
     data:{direction:outbound?'outbound':'inbound',textLength:text.length,bytes:Buffer.byteLength(text),sha256:createHash('sha256').update(text).digest('hex'),storedComparison,textCompleteness:'stored-text-segments',snapshotOfCurrentState:true,...(expand?{text:safe}:{})},
     sourceRef:{path:file,table:'messages'}}));
   }
  });
 }
 return events;
}
