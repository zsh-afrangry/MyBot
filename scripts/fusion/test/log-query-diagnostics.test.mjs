// Offline docs/18 diagnostics: synthetic SQLite/files/events, no services or external APIs.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';import {spawn} from 'node:child_process';import {once} from 'node:events';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
import {stateSnapshot,readCronRuns,knownWarning,selectRecentTurns,queryStatistics,tabularEvents,followQueries,readStoredQQMessages} from '../log-query-diagnostics.mjs';
import {collectEvents,renderQuery,parseDuration,runCli} from '../log-query.mjs';
import {normalizeTraceEvent,createTraceSink} from '../../../chatbot/packages/observability/index.js';
import {withAccess} from '../../../chatbot/tests/access-control/fixtures.mjs';
import {auditMemoryCall} from '../../../chatbot/packages/observability/memory-audit.js';
const at=Date.parse('2026-11-07T09:00:00+08:00'),peer='100001',key='agent:main:kurumi-qq:direct:'+peer;
const event=(kind,n,data={},correlation={})=>normalizeTraceEvent({at:at+n,source:'openclaw-session',kind,correlation:{sessionKey:key,...correlation},data});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-query-diagnostics-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function db(root,rel,sql){const file=path.join(root,rel);fs.mkdirSync(path.dirname(file),{recursive:true});const db=new DatabaseSync(file);try{db.exec(sql);}finally{db.close();}return file;}
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function setup(t){
 const root=fixture(t),workspace=path.join(root,'workspace');
 const memory=db(root,'workspace/.kurumi-memory/state.sqlite',"PRAGMA user_version=2; CREATE TABLE memory_state(singleton INTEGER, revision INTEGER, state_json TEXT); INSERT INTO memory_state VALUES(1,4,'{\"facts\":[{\"id\":\"aabbcc\",\"text\":\"PRIVATE MEMORY\"}],\"summaries\":[]}');");
 db(root,'state/personal-reminders/reminders.sqlite',"CREATE TABLE reminders(reminder_id TEXT,status TEXT,scheduled_at_utc INTEGER,failure_code TEXT,content TEXT);INSERT INTO reminders VALUES('reminder-1','scheduled',100,NULL,'PRIVATE REMINDER');");
 db(root,'state/personal-reminder-list/list.sqlite',"CREATE TABLE settings(singleton INTEGER,enabled INTEGER,version INTEGER,times_json TEXT);INSERT INTO settings VALUES(1,1,2,'[\"08:00\"]');CREATE TABLE items(id TEXT,status TEXT,version INTEGER,title TEXT,content TEXT,note TEXT,ddl TEXT);INSERT INTO items VALUES('list-1','active',3,'PRIVATE TITLE','PRIVATE LIST',NULL,NULL);");
 db(root,'state/openclaw.sqlite',`CREATE TABLE cron_jobs(job_id TEXT,enabled INTEGER,payload_kind TEXT,state_json TEXT);INSERT INTO cron_jobs VALUES('cron-1',1,'command','{"lastStatus":"ok","nextRunAtMs":1000}');
 CREATE TABLE cron_run_receipts(receipt_id TEXT,job_id TEXT,request_run_id TEXT,status TEXT,started_at_ms INTEGER,finished_at_ms INTEGER,delivery_attempt_state TEXT);INSERT INTO cron_run_receipts VALUES('receipt-1','cron-1','run-1','ok',${at},${at+200},'sent');`);
 fs.mkdirSync(path.join(root,'documents','records'),{recursive:true});fs.writeFileSync(path.join(root,'documents','records','doc_'+ 'a'.repeat(32)+'.json'),JSON.stringify({id:'doc_'+ 'a'.repeat(32),kind:'input',filename:'PRIVATE.pdf',title:'PRIVATE PAPER',bytes:10}));
 const cfg={agents:{entries:{main:{workspace}}},channels:{'kurumi-qq':{ownerId:peer,stateDir:path.join(root,'channel')}}};fs.writeFileSync(path.join(root,'openclaw.json'),JSON.stringify(cfg));return{root,workspace,memory,cfg};
}
test('five snapshots are current read-only summaries; private content is explicit expand only',t=>{
 const f=setup(t),before=hash(f.memory),entries=fs.readdirSync(f.workspace+'/.kurumi-memory');
 for(const kind of ['memory','reminders','reminder-list','documents','cron']){
  const result=stateSnapshot(f.root,kind,{now:at});assert(result.available);assert.equal(result.snapshotOfCurrentState,true);assert(!JSON.stringify(result).includes('PRIVATE'));
 }
 assert.equal(stateSnapshot(f.root,'memory').revision,4);assert.match(JSON.stringify(stateSnapshot(f.root,'memory',{expand:true})),/PRIVATE MEMORY/);
 assert.equal(hash(f.memory),before);assert.deepEqual(fs.readdirSync(f.workspace+'/.kurumi-memory'),entries);
 assert.throws(()=>stateSnapshot(f.root,'../../secrets'));const missing=fixture(t);assert.equal(stateSnapshot(missing,'memory').reason,'source_missing');assert.deepEqual(fs.readdirSync(missing),[]);
});
test('remote list does not read stale local rows or call a business API',t=>{
 const {root}=setup(t);fs.writeFileSync(path.join(root,'state/personal-reminder-list/data-source.json'),JSON.stringify({dataSource:'knowledgemap',baseUrl:'http://127.0.0.1:1',tokenFile:'/not-read'}));
 const result=stateSnapshot(root,'reminder-list',{expand:true});assert.equal(result.storage,'remote');assert.deepEqual(result.items,[]);assert.equal(result.reason,'remote_items_not_read_offline');
});
test('v3 memory snapshot returns typed IDs and revisions without text',t=>{
 const root=fixture(t);db(root,'workspace/.kurumi-memory/state.sqlite',`PRAGMA user_version=3;CREATE TABLE memory_aux(singleton INTEGER,state_json TEXT);INSERT INTO memory_aux VALUES(1,'{"revision":9,"generation":2}');CREATE TABLE memory_records(id TEXT,version INTEGER,kind TEXT,state TEXT,text TEXT);INSERT INTO memory_records VALUES('r-1',2,'fact','active','PRIVATE');`);
 const result=stateSnapshot(root,'memory');assert.equal(result.revision,9);assert.equal(result.items[0].version,2);assert(!JSON.stringify(result).includes('PRIVATE'));
});
test('Cron adapter retains actual time/status and explicitly missing exit code',t=>{
 const {root}=setup(t),events=readCronRuns(root,at-1,at+1000);assert.equal(events.length,1);assert.equal(events[0].correlation.cronJobId,'cron-1');assert.equal(events[0].data.durationMs,200);assert.equal(events[0].data.exitCode,null);assert.equal(events[0].data.exitCodeAvailable,false);
 assert.equal(collectEvents({runtimeRoot:root,sources:['cron-runs'],from:at-1,to:at+1000}).length,1);
});
test('fixed-window pagination, peer and last-turns filtering cannot carry another member into a page',()=>{
 const values=[event('agent.inbound',0,{text:'first'}),event('agent.reply',20,{text:'reply'}),event('agent.inbound',40,{text:'second'}),event('agent.reply',60,{text:'second reply'}),event('agent.inbound',50,{text:'other'},{sessionKey:'agent:member:kurumi-qq:direct:100002'})].sort((a,b)=>a.epochMs-b.epochMs);
 assert.deepEqual(selectRecentTurns(values.filter(e=>e.correlation.sessionKey===key),1).map(e=>e.data.text),['second','second reply']);
 const opts={from:at,to:at+100,peer,lastTurns:1,limit:1};const a=renderQuery(values,opts).json,b=renderQuery(values,{...opts,offset:a.nextOffset}).json;
 assert.equal(a.total,2);assert.equal(a.nextOffset,1);assert.equal(b.nextOffset,null);assert.equal(b.truncated,false);assert.equal(b.events[0].data.text,'second reply');
 assert.throws(()=>renderQuery(values,{...opts,offset:-1}));assert.throws(()=>selectRecentTurns(values,0));
});
test('table/markdown column allowlist escapes text and no-text projection strips all originals',()=>{
 const values=[event('agent.tool_result',0,{tool:'x|y\nline',status:'ok',text:'PRIVATE',summary:{content:'PRIVATE'}})];
 const rows=tabularEvents(values,{fields:'time,tool,outcome',format:'markdown'});assert(rows[2].includes('x\\|y line'));assert.throws(()=>tabularEvents(values,{fields:'data.text'}));
 assert(!JSON.stringify(renderQuery(values,{from:at,to:at+100,noText:true,format:'markdown'})).includes('PRIVATE'));
});
test('known warning collapse is exact and never hides policy-preservation failures by subsystem',()=>{
 const known=normalizeTraceEvent({at,source:'openclaw-runtime',kind:'openclaw.log',data:{message:'remote model catalog refresh failed; next check in 6 hours, or run openclaw models refresh',level:'WARN'}}),unknown=normalizeTraceEvent({at,source:'openclaw-runtime',kind:'outbound.session_warning',data:{message:'Failed to preserve outbound session creation policy',level:'WARN'}});
 assert(knownWarning(known).data.known);assert(!knownWarning(unknown).data.known);
 assert.equal(renderQuery([known,unknown],{from:at,to:at+1,raw:true}).json.hiddenKnown,1);assert.equal(renderQuery([known,unknown],{from:at,to:at+1,raw:true,showKnown:true}).json.events.length,2);
});
test('statistics count paired business failures once and retain measured versus unknown duration',()=>{
 const values=[event('agent.tool_call',0,{tool:'sample'},{toolCallId:'call-1'}),event('agent.tool_result',50,{tool:'sample',summary:{ok:false},businessOutcome:'error'},{toolCallId:'call-1'}),event('agent.model_usage',60,{provider:'fixture',model:'sample',usage:{input:2,output:3},usageAvailable:true})];
 const stats=queryStatistics(values);assert.equal(stats.tools[0].count,1);assert.equal(stats.tools[0].failures,1);assert.equal(stats.tools[0].averageDurationMs,50);assert.equal(stats.sources[0].failures,1);assert.equal(stats.models[0].usage.input,2);
});
test('follow de-duplicates overlap, observes new/corrected receipts and stops on abort',async()=>{
 const controller=new AbortController(),first=event('agent.reply',0,{status:'unknown'}),second=event('agent.reply',50,{status:'sent'});let reads=0;const emitted=[];
 await followQueries({from:at,to:()=>at+100,intervalMs:100,signal:controller.signal,read:()=>++reads===1?[first]:[first,second],emit:rows=>{emitted.push(...rows);if(reads===2)controller.abort();}});
 assert.equal(reads,2);assert.equal(emitted.length,2);assert.equal(emitted[1].data.status,'sent');
});
test('memory auditing preserves result/error and logs no query, evidence, raw text or arbitrary error',async t=>{
 const f=setup(t),ctx={agentId:'main',requesterSenderId:peer,sessionKey:key,sessionId:'session-1',runId:'run-1'},api={config:f.cfg};
 const result={content:[{type:'text',text:JSON.stringify({revision:5,ids:['aabbcc'],entries:[{id:'aabbcc',text:'PRIVATE RESULT'}]})}]};
 const returned=await auditMemoryCall({api,ctx,callId:'call-1',args:{action:'upsert',text:'PRIVATE INPUT',evidence:'PRIVATE'}},async()=>{
  const d=new DatabaseSync(f.memory);try{d.exec('UPDATE memory_state SET revision=5');}finally{d.close();}return result;
 });assert.equal(returned,result);
 const error=Error('PRIVATE ERROR');await assert.rejects(auditMemoryCall({api,ctx,callId:'call-2',args:{action:'search',query:'PRIVATE QUERY'}},async()=>{throw error;}),e=>e===error);
 const rows=fs.readFileSync(path.join(f.root,'channel','memory-events.jsonl'),'utf8');assert(!rows.includes('PRIVATE'));const values=rows.trim().split('\n').map(JSON.parse);assert.equal(values[0].data.revisionBefore,4);assert.equal(values[0].data.revisionAfter,5);assert.equal(values[1].data.code,'memory_operation_rejected');
 assert.equal(await auditMemoryCall({api:{config:{}},ctx:{},callId:'x',args:{}},async()=>42),42);
 assert.equal(collectEvents({runtimeRoot:f.root,sources:['kurumi-memory'],from:0,to:Date.now()+1000}).length,2);assert.equal(values[0].correlation.runId,undefined);
});
test('relative-time validation and CLI option combinations fail clearly',()=>{
 assert.equal(parseDuration('30m'),1800000);assert.equal(parseDuration('10000d'),10000*86400000);for(const s of ['0m','-1h','2years','999999999999999999999d'])assert.throws(()=>parseDuration(s));
 assert.throws(()=>runCli(['--since','30m','--from','2026-01-01']),/mutually exclusive/);assert.throws(()=>runCli(['--follow','--offset','1']));assert.throws(()=>runCli(['--format','unknown']));assert.throws(()=>runCli(['--from','not a date']));
});


test('native model metadata and compaction are visible per turn without inferring fallback or missing tokens',t=>{
 const root=fixture(t),file=db(root,'agents/main/agent/openclaw-agent.sqlite',`CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at INTEGER,updated_at INTEGER,channel TEXT,account_id TEXT,chat_type TEXT,primary_conversation_id TEXT);CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,created_at INTEGER);`),d=new DatabaseSync(file);
 d.prepare('INSERT INTO session_windows VALUES(?,?,?,?,?,?,?,?)').run('s1',key,at,at+1000,'kurumi-qq','default','direct','fixture');
 const records=[{type:'message',message:{role:'user',content:[{type:'text',text:'PRIVATE'}]}},{type:'model_change',provider:'fixture',modelId:'sample'},{type:'message',message:{role:'assistant',provider:'fixture',model:'sample',usage:{input:3,output:2},content:[]}},{type:'compaction',tokensBefore:100,summary:'PRIVATE SUMMARY'}];
 records.forEach((r,i)=>d.prepare('INSERT INTO transcript_events VALUES(?,?,?,?,?)').run('s1',i+1,JSON.stringify({...r,timestamp:new Date(at+i*100).toISOString()}),null,at+i*100));d.close();
 const values=collectEvents({runtimeRoot:root,sources:['openclaw-session'],from:at,to:at+1000}),stats=queryStatistics(values);
 assert(values.some(e=>e.kind==='session.model_change'));assert.equal(stats.modelTurns.length,1);assert.equal(stats.modelTurns[0].usage.input,3);assert.equal(stats.modelTurns[0].compacted,true);assert.equal(stats.modelTurns[0].fallbackKnown,false);assert(!JSON.stringify(stats).includes('PRIVATE'));
});


test('CLI follow paginates every fresh event and removes its signal handlers on graceful SIGINT',async t=>{
 const root=fixture(t),directory=path.join(root,'channel');fs.mkdirSync(directory);const file=path.join(directory,'trace-events.jsonl'),now=Date.now();
 const value=id=>normalizeTraceEvent({at:now,source:'trace-events',kind:'fixture.event',correlation:{runId:id},data:{status:'ok'}});
 fs.writeFileSync(file,[value('first'),value('second')].map(e=>JSON.stringify(e)).join('\n')+'\n');
 const child=spawn(process.execPath,[fileURLToPath(new URL('../log-query.mjs',import.meta.url)),'--runtime-root',root,'--snowluma-root',root,'--source','trace-events','--since','30m','--follow','--interval','100','--limit','1','--json'],{stdio:['ignore','pipe','pipe']});
 t.after(()=>{if(child.exitCode===null)child.kill('SIGKILL');});let buffer='',stderr='';const ids=[];let appended=false;
 child.stderr.on('data',c=>stderr+=c);child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);if(!line.trim())continue;const result=JSON.parse(line);ids.push(...result.events.map(e=>e.correlation.runId));}
  if(ids.length===2&&!appended){appended=true;fs.appendFileSync(file,JSON.stringify(value('third'))+'\n');}if(ids.length===3)child.kill('SIGINT');
 });
 const timer=setTimeout(()=>child.kill('SIGKILL'),5000);const [code,signal]=await once(child,'exit');clearTimeout(timer);assert.equal(code,0,stderr);assert.equal(signal,null);assert.deepEqual(ids,['first','second','third']);
});

test('bounded diagnostic generations retain one private queryable predecessor', async t=>{
 const root=fixture(t),file=path.join(root,'channel','e7-events.jsonl');
 const sink=createTraceSink(file,{maxBytes:1}),at=Date.now();
 const emit=id=>sink.emit({at,source:'e7',kind:'e7.resource',correlation:{runId:id},data:{status:'ok'}});
 emit('first');emit('second');emit('third');
 assert.deepEqual(fs.readdirSync(path.dirname(file)).sort(),['e7-events.jsonl','e7-events.jsonl.1']);
 assert.equal(fs.statSync(file).mode&0o777,0o600);assert.equal(fs.statSync(file+'.1').mode&0o777,0o600);
 const result=renderQuery(collectEvents({runtimeRoot:root,snowlumaRoot:root,sources:['e7'],from:at-1000,to:at+1000}),{from:at-1000,to:at+1000}).json;
 assert.deepEqual(result.events.map(e=>e.correlation.runId),['second','third']);
 assert.throws(()=>createTraceSink(file,{maxBytes:-1}),/maxBytes/);
});

function storedFixture(t){
 const f=setup(t);withAccess(f.cfg);fs.writeFileSync(path.join(f.root,'openclaw.json'),JSON.stringify(f.cfg));
 const bot='100002',file=db(f.root,'runtime/data/'+bot+'/messages.db','CREATE TABLE messages(message_hash INTEGER,is_group INTEGER,session_id INTEGER,private_direction INTEGER,timestamp INTEGER,data TEXT)');
 const d=new DatabaseSync(file);const base={time:at/1000,self_id:Number(bot),post_type:'message',message_type:'private',message_id:-21,user_id:Number(peer),message:[{type:'text',data:{text:'PRIVATE LINE\n第二行'}},{type:'image',data:{url:'https://example.test/?rkey=DO_NOT_COPY'}}],raw_message:'DO_NOT_COPY_RAW'};
 const insert=(id,patch={},row={})=>d.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(id,row.group??0,row.peer??Number(peer),row.direction??0,at/1000,JSON.stringify({...base,message_id:id,...patch}));
 insert(-21);insert(-22,{user_id:Number(bot),target_id:Number(peer)},{direction:1});insert(-23,{}, {group:1});insert(-24,{user_id:100009},{peer:100009});insert(-25,{user_id:Number(bot),target_id:100009},{direction:1});insert(-26,{self_id:100003});insert(-27,{message_id:9000});insert(-28,{}, {direction:3});d.close();return{...f,file};
}
test('stored QQ messages are explicit scoped read-only text summaries; no group, foreign peer or media leak',t=>{
 const f=storedFixture(t),before=hash(f.file),options={peer};
 assert.throws(()=>readStoredQQMessages(f.root,f.root,at-1000,at+1000),/requires message-id or peer/);
 assert.throws(()=>readStoredQQMessages(f.root,f.root,at-1000,at+1000,{peer:'100009'}),/not enabled/);
 assert.throws(()=>readStoredQQMessages(f.root,f.root,at-1000,at+1000,{messageId:'9999999999999999'}),/Invalid/);
 const rows=readStoredQQMessages(f.root,f.root,at-1000,at+1000,options);assert.equal(rows.length,2);assert(!JSON.stringify(rows).includes('PRIVATE'));assert(!JSON.stringify(rows).includes('DO_NOT_COPY'));assert(rows.every(e=>e.data.textCompleteness==='stored-text-segments'));assert.equal(rows[1].data.direction,'inbound');assert.equal(rows[0].data.direction,'outbound');
 const full=readStoredQQMessages(f.root,f.root,at-1000,at+1000,{messageId:'-21',expand:true});assert.equal(full[0].data.text,'PRIVATE LINE\n第二行');assert(!JSON.stringify(full).includes('DO_NOT_COPY'));assert.equal(full[0].data.sha256,createHash('sha256').update('PRIVATE LINE\n第二行').digest('hex'));assert.equal(hash(f.file),before);
});
test('stored messages compare only matching ID, direction and peer; no text/time correlation',t=>{
 const f=storedFixture(t),preview=normalizeTraceEvent({at,source:'snowluma',kind:'qq.inbound',correlation:{qqMessageId:'-21',senderId:peer},data:{text:'PRIVATE LINE'}});
 const read=previews=>readStoredQQMessages(f.root,f.root,at-1000,at+1000,{messageId:'-21',previews})[0].data.storedComparison;
 assert.equal(read([preview]),'prefix');assert.equal(read([{...preview,data:{text:'PRIVATE LINE\n第二行'}}]),'equal');assert.equal(read([{...preview,data:{text:'different'}}]),'different');assert.equal(read([{...preview,correlation:{qqMessageId:'-21',senderId:'100009'}}]),'unavailable');
 assert.equal(collectEvents({runtimeRoot:fixture(t),snowlumaRoot:f.root,from:at-1000,to:at+1000}).filter(e=>e.source==='snowluma-messages').length,0);
 const rows=collectEvents({runtimeRoot:f.root,snowlumaRoot:f.root,from:at-1000,to:at+1000,sources:['snowluma-messages'],messageId:'-21',expand:true});assert.equal(rows.length,1);assert(!JSON.stringify(renderQuery(rows,{from:at-1000,to:at+1000,noText:true}).json).includes('PRIVATE'));
});
