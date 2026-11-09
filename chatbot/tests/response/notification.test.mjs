// Offline unified-expression regressions with real private fixture stores. docs/21.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {assistantText,visibleAssistantReply,withFacts,createAssistantComposer} from '../../packages/response-core/index.js';
import {registerDigestNotice} from '../../plugins/personal-reminder-list/notification.js';
import {registerReminderNotice} from '../../packages/personal-domains/dist/reminder-notification.js';
import {ReminderStore} from '../../packages/personal-domains/dist/reminder-store.js';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {ListControlStore} from '../../plugins/personal-reminder-list/remote.js';
import {withAccess,OWNER} from '../access-control/fixtures.mjs';
import {seedReminder,seedList} from './fixtures.mjs';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-notice-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let at=Date.parse('2026-11-30T19:55:00+08:00'),handler;const cfg=withAccess({});
 const api={config:cfg,registerGatewayMethod(name,fn,opts){assert.equal(opts.scope,'operator.admin');handler=fn;}};
 const run=params=>new Promise((resolve,reject)=>Promise.resolve(handler({params,respond:(ok,result,error)=>resolve({ok,result,error})})).catch(reject));
 return{root,cfg,api,run,now:()=>at,due:()=>{at=Date.parse('2026-11-30T20:00:05+08:00');}};
}
test('only successful visible assistant text can accompany business facts; reasoning and errors never become progress',()=>{
 for(const payloads of [[],[{text:'secret',isReasoning:true}],[{text:'tool text',isCommentary:true}],[{text:'NO_REPLY'}],[{text:'error',isError:true}]])assert.throws(()=>assistantText({payloads}),/assistant_notice/);
 assert.throws(()=>assistantText({payloads:[{text:'partial'}],meta:{aborted:true}}));
 assert.throws(()=>withFacts('', ['时间：20:00']));
 assert.equal(withFacts('自然说明\n内容：测试',['时间：20:00','内容：测试']),'自然说明\n内容：测试\n\n时间：20:00');
 assert.equal(visibleAssistantReply({text:'内部',isReasoning:true},{kind:'final'}),false);
 assert.equal(visibleAssistantReply({text:'工具输出'},{kind:'tool'}),false);
 assert.equal(visibleAssistantReply({text:'只是进度',isCommentary:true},{kind:'final'}),false);
 assert.equal(visibleAssistantReply({text:'可见进度',isCommentary:true},{kind:'block'}),true);
 assert.equal(visibleAssistantReply({text:'',isCommentary:true,mediaUrl:'/internal'},{kind:'block'}),false);
});
test('list notice preserves all immutable fields, is claimed once and does not expose routing in runner input',async t=>{
 const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();let calls=0;
 registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListStore(opts)},{now:f.now,composeNotice:async input=>{
  calls++;input.check();assert.equal(input.request.sessionKey,'agent:main:kurumi-qq:direct:'+OWNER);return{text:'模型自然提醒'};
 }});
 const r=await f.run({slot:'20:00'});assert(r.ok);for(const part of ['模型自然提醒','合成事项','明细不能丢','越快越好','未设 DDL'])assert(r.result.text.includes(part));
 assert.deepEqual((await f.run({slot:'20:00'})).result,{});assert.equal(calls,1);
 assert.equal((await f.run({slot:'20:00',to:'user:other'})).ok,false);
});
test('list opening receives only current count/time and complete item facts appear once',async t=>{
 const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();
 registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListStore(opts)},{now:f.now,composeNotice:async input=>{
  assert.deepEqual(Object.keys(input.facts).sort(),['at','count','kind','timezone']);assert.equal(input.facts.count,1);
  assert(!JSON.stringify(input.facts).includes('合成事项'));assert(input.instructions.includes('不要列举或概括任何具体事项'));
  return{text:'到时间了，来看看手头这件事吧。'};
 }});
 const r=await f.run({slot:'20:00'});assert(r.ok);
 for(const value of ['合成事项','明细不能丢','越快越好'])assert.equal(r.result.text.split(value).length-1,1);
 assert.equal(r.result.text.split('事项：').length-1,1);
});
test('short generic item fields do not suppress a natural opening',async t=>{
 const f=fixture(t);seedList(f.root,OWNER,f.now);
 const store=new ListStore({root:f.root,ownerId:OWNER,now:f.now});store.db.prepare('UPDATE items SET note=?').run('好');store.close();f.due();
 registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListStore(opts)},{now:f.now,composeNotice:async()=>({text:'准备好了，来看看今天待办吧。'})});
 assert.equal((await f.run({slot:'20:00'})).ok,true);
});
test('item enumeration or literal item data in an opening fails unsent, never becomes a duplicate digest',async t=>{
 for(const opening of ['还有这些事情。\n- 合成事项','合成事项还没有完成。','记得明细不能丢。','越快越好，继续加油。'])await t.test(opening,async t=>{
  const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();
  registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListStore(opts)},{now:f.now,composeNotice:async()=>({text:opening})});
  const r=await f.run({slot:'20:00'});assert.equal(r.ok,false);assert(!r.result?.text);
  assert.deepEqual((await f.run({slot:'20:00'})).result,{});
  const store=new ListStore({root:f.root,ownerId:OWNER,now:f.now});try{const row=store.db.prepare('SELECT status,text FROM deliveries').get();assert.equal(row.status,'failed');assert.equal(row.text,'');}finally{store.close();}
 });
});
test('list generation failure is separate from delivery, consumes no second attempt and emits no fixed fallback',async t=>{
 const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();
 registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListStore(opts)},{now:f.now,composeNotice:async()=>{throw Error('private model error');}});
 const r=await f.run({slot:'20:00'});assert(!r.ok);assert(!JSON.stringify(r).includes('private model error'));assert(!r.result?.text);
 assert.deepEqual((await f.run({slot:'20:00'})).result,{});
 const store=new ListStore({root:f.root,ownerId:OWNER,now:f.now});try{assert.equal(store.db.prepare('SELECT status,text FROM deliveries').get().status,'failed');assert.equal(store.db.prepare('SELECT text FROM deliveries').get().text,'');assert.equal(store.get().items.length,1);}finally{store.close();}
});
test('list settings edits or permission revocation while a notice is generating suppress output',async t=>{
 for(const revoke of [false,true])await t.test(String(revoke),async t=>{
  const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();
  registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListStore(opts)},{now:f.now,composeNotice:async()=>{
   if(revoke)f.cfg.channels['kurumi-qq'].accessControl.subjects[0].permissions['qq.notify']=false;
   else{const s=new ListStore({root:f.root,ownerId:OWNER,now:f.now});s.changeSchedule({action:'pause'},{});s.close();}
   return{text:'生成期间设置发生变化'};
  }});
  const r=await f.run({slot:'20:00'});assert(!r.result?.text);
 });
});
test('remote list reads the API snapshot before claim; API failure is not an empty-list announcement',async t=>{
 const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();let unavailable=true;
 registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:opts=>new ListControlStore(opts)},{now:f.now,loadItems:async()=>{if(unavailable)throw Error('network');return[{id:'km:17',title:'网站合成事项',ddl:null,note:'条件保留'}];},composeNotice:async()=>({text:'模型自然说明'})});
 assert.equal((await f.run({slot:'20:00'})).ok,false);unavailable=false;
 const r=await f.run({slot:'20:00'});assert(r.ok);assert(r.result.text.includes('网站合成事项'));assert(r.result.text.includes('条件保留'));assert(!r.result.text.includes('事项：合成事项〔'));
});
test('one-off notice cannot claim early or twice and preserves frozen time/content after model generation',async t=>{
 const f=fixture(t),id=await seedReminder(f.root,OWNER,f.now);let calls=0;
 registerReminderNotice(f.api,{open:()=>new ReminderStore({stateDirectory:f.root+'/state/personal-reminders',now:()=>Math.floor(f.now()/1000)}),composeNotice:async input=>{calls++;input.check();return{text:'模型自然提醒'};}});
 assert.deepEqual((await f.run({id})).result,{});assert.equal(calls,0);f.due();
 const r=await f.run({id});assert(r.ok);assert(r.result.text.includes('合成提醒：起身活动'));assert(r.result.text.includes('2026-11-30 20:00'));
 assert.deepEqual((await f.run({id})).result,{});assert.equal(calls,1);
});
test('one-off generation failure records a definite unsent failure with no automatic retry',async t=>{
 const f=fixture(t),id=await seedReminder(f.root,OWNER,f.now);f.due();
 const open=()=>new ReminderStore({stateDirectory:f.root+'/state/personal-reminders',now:()=>Math.floor(f.now()/1000)});
 registerReminderNotice(f.api,{open,composeNotice:async()=>{throw Error('model unavailable');}});
 assert.equal((await f.run({id})).ok,false);assert.deepEqual((await f.run({id})).result,{});
 const s=open();try{assert.equal(s.getReminder(id).failureCode,'assistant_notice_generation_failed');assert.equal(s.getRetryStatus(id),'exhausted');assert.equal(s.listDueRetryCandidates(Math.floor(f.now()/1000)+10000).length,0);}finally{s.close();}
});

test('failed opening retains exact rules, exception stack and generation reference without public text leakage',async t=>{
 for(const [text,code]of [['一句开场\n一句开场','digest_opening_multiline'],['合成事项还没结束','digest_opening_repeats_items'],['','digest_opening_empty']])await t.test(code,async t=>{
  const f=fixture(t);seedList(f.root,OWNER,f.now);f.due();
  registerDigestNotice(f.api,{root:f.root,ownerId:OWNER,openStore:o=>new ListStore(o)},{now:f.now,composeNotice:async()=>({text,runId:'gen-1',sessionId:'session-1'})});
  const r=await f.run({slot:'20:00'});assert(!r.ok);assert.equal(r.error.message,'assistant_notice_generation_failed');assert(!JSON.stringify(r).includes(text||'gen-1'));
  const store=new ListStore({root:f.root,ownerId:OWNER,now:f.now});try{
   const evidence=JSON.parse(store.db.prepare("SELECT details_json FROM audit WHERE action='notice.generation_failed'").get().details_json);
   assert.equal(evidence.code,'assistant_notice_generation_failed');assert.equal(evidence.error.code,code);assert.match(evidence.error.stack,/notification.js/);
   assert.equal(evidence.stage,'opening_validation');assert.equal(evidence.origin.rule,code);assert.equal(evidence.generation.runId,'gen-1');assert.equal(evidence.generation.sessionId,'session-1');assert.equal(evidence.validation.textLength,text.length);assert.equal(evidence.validation.sha256.length,64);
   assert(!Object.hasOwn(evidence,'text'));assert.equal(store.db.prepare('SELECT text FROM deliveries').get().text,'');
  }finally{store.close();}
 });
});
test('composer preserves provider cause and actual run/session references',async()=>{
 const cause=Object.assign(Error('synthetic transport detail'),{code:'PROVIDER_FAILURE',cause:Error('synthetic socket closed')});
 const session={resolveStorePath:()=>'/fixture',runWithWorkAdmission:async(o,fn)=>fn(new AbortController().signal),getSessionEntryAsync:async()=>({sessionId:'session-generated'})};
 const compose=createAssistantComposer({config:()=>({agents:{entries:{main:{model:'fixture/model'}}}}),runtime:{agent:{session,resolveAgentWorkspaceDir:()=>'/fixture',resolveAgentDir:()=>'/fixture',runEmbeddedAgent:async()=>{throw cause;}}}});
 await assert.rejects(compose({request:{agentId:'main',sessionKey:'fixture'},facts:{},sourceTool:'fixture',instructions:''}),error=>{
  assert.equal(error.code,'assistant_notice_run_failed');assert.equal(error.cause,cause);assert.equal(error.cause.cause.message,'synthetic socket closed');assert.equal(error.generation.sessionId,'session-generated');assert(error.generation.runId);return true;
 });
});
