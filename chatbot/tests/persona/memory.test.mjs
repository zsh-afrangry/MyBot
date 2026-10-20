// Document 25 P2: offline memory transactions, provenance, forgetting and host guards.
// Synthetic owner data and temporary directories only; no APIs, QQ or production writes.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createMemoryPlugin} from '../../plugins/kurumi-memory/index.js';
import {readMemory, writeMemory} from '../../plugins/kurumi-memory/store.js';
import {migrateMemory} from '../../plugins/kurumi-memory/continuity/migration.js';
import {createContinuityApplication, createContinuityRegistry} from '../../plugins/kurumi-memory/continuity/application.js';
import {openContinuityStore, initializeContinuity, replaceNotice} from '../../plugins/kurumi-memory/continuity/store.js';
import {MEMORY_NOTICE, emptyState, digest, STATE_RELATIVE, safeText} from '../../plugins/kurumi-memory/continuity/model.js';
import {continuityPolicy} from '../../plugins/kurumi-memory/continuity/policy.js';
import {withAccess, OWNER} from '../access-control/fixtures.mjs';
const key = `agent:main:kurumi-qq:direct:${OWNER}`;
function fixture(t, legacy = true) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-memory-p2-')), workspace = path.join(root,'workspace'), backupRoot = path.join(root,'migration');
  fs.mkdirSync(workspace); fs.mkdirSync(backupRoot, {mode:0o700});
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  if (legacy) writeMemory(workspace, {entries: [{id:'123456abcdef',text:'合成旧偏好是短回答',updatedAt:'2026-10-19T12:00:00.000Z'}]}, 0);
  return {root,workspace,backupRoot,ownerId:OWNER};
}
function active(t, config = {}) {
  const f=fixture(t,false); migrateMemory({...f,apply:true});
  let clock=Date.parse('2026-10-20T00:00:00.000Z'),seq=0;
  const app=createContinuityApplication({config,now:()=>clock});
  const request=(raw,patch={})=>({raw,at:clock,messageId:String(++seq),ownerId:OWNER,sessionKey:key,sessionId:'session-fixture',runId:'run-'+seq,generation:app.read(f).generation,...patch});
  const change=(args,raw,patch)=>app.change(f,{expectedRevision:app.read(f).revision,...args},request(raw,patch));
  return {...f,app,request,change,advance:ms=>clock+=ms};
}
const fact=text=>({text,evidence:text,kind:'preference'});
test('explicit migration preserves IDs and revision, saves private originals, and leaves one writer',t=>{
  const f=fixture(t),before=fs.readFileSync(path.join(f.workspace,'MEMORY.md'));
  const preview=migrateMemory(f); assert.equal(preview.facts,1); assert.equal(fs.existsSync(path.join(f.workspace,STATE_RELATIVE)),false);
  const result=migrateMemory({...f,apply:true});
  assert.deepEqual(fs.readFileSync(path.join(result.backup,'MEMORY.md')),before);
  assert.equal(fs.statSync(path.join(result.backup,'MEMORY.md')).mode&0o077,0);
  assert.equal(fs.statSync(path.join(f.workspace,STATE_RELATIVE)).mode&0o077,0);
  assert.equal(fs.readFileSync(path.join(f.workspace,'MEMORY.md'),'utf8'),MEMORY_NOTICE);
  const data=readMemory(f.workspace); assert.equal(data.revision,1);assert.equal(data.entries[0].id,'123456abcdef');
  assert.equal(migrateMemory({...f,apply:true}).alreadyMigrated,true);
  assert.throws(()=>writeMemory(f.workspace,{entries:[]},1),/legacy writes/);
});
test('unmanaged legacy notes, symlink workspaces and symlink state cannot be silently imported',t=>{
  const f=fixture(t,false);fs.writeFileSync(path.join(f.workspace,'MEMORY.md'),'手写素材');
  assert.throws(()=>migrateMemory({...f,apply:true}),/explicit import/);
  fs.unlinkSync(path.join(f.workspace,'MEMORY.md'));
  fs.symlinkSync(f.workspace,path.join(f.root,'link'));
  assert.throws(()=>migrateMemory({...f,workspace:path.join(f.root,'link'),apply:true}),/real absolute/);
  migrateMemory({...f,apply:true}); const db=path.join(f.workspace,STATE_RELATIVE);
  fs.renameSync(db,db+'.real');fs.symlinkSync(db+'.real',db);
  assert.throws(()=>openContinuityStore(f),/regular file/);
});
test('a partially completed import can finish; unrelated canonical data is never overwritten',t=>{
  const f=fixture(t),original=fs.readFileSync(path.join(f.workspace,'MEMORY.md'));
  const state=emptyState(OWNER,1);state.importedFrom={sha256:digest(original),revision:1,entries:1};
  state.facts=[{id:'123456abcdef',text:'合成旧偏好是短回答',kind:'fact',createdAt:'2026-10-19T12:00:00.000Z',updatedAt:'2026-10-19T12:00:00.000Z',
    source:{origin:'legacy_explicit',messageId:'legacy:123456abcdef',sessionKey:key,sessionId:'legacy-import',runId:'legacy-import',at:'2026-10-19T12:00:00.000Z',rawHash:digest('合成旧偏好是短回答'),evidence:'合成旧偏好是短回答'}}];
  initializeContinuity(f.workspace,state);assert.equal(migrateMemory({...f,apply:true}).applied,true);
  const other=fixture(t,false);initializeContinuity(other.workspace,emptyState(OWNER));
  assert.throws(()=>migrateMemory({...other,apply:true}),/unrelated/);assert.equal(fs.existsSync(path.join(other.workspace,'MEMORY.md')),false);
});
test('automatic batch binds original evidence, persists provenance and replays exactly once',t=>{
  const f=active(t),raw='我平时喜欢桂花茶，回答尽量简短。明天准备去图书馆。';
  const args={action:'observe',expectedRevision:0,facts:[fact('我平时喜欢桂花茶'),fact('回答尽量简短')],summary:{text:'用户明天准备去图书馆。',evidence:'明天准备去图书馆'}};
  const request=f.request(raw),result=f.app.change(f,args,request);
  assert.equal(result.ids.length,2);assert.equal(result.summarySaved,true);
  assert.equal(f.app.change(f,args,request).replayed,true);assert.equal(f.app.read(f).revision,1);
  const state=openContinuityStore(f);try{const data=state.read();assert.equal(data.facts[0].source.rawHash,digest(raw));assert.equal(data.facts[0].source.runId,request.runId);assert.equal(data.receipts.length,1);}finally{state.close();}
  assert.throws(()=>f.app.change(f,{...args,facts:[fact('我平时喜欢桂花茶')]},request),/不同写入/);
});
test('non-current sources, credentials, stale requests and unknown owners fail without committing',t=>{
  const f=active(t),base={action:'observe',expectedRevision:0,facts:[fact('我喜欢咖啡')]};
  assert.throws(()=>f.app.change(f,base,f.request('看看引用内容')),/本次本人/);
  assert.throws(()=>f.app.change(f,{...base,facts:[fact('我的密码是example')]},f.request('我的密码是example')),/凭证/);
  for(const patch of [{at:0},{at:Date.parse('2030-01-01')},{runId:undefined},{ownerId:'800001'},{generation:8}]) assert.throws(()=>f.app.change(f,base,f.request('我喜欢咖啡',patch)));
  assert.equal(f.app.read(f).revision,0);
});
test('credential markers are rejected across long summary boundaries',()=>{
  const prefix = 'a'.repeat(296), marker = '-----BEGIN PRIVATE KEY-----', suffix = 'b'.repeat(260);
  assert.throws(() => safeText(prefix + marker + suffix, 600), /凭证/);
});
test('correction and forgetting clear all active summaries and fence stale sources and replays',t=>{
  const f=active(t);const first=f.change({action:'observe',facts:[fact('我喜欢咖啡')],summary:{text:'用户喜欢咖啡。',evidence:'我喜欢咖啡'}},'我喜欢咖啡');
  const stale=f.request('我喜欢咖啡');
  f.change({action:'upsert',id:first.ids[0],text:'我现在喜欢茶'},'之前说错了，我现在喜欢茶');
  assert.equal(f.app.read(f).summaries.length,0);assert.equal(f.app.read(f).generation,1);
  assert.throws(()=>f.app.change(f,{action:'observe',expectedRevision:2,facts:[fact('我喜欢咖啡')]},stale),/失效/);
  const suppressed=f.change({action:'observe',facts:[fact('我喜欢咖啡')],summary:{text:'用户喜欢咖啡。',evidence:'我喜欢咖啡'}},'我喜欢咖啡');
  assert.equal(suppressed.suppressed,true);assert.equal(suppressed.summarySaved,false);
  f.change({action:'delete',id:first.ids[0]},'把我的饮料偏好忘掉');
  assert.equal(f.app.read(f).entries.length,0);
  const store=openContinuityStore(f);try{const data=store.read();assert(!JSON.stringify(data).includes('我现在喜欢茶'));assert.equal(data.summaries.length,0);}finally{store.close();}
  f.change({action:'upsert',text:'我喜欢咖啡'},'重新记住我喜欢咖啡');assert.equal(f.app.read(f).entries.length,1);
});
test('summary TTL is enforced on read/context and expired summaries are removed on next commit',t=>{
  const f=active(t,{summaryTtlDays:1});f.change({action:'observe',summary:{text:'用户明天要去图书馆。',evidence:'明天去图书馆'}},'明天去图书馆');
  f.advance(86400000);assert.equal(f.app.read(f).summaries.length,0);assert.equal(f.app.context(f,'图书馆').recentSummaries.length,0);
  f.change({action:'observe',facts:[fact('我喜欢绿茶')]},'我喜欢绿茶');
  const store=openContinuityStore(f);try{assert.equal(store.read().summaries.length,0);}finally{store.close();}
});
test('real SQLite CAS and failed validation roll back; process exit before commit is recovered',t=>{
  const f=active(t),a=openContinuityStore(f),b=openContinuityStore(f);
  try{const original=a.read();a.write(original,0);assert.throws(()=>b.write(original,0),/已改变/);assert.throws(()=>a.write({...a.read(),facts:[{}]},1));assert.equal(a.read().revision,1);}finally{a.close();b.close();}
  const child=spawnSync(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite'; const d=new DatabaseSync(process.argv[1]);d.exec('BEGIN IMMEDIATE');d.prepare('UPDATE memory_state SET revision=99 WHERE singleton=1').run();process.exit(0);`,path.join(f.workspace,STATE_RELATIVE)],{encoding:'utf8'});
  assert.equal(child.status,0);assert.equal(f.app.read(f).revision,1);
});
test('bounded summaries and context do not silently evict facts',t=>{
  const f=active(t,{maxContextChars:2000});
  for(let n=0;n<33;n++)f.change({action:'observe',summary:{text:'合成摘要'+n,evidence:'合成消息'}},'合成消息');
  assert.equal(f.app.read(f).summaries.length,32);assert(JSON.stringify(f.app.context(f,'合成')).length<=2000);
  for(let n=0;n<128;n++)f.change({action:'observe',facts:[fact('合成偏好编号'+n)]},'合成偏好编号'+n);
  const before=f.app.read(f);assert.throws(()=>f.change({action:'observe',facts:[fact('另一个偏好')]},'另一个偏好'),/已满/);assert.equal(f.app.read(f).entries.length,128);assert.equal(f.app.read(f).revision,before.revision);
});
test('alternate policy/store are composition-local; async methods fail without success receipts',t=>{
  const f=active(t),registry=createContinuityRegistry();let data=emptyState(OWNER),closed=0;
  registry.registerPolicy('alternate',continuityPolicy);registry.registerStore('fake',()=>({read:()=>structuredClone(data),write:(next,rev)=>{assert.equal(rev,data.revision);data={...next,revision:rev+1};return data;},close(){closed++;}}));
  const app=createContinuityApplication({registry,policyAdapter:'alternate',storeAdapter:'fake'});
  app.change(f,{action:'observe',expectedRevision:0,facts:[fact('我喜欢绿茶')]},{...f.request('我喜欢绿茶'),at:Date.now()});assert.equal(data.facts.length,1);assert.equal(closed,1);
  registry.registerStore('bad',()=>({read:()=>emptyState(OWNER),write:()=>Promise.resolve({}),close(){closed++;}}));
  const bad=createContinuityApplication({registry,storeAdapter:'bad'});
  assert.throws(()=>bad.change(f,{action:'observe',expectedRevision:0,facts:[fact('我喜欢绿茶')]},{...f.request('我喜欢绿茶'),at:Date.now()}),/Async memory-continuity store.write/);
  assert.equal(closed,2);assert.equal(f.app.read(f).revision,0);
});
function host(t) {
  const f=active(t),hooks={},tools={};let live=true,sequence=0;
  const config=withAccess({channels:{'kurumi-qq':{ownerId:OWNER}},agents:{entries:{main:{workspace:f.workspace}}}});
  const pluginConfig={continuity:{enabled:true}};
  createMemoryPlugin().register({config,pluginConfig,on:(name,fn)=>hooks[name]=fn,registerTool:(factory,meta)=>tools[meta.name]=factory,logger:{warn(){}}});
  const ctx={agentId:'main',sessionKey:key,sessionId:'host-session',messageChannel:'kurumi-qq',requesterSenderId:OWNER,senderIsOwner:true,getRuntimeConfig:()=>config,assertInvocationCurrent(){assert(live,'revoked invocation');}};
  function turn(raw,patch={}) {
    hooks.reply_dispatch({ctx:{CommandAuthorized:true,ChatType:'direct',SenderId:OWNER,OriginatingChannel:'kurumi-qq',OriginatingTo:`user:${OWNER}`,SessionKey:key,RawBody:raw,Timestamp:Date.now(),MessageSid:String(++sequence),...patch}});
    const tool=tools.kurumi_memory.create(ctx),runId='host-run-'+sequence;
    const prompt=hooks.before_prompt_build({}, {agentId:'main',sessionKey:key,sessionId:ctx.sessionId,runId,senderId:OWNER,channel:'kurumi-qq',trigger:'user',workspaceDir:f.workspace,toolAuthority:{allows:()=>true,assertActive(){}},hookInvocation:{assertActive(){}}});
    const run=async(args,callId='call')=>{
      const event={toolName:'kurumi_memory',toolCallId:callId,runId},hookCtx={sessionKey:key,sessionId:ctx.sessionId,runId};
      hooks.before_tool_call(event,hookCtx);
      try{return JSON.parse((await tool.execute(callId,args)).content[0].text);}finally{hooks.after_tool_call(event,hookCtx);}
    };
    return {prompt,run,tool,runId};
  }
  return {...f,config,ctx,hooks,tools,turn,revoke:()=>live=false};
}
test('plugin binds raw ingress, actual run/call, and current owner authority before writes',async t=>{
  const f=host(t),a=f.turn('我喜欢绿茶');assert(a.prompt.prependContext.includes('currentUserText'));
  const result=await a.run({action:'observe',expectedRevision:0,facts:[fact('我喜欢绿茶')]});assert.equal(result.ok,true);
  const b=f.turn('看看引用',{BodyForAgent:'我喜欢咖啡'});
  await assert.rejects(b.run({action:'observe',expectedRevision:1,facts:[fact('我喜欢咖啡')]}),/本次本人/);
  await assert.rejects(a.tool.execute('old',{action:'delete',id:result.ids[0],expectedRevision:1}),/实际宿主回合/);
  f.revoke();await assert.rejects(b.run({action:'list'}),/revoked invocation/);
});
test('member/unknown contexts, reset, lifecycle end and changed permissions cannot access owner writes',async t=>{
  const f=host(t),a=f.turn('我喜欢绿茶');
  const member=f.tools.kurumi_memory.create({...f.ctx,requesterSenderId:'800001',senderIsOwner:false});
  await assert.rejects(member.execute('x',{action:'list'}),/owner private/);
  f.hooks.before_reset({sessionKey:key},{});await assert.rejects(a.run({action:'observe',expectedRevision:0,facts:[fact('我喜欢绿茶')]}),/实际宿主回合/);
  const b=f.turn('我喜欢咖啡');f.hooks.agent_end({runId:b.runId},{});await assert.rejects(b.run({action:'observe',expectedRevision:0,facts:[fact('我喜欢咖啡')]}),/实际宿主回合/);
  const c=f.turn('我喜欢红茶');f.config.channels['kurumi-qq'].accessControl.subjects.find(s=>s.role==='owner').permissions['memory.manage']=false;
  await assert.rejects(c.run({action:'observe',expectedRevision:0,facts:[fact('我喜欢红茶')]}),/owner private/);assert.equal(f.app.read(f).revision,0);
});
