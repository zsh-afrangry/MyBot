// Document 29 deterministic mechanisms with synthetic owner data, real SQLite/FTS5 and immutable mirrors.
// No APIs, QQ, model, production migration or background wakeup.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {zstdCompressSync} from 'node:zlib';
import {NOTICE_V3} from '../../plugins/kurumi-memory/system/store.js';
import {RecordApplication as RecordStore,openRecordContinuityStore} from '../../plugins/kurumi-memory/system/application.js';
import {migrateMemoryV3,rollbackMemoryV3} from '../../plugins/kurumi-memory/system/migration.js';
import {emptyState,digest,MEMORY_NOTICE} from '../../plugins/kurumi-memory/continuity/model.js';
import {initializeContinuity,replaceNotice,openContinuityStore} from '../../plugins/kurumi-memory/continuity/store.js';
import {createContinuityApplication} from '../../plugins/kurumi-memory/continuity/application.js';
import {readHostRecords} from '../../packages/session-records/index.js';
import {createMemoryPlugin} from '../../plugins/kurumi-memory/index.js';
import {withAccess} from '../access-control/fixtures.mjs';
const owner='100001',key=`agent:main:kurumi-qq:direct:${owner}`,when='2026-11-01T18:00:00.000Z';
function fixture(t,{seed=false}={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-memory-v3-')),workspace=path.join(root,'workspace'),backupRoot=path.join(root,'backup');
  fs.mkdirSync(workspace);fs.mkdirSync(backupRoot,{mode:0o700});t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const state=emptyState(owner);
  if(seed){state.facts=[{id:'123456abcdef',text:'我的合成杯子是蓝色的',kind:'preference',createdAt:when,updatedAt:when,
    source:{origin:'current_owner',messageId:'seed-message',sessionKey:key,sessionId:'seed-session',runId:'seed-run',at:when,rawHash:digest('我的合成杯子是蓝色的'),evidence:'我的合成杯子是蓝色的'}}];
    state.barriers=[{hash:digest('old forgotten exact phrase'),at:when}];}
  initializeContinuity(workspace,state);replaceNotice(workspace);
  const location={workspace,ownerId:owner},preview=migrateMemoryV3(location),migration=migrateMemoryV3({...location,backupRoot,apply:true,expectedStateHash:preview.stateHash});
  const store=new RecordStore(location);t.after(()=>{try{store.close();}catch{}});
  let n=0;
  const ingress=(raw,patch={})=>store.appendIngress({ownerId:owner,sessionKey:key,sessionId:'synthetic-session',messageId:'message-'+ ++n,runId:'run-'+n,raw,at:Date.parse(when),...patch});
  const add=(kind,text,rawId,patch={})=>store.write({kind,about:kind==='note'?'self':'owner',basis:kind==='note'?'self':kind==='fact'?'stated':'inferred',text,sources:[{rawId}],...patch},{runId:'synthetic-write'});
  return {root,workspace,backupRoot,location,state,store,ingress,add,migration};
}
function hostDatabase(f) {
  const file=path.join(f.root,'host.sqlite'),db=new DatabaseSync(file);
  db.exec(`CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at INTEGER,updated_at INTEGER,channel TEXT,account_id TEXT,chat_type TEXT,primary_conversation_id TEXT);
    CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,created_at INTEGER);
    CREATE TABLE session_transcript_archives(archive_name TEXT,session_id TEXT,session_key TEXT,archive_blob BLOB,archive_sha256 TEXT,encoding TEXT,created_at INTEGER);`);
  db.prepare('INSERT INTO session_windows VALUES(?,?,?,?,?,?,?,?)').run('host-owner',key,1,Number.MAX_SAFE_INTEGER,'kurumi-qq','default','direct','owner-private');
  db.prepare('INSERT INTO session_windows VALUES(?,?,?,?,?,?,?,?)').run('host-member','agent:qq-user-100002:kurumi-qq:direct:100002',1,Number.MAX_SAFE_INTEGER,'kurumi-qq','default','direct','member-private');
  tCleanup(f,db);
  const append=(sessionId,seq,content,role='user',extra={})=>db.prepare('INSERT INTO transcript_events VALUES(?,?,?,?,?)').run(sessionId,seq,JSON.stringify({type:'message',timestamp:when,message:{role,content,...extra}}),null,Date.parse(when));
  return {db,file,append};
}
// The test's fixture closes host connections before removing its own directory.
function tCleanup(f,db){(f.databases??=[]).push(db);}
test('preview requires an exact state hash; migration preserves P2 IDs/provenance/barriers and explicit rollback preserves new v3 state',t=>{
  const f=fixture(t,{seed:true});assert.equal(fs.readFileSync(path.join(f.workspace,'MEMORY.md'),'utf8'),NOTICE_V3);
  const compat=openRecordContinuityStore(f.location);assert.deepEqual(compat.read(),f.state);compat.close();
  assert.equal(f.store.record('123456abcdef').id,'123456abcdef');assert.equal(migrateMemoryV3(f.location).alreadyMigrated,true);
  f.add('note','一次合成开发经验',f.ingress('这是一次合成的开发经验',{at:Date.parse(when)+1000}));
  const rev=f.store.aux().revision;f.store.close();
  assert.throws(()=>rollbackMemoryV3({...f.location,backup:f.migration.backup,backupRoot:f.backupRoot,expectedRevision:rev-1,apply:true}),/preview/);
  const rolled=rollbackMemoryV3({...f.location,backup:f.migration.backup,backupRoot:f.backupRoot,expectedRevision:rev,apply:true});
  assert.equal(rolled.sourceWritesSinceMigration,true);assert(fs.existsSync(path.join(rolled.preservedV3,'state.sqlite')));
  assert.equal(fs.readFileSync(path.join(f.workspace,'MEMORY.md'),'utf8'),MEMORY_NOTICE);
  const old=openContinuityStore(f.location);try{assert.deepEqual(old.read(),f.state);}finally{old.close();}
});
test('records use CAS and keep every version; source/category/portrait rules and sticky external provenance cannot be bypassed',t=>{
  const f=fixture(t),raw=f.ingress('周五有一个合成答辩'),r=f.add('thread','周五合成答辩',raw,{attrs:{due:'2026-11-06T01:00:00Z'}});
  assert.throws(()=>f.store.write({...r,text:'lost update'},{runId:'parallel',expectedVersion:0}),/version_conflict/);
  const next=f.store.revise(r.id,{action:'append',text:'提醒自己问结果',expectedVersion:1},{runId:'same-session'});assert.equal(next.version,2);assert.equal(f.store.history(r.id).length,2);
  assert.throws(()=>f.store.revise(r.id,{action:'replace',find:'合成',replacement:'',expectedVersion:1},{runId:'stale'}),/version_conflict/);
  assert.throws(()=>f.add('fact','主人没说的话',raw),/exact_owner_source/);
  assert.throws(()=>f.add('rhythm','半夜很多消息',raw,{basis:'observed'}),/record_kind/);
  const ext=digest('external-fixture');f.store.appendRaw({rawId:ext,sessionId:'synthetic-session',origin:'external',content:'网页说喜欢雨天',body:{type:'test-external'},at:when});
  const note=f.add('note','我对雨天有点兴趣',ext),changed=f.store.revise(note.id,{action:'rewrite',text:'我仍在想雨天',sources:[{rawId:raw}],expectedVersion:1},{runId:'revised'});assert.equal(changed.external,true);
  const parent=f.add('episode','最初只有内部来源',raw),child=f.store.write({kind:'note',about:'self',basis:'self',text:'根据片段形成的笔记',sources:[{recordId:parent.id}]},{runId:'child'});
  f.store.revise(parent.id,{action:'rewrite',text:'现在补充了外部材料',sources:[{rawId:ext}],expectedVersion:1},{runId:'external-update'});assert.equal(f.store.get(child.id).external,true);
  f.add('portrait','我的合成自我画像',raw,{about:'self',basis:'self'});
  assert.throws(()=>f.add('portrait','第二条活跃自我画像',raw,{about:'self',basis:'self'}),/UNIQUE/);
  assert.throws(()=>f.store.write({...r,sources:[{recordId:r.id}]},{runId:'cycle',expectedVersion:2}),/source_unavailable/);
});
test('stale migration previews and tampered rollback backups are rejected before changing the selected state',t=>{
  const f=fixture(t),workspace=path.join(f.root,'second-workspace');fs.mkdirSync(workspace);fs.mkdirSync(path.join(workspace,'.kurumi-memory'),{mode:0o700});
  fs.copyFileSync(path.join(f.migration.backup,'state.sqlite'),path.join(workspace,'.kurumi-memory/state.sqlite'));fs.copyFileSync(path.join(f.migration.backup,'MEMORY.md'),path.join(workspace,'MEMORY.md'));
  const location={workspace,ownerId:owner},preview=migrateMemoryV3(location),old=openContinuityStore(location),state=old.read();old.write(state,state.revision);old.close();
  assert.throws(()=>migrateMemoryV3({...location,backupRoot:f.backupRoot,apply:true,expectedStateHash:preview.stateHash}),/preview changed/);
  assert.equal(fs.readFileSync(path.join(workspace,'MEMORY.md'),'utf8'),MEMORY_NOTICE);
  const bytes=fs.readFileSync(path.join(f.migration.backup,'state.sqlite'));bytes[100]^=1;fs.writeFileSync(path.join(f.migration.backup,'state.sqlite'),bytes);
  assert.throws(()=>rollbackMemoryV3({...f.location,backup:f.migration.backup,backupRoot:f.backupRoot,expectedRevision:0,apply:true}),/material mismatch/);
  assert.equal(fs.readFileSync(path.join(f.workspace,'MEMORY.md'),'utf8'),NOTICE_V3);
});
test('Chinese trigram and short substring retrieval, L0 due ordering, self-first portraits and full-entry budget',t=>{
  const f=fixture(t),raw=f.ingress('合成的论文和画像材料'),self=f.add('portrait','我最近在想的事情',raw,{about:'self',basis:'self'}),own=f.add('portrait','她眼中的合成主人',raw);
  const episode=f.add('episode','上个月论文基线选择了绿色版本',raw,{attrs:{topics:['论文']}});
  f.add('thread','晚到期',raw,{attrs:{due:'2026-12-10T00:00:00Z'}});f.add('thread','早到期',raw,{attrs:{due:'2026-11-10T00:00:00Z'}});
  assert.equal(f.store.search('论文基线')[0].id,episode.id);assert.equal(f.store.search('基线')[0].id,episode.id);
  const l0=f.store.context('论文',1800);assert.equal(l0.records[0].id,self.id);assert.equal(l0.records[1].id,own.id);
  assert.deepEqual(l0.records.filter(r=>r.kind==='thread').map(r=>r.text),['早到期','晚到期']);assert.equal(l0.records.find(r=>r.kind==='topic').count,1);
  const tiny=f.store.context('论文',50);assert.equal(tiny.records.length,0);assert(JSON.stringify(l0).length<=1800);
});
test('forgetting cascades through derived records, masks raw/FTS/L0/history and survives index rebuild; raw rows are immutable',t=>{
  const f=fixture(t),raw=f.ingress('合成暗号是桃花岛'),a=f.add('inference','合成暗号是桃花岛',raw),b=f.store.write({kind:'portrait',about:'owner',basis:'inferred',text:'主人的合成暗号',sources:[{recordId:a.id}]},{runId:'derive'});
  assert.equal(f.store.searchRaw('桃花岛').length,1);assert.equal(f.store.search('桃花岛').length,1);
  const before=f.store.rawRows().length;f.store.forget([a.id],{actor:'owner-forget',runId:'forget'});
  assert.equal(f.store.get(a.id),null);assert.equal(f.store.get(b.id),null);assert.equal(f.store.searchRaw('桃花岛').length,0);assert.equal(f.store.around(raw).length,0);assert.equal(f.store.history(a.id).length,0);
  f.store.rebuild();assert.equal(f.store.search('桃花岛',{history:true}).length,0);assert.equal(JSON.stringify(f.store.context('暗号')).includes('桃花岛'),false);assert.equal(f.store.rawRows().length,before);
  assert.throws(()=>f.store.db.prepare('UPDATE memory_raw SET text=? WHERE id=?').run('changed',raw),/append only/);
  assert.throws(()=>f.store.db.prepare('DELETE FROM memory_raw WHERE id=?').run(raw),/append only/);
  assert.throws(()=>f.add('note','我试图从被忘掉的来源重建',raw),/source_unavailable/);
});
test('P2 fact policy on record storage still observes, corrects, forgets atomically and explicitly remembers; stale generations cannot write',t=>{
  const f=fixture(t);let n=0;const app=createContinuityApplication({storeAdapter:'records-sqlite'});
  const change=(args,raw)=>{const data=app.read(f.location);return app.change(f.location,{expectedRevision:data.revision,...args},{ownerId:owner,sessionKey:key,sessionId:'compat-session',runId:'compat-'+ ++n,messageId:'compat-'+n,at:Date.now(),generation:data.generation,raw});};
  const first=change({action:'observe',facts:[{text:'我的合成笔记是蓝色的',evidence:'我的合成笔记是蓝色的'}]},'我的合成笔记是蓝色的');
  const id=first.ids[0];change({action:'upsert',id,text:'我的合成笔记是绿色的',evidence:'绿色的'},'更正：我的合成笔记是绿色的');
  assert.equal(app.read(f.location).entries[0].text,'我的合成笔记是绿色的');assert.equal(f.store.history(id).length,1,'masked old version not returned');
  change({action:'delete',id,evidence:'忘掉我的合成笔记'},'忘掉我的合成笔记');assert.equal(app.read(f.location).entries.length,0);
  const suppressed=change({action:'observe',facts:[{text:'我的合成笔记是绿色的',evidence:'我的合成笔记是绿色的'}]},'我的合成笔记是绿色的');assert.equal(suppressed.suppressed,true);
  change({action:'upsert',text:'我的合成笔记是绿色的',evidence:'我的合成笔记是绿色的'},'请记住：我的合成笔记是绿色的');assert.equal(app.read(f.location).entries.length,1);
  assert.equal(f.store.search('绿色').length,1);
});
test('source-scoped mirrors retain rewritten/deleted host rows and archived compressed sessions; member and projected user text cannot become owner facts',t=>{
  const f=fixture(t),host=hostDatabase(f);t.after(()=>host.db.close());
  host.append('host-owner',1,'原始合成基线是蓝色');host.append('host-owner',2,'我说过喜欢小雨','assistant');host.append('host-member',1,'成员不能进入主人的镜像');
  host.append('host-owner',3,'网页外部内容','toolResult',{toolName:'web_fetch'});host.append('host-owner',4,'天气结果','toolResult',{toolName:'personal_weather_get_brief'});
  assert.equal(f.store.ingestHost(host.file).retained,4);assert.equal(f.store.searchRaw('原始合成')[0].origin,'external');assert.equal(f.store.searchRaw('网页')[0].origin,'external');assert.equal(f.store.searchRaw('天气')[0].origin,'tool_result');assert.equal(f.store.searchRaw('成员').length,0);
  const own=f.store.searchRaw('我说过')[0];assert.equal(f.add('note','我喜欢小雨',own.rawId).basis,'self');
  const projected=f.store.searchRaw('原始合成')[0];assert.throws(()=>f.add('fact','原始合成基线是蓝色',projected.rawId),/exact_owner_source/);
  host.db.prepare('UPDATE transcript_events SET event_json=? WHERE session_id=? AND seq=1').run(JSON.stringify({type:'compaction',timestamp:when,summary:'替换尾部'}),'host-owner');
  host.db.prepare('DELETE FROM transcript_events WHERE session_id=? AND seq=2').run('host-owner');f.store.ingestHost(host.file);assert.equal(f.store.searchRaw('原始合成').length,1);assert.equal(f.store.searchRaw('我说过').length,1);
  const archive=Buffer.from(JSON.stringify({type:'session',id:'archived-owner'})+'\n'+JSON.stringify({type:'message',timestamp:when,message:{role:'assistant',content:'归档后的合成经历'}})+'\n'),compressed=zstdCompressSync(archive);
  host.db.prepare('INSERT INTO session_transcript_archives VALUES(?,?,?,?,?,?,?)').run('reset-fixture','archived-owner',key,compressed,createHash('sha256').update(compressed).digest('hex'),'zstd',Date.parse(when));
  f.store.ingestHost(host.file);assert.equal(f.store.searchRaw('归档后的')[0].origin,'she_said');
  const count=f.store.rawRows().length;f.store.ingestHost(host.file);assert.equal(f.store.rawRows().length,count);
  assert.equal(readHostRecords(host.file,{archives:true}).rows.some(r=>r.window.sessionKey.includes('100002')),true,'developer view remains complete');
  host.db.prepare("UPDATE session_transcript_archives SET archive_sha256='wrong'").run();assert.throws(()=>f.store.ingestHost(host.file),/hash mismatch/);
});
test('organizer batches are incremental and atomic; no-op commits advance; stale batches, foreign sources and forgotten in-flight work cannot commit',t=>{
  const f=fixture(t),raw=f.ingress('周五的合成答辩'),other=f.ingress('另一段合成资料');f.store.rebuild();
  const batch=f.store.nextBatch({limit:1,runId:'organize'}),parallel=f.store.nextBatch({limit:1,runId:'other'});
  assert.equal(batch.entries[0].rawId,raw);
  assert.throws(()=>f.store.commitBatch(batch.batchId,[{kind:'thread',about:'owner',basis:'inferred',text:'超出当前批次',sources:[{rawId:other}]}],{runId:'organize'}),/outside_batch/);
  const result=f.store.commitBatch(batch.batchId,[{kind:'thread',about:'owner',basis:'inferred',text:'周五答辩后问结果',attrs:{due:'2026-11-06T00:00:00Z'},sources:[{rawId:raw}]}],{runId:'organize'});assert.equal(result.cursorVersion,1);
  assert.throws(()=>f.store.commitBatch(parallel.batchId,[],{runId:'other'}),/cursor_conflict/);
  const next=f.store.nextBatch({runId:'organize-2'});assert.deepEqual(next.entries.map(e=>e.rawId),[other]);f.store.commitBatch(next.batchId,[],{runId:'organize-2'});assert.equal(f.store.nextBatch({runId:'organize-3'}).done,true);
  const note=f.add('note','合成笔记',other);f.ingress('新一段内容');const stale=f.store.nextBatch({runId:'stale'});f.store.forget([note.id],{runId:'forget'});assert.throws(()=>f.store.commitBatch(stale.batchId,[],{runId:'stale'}),/batch_stale/);
});
test('legacy hash-only barriers conservatively mask earlier host history without losing explicitly retained P2 facts',t=>{
  const f=fixture(t,{seed:true}),host=hostDatabase(f);t.after(()=>host.db.close());host.append('host-owner',1,'old forgotten exact phrase and more');f.store.ingestHost(host.file);
  assert.equal(f.store.searchRaw('forgotten').length,0);assert.equal(f.store.search('合成杯子').length,1);assert.equal(f.store.get('123456abcdef').id,'123456abcdef');
  assert.throws(()=>new RecordStore({...f.location,ownerId:'100002'}),/owner_mismatch/);
});
test('mechanical rhythm counts only trusted private ingress in Shanghai time and does not invalidate the current fact revision',t=>{
  const f=fixture(t);f.ingress('一次凌晨合成消息');f.ingress('第二次凌晨合成消息');f.ingress('白天的合成消息',{at:Date.parse('2026-11-02T06:00:00Z')});
  const rev=f.store.aux().revision,r=f.store.updateRhythm();assert.equal(r.basis,'observed');assert.equal(r.attrs.messages,3);assert.equal(r.attrs.hourly[2],2);assert.equal(r.attrs.hourly[14],1);assert.equal(f.store.aux().revision,rev);
  assert.equal(f.store.updateRhythm().version,r.version);assert.equal(f.store.context('').records.some(r=>r.kind==='rhythm'),true);
  assert.throws(()=>f.store.revise(r.id,{action:'retract',expectedVersion:r.version},{runId:'chat'}),/program_memory_readonly/);
  assert.throws(()=>f.store.write({...r,kind:'note',about:'self',basis:'self'},{runId:'chat',expectedVersion:r.version}),/identity_changed/);
});
test('opt-in tools enforce actual owner/run provenance, CAS, current forget evidence, raw permission revocation and no background activation',async t=>{
  const f=fixture(t),host=hostDatabase(f);t.after(()=>host.db.close());
  const config=withAccess({channels:{'kurumi-qq':{ownerId:owner,stateDir:path.join(f.root,'channel')}},agents:{entries:{main:{workspace:f.workspace}}}},owner);
  const pluginConfig={continuity:{enabled:true},continuityStoreAdapter:'records-sqlite',system:{enabled:true,records:true,raw:true,l0:true,hostDatabase:host.file}},hooks={},tools={};
  const api={config,pluginConfig,registrationMode:'full',logger:{warn(){}},on(name,fn){(hooks[name]??=[]).push(fn);},registerTool(factory,meta){tools[meta.name]=factory;}};
  createMemoryPlugin().register(api);
  const ctx={senderIsOwner:true,requesterSenderId:owner,agentId:'main',messageChannel:'kurumi-qq',sessionId:'plugin-session',sessionKey:key,
    deliveryContext:{channel:'kurumi-qq',to:'user:'+owner,accountId:'default'},getRuntimeConfig:()=>config,assertInvocationCurrent(){}};
  let n=0;
  function turn(raw){const runId='plugin-run-'+ ++n,hook={...ctx,runId,senderId:owner,channel:'kurumi-qq',trigger:'user',workspaceDir:f.workspace,toolAuthority:{allows:()=>true,assertActive(){}},hookInvocation:{assertActive(){}}};
    for(const fn of hooks.reply_dispatch??[])fn({ctx:{CommandAuthorized:true,ChatType:'direct',SenderId:owner,OriginatingChannel:'kurumi-qq',OriginatingTo:'user:'+owner,SessionKey:key,RawBody:raw,MessageSid:'plugin-message-'+n,Timestamp:Date.now()}});
    const prompts=(hooks.before_prompt_build??[]).map(fn=>fn({},hook));
    const run=async(name,args)=>{const toolCallId='plugin-call-'+ ++n,event={toolName:name,toolCallId};for(const fn of hooks.before_tool_call??[])fn(event,{...hook,toolCallId});try{return JSON.parse((await tools[name].create(ctx).execute(toolCallId,args)).content[0].text);}finally{for(const fn of hooks.after_tool_call??[])fn(event,{...hook,toolCallId});}};
    return {prompts,run,hook};}
  const first=turn('我答应周五陪主人看合成答辩结果'),raw=f.store.rawRows().find(r=>r.origin==='owner_said').id;
  const saved=await first.run('kurumi_memory_records',{action:'write',expectedVersion:0,record:{kind:'thread',about:'self',basis:'self',text:'周五问合成答辩结果',sources:[{rawId:raw}]}});assert(saved.ok);
  const member=tools.kurumi_memory_raw.create({...ctx,senderIsOwner:false,requesterSenderId:'100002'});await assert.rejects(async()=>member.execute('forged',{action:'search',query:'答辩'}),/owner_private/);
  const queried=turn('你忘掉答辩了吗？');await assert.rejects(queried.run('kurumi_memory_records',{action:'forget',ids:[saved.id],expectedVersions:{[saved.id]:saved.version},evidence:'忘掉答辩'}));assert(f.store.get(saved.id));
  const forget=turn('请忘掉答辩这件事');const result=await forget.run('kurumi_memory_records',{action:'forget',ids:[saved.id],expectedVersions:{[saved.id]:saved.version},evidence:'忘掉答辩'});assert(result.ok);
  assert.equal((await forget.run('kurumi_memory_raw',{action:'search',query:'答辩结果'})).length,0);
  config.channels['kurumi-qq'].accessControl.subjects[0].permissions['memory.raw.read']=false;
  await assert.rejects(forget.run('kurumi_memory_raw',{action:'search',query:'答辩'}),/owner_private/);
  const oldTool=tools.kurumi_memory_records.create(ctx);for(const fn of hooks.before_reset??[])fn({sessionKey:key},{});
  await assert.rejects(async()=>oldTool.execute('stale',{action:'write',record:{kind:'note'}}),/current_owner_run/);
  assert.throws(()=>createMemoryPlugin().register({...api,pluginConfig:{...pluginConfig,system:{...pluginConfig.system,organizer:true}}}),/n3_trusted_background/);
});
