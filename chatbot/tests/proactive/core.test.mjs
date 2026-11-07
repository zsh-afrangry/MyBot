// N3 control/data boundaries: real temporary SQLite, no production, model API or delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WakeStore} from '../../packages/proactive-core/store.js';
import {binding,decision,assertContactTime} from '../../packages/proactive-core/policy.js';
import {createWakeAuthority} from '../../packages/proactive-core/authority.js';
import {createWakeService} from '../../packages/proactive-core/service.js';

const makeBinding=()=>({enabled:true,role:'owner',subjectKey:'qq:user:100001',policyRevision:6,
  agentId:'main',sessionKey:'agent:main:proactive:fixture',sessionId:'fixture-session',generation:0,
  notifyEnabled:true,tools:['fixture_read'],route:{channel:'kurumi-qq',accountId:'default',to:'user:100001'},
  night:{startMinute:23*60,endMinute:7*60,timeZone:'Asia/Shanghai',activityMaxAgeMs:600000}});
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-wake-unit-')),file=root+'/wake.sqlite';
  let current=Date.parse('2026-11-07T04:00:00Z'),config=makeBinding();const stores=[];
  const open=()=>{const s=new WakeStore(file);stores.push(s);return s;},store=open();
  const authority=createWakeAuthority({store,authorize:()=>config,now:()=>current});
  t.after(()=>{for(const s of stores){try{s.close();}catch{}}fs.rmSync(root,{recursive:true,force:true});});
  return {root,file,store,open,authority,get config(){return config;},set config(v){config=v;},now:()=>current,advance:n=>{current+=n;},setTime:n=>{current=n;},
    context:run=>({runId:run.run_id,agentId:run.binding.agentId,sessionKey:run.binding.sessionKey,sessionId:run.binding.sessionId})};
}

test('binding refuses disabled/member/foreign route, invalid identity, time policy and broad tools',()=>{
  for(const patch of [{enabled:false},{role:'member'},{subjectKey:'group:100001'},{policyRevision:0},{sessionId:''},{generation:-1},
    {route:{channel:'kurumi-qq',accountId:'default',to:'user:100009'}},{tools:['exec']},{tools:['message']},{tools:['tool_call']},
    {tools:['fixture_read','fixture_read']},{night:{startMinute:0,endMinute:0,timeZone:'UTC',activityMaxAgeMs:100}}])assert.throws(()=>binding({...makeBinding(),...patch}));
  const b=binding({...makeBinding(),senderIsOwner:true,claimedRunId:'fake'});assert.equal(b.senderIsOwner,undefined);assert.equal(b.claimedRunId,undefined);
});

test('model decisions cannot select identity, recipient, tools or next scheduling',()=>{
  for(const value of [{kind:'notify',text:'x',to:'user:100009'},{kind:'notify',text:'x',senderIsOwner:true},{kind:'silent',text:'secret'},
    {kind:'notify',text:''},{kind:'notify',text:'NO_REPLY'},{kind:'notify',text:'x'.repeat(2001)},{kind:'silent',nextWakeAt:1}])assert.throws(()=>decision(value));
  assert.deepEqual(decision({kind:'silent'}),{kind:'silent'});
});

test('only the actual in-memory handle authorizes; copying or fabricating it fails',t=>{
  const f=fixture(t),{handle,run}=f.authority.begin({eventKey:'one'});
  assert.equal(f.authority.assertCurrent(handle).run_id,run.run_id);
  assert.throws(()=>f.authority.assertCurrent({...handle}),/untrusted_wake/);
  assert.throws(()=>f.authority.assertCurrent({runId:'claimed'}),/untrusted_wake/);
  f.authority.release(handle);assert.throws(()=>f.authority.assertCurrent(handle),/untrusted_wake/);
});

test('tools require exact host run/agent/session incarnation and no impersonated requester',t=>{
  const f=fixture(t),{handle,run}=f.authority.begin({eventKey:'tools'}),ctx=f.context(run);
  assert.equal(f.authority.toolDecision({toolName:'fixture_read',params:{runId:'fake',senderIsOwner:true}},ctx),undefined);
  for(const patch of [{runId:undefined},{runId:'fake'},{agentId:'other'},{sessionKey:'agent:main:other'},
    {sessionId:'replaced'},{sessionId:undefined},{requester:{senderId:'100001',senderIsOwner:true}},{requester:{senderIsOwner:false}},
    {abortSignal:AbortSignal.abort()}])assert.equal(f.authority.toolDecision({toolName:'fixture_read'},{...ctx,...patch}).block,true);
  for(const toolName of ['message','exec','fixture_write','tool_call'])assert.equal(f.authority.toolDecision({toolName},ctx).block,true);
  f.authority.complete(handle,'silent');assert.equal(f.authority.toolDecision({toolName:'fixture_read'},ctx).block,true);
});

test('SQLite admits one scope lease even across separate connections and authority instances',t=>{
  const f=fixture(t),first=f.authority.begin({eventKey:'first'}),other=createWakeAuthority({store:f.open(),authorize:()=>f.config,now:f.now});
  assert.equal(other.begin({eventKey:'second'}).skip,'busy');
  f.authority.complete(first.handle,'silent');assert(other.begin({eventKey:'second'}).handle);
});

test('same event remains consumed after close/reopen; no receipt or event replay',t=>{
  const f=fixture(t),first=f.authority.begin({eventKey:'once'});f.authority.complete(first.handle,'silent');
  const restarted=createWakeAuthority({store:f.open(),authorize:()=>f.config,now:f.now});assert.equal(restarted.begin({eventKey:'once'}).skip,'duplicate');
  assert.equal(restarted.toolDecision({toolName:'fixture_read'},f.context(first.run)).block,true);
});

test('expired model lease becomes interrupted, frees the scope and revokes old tools',t=>{
  const f=fixture(t),old=f.authority.begin({eventKey:'old',timeoutMs:5});f.advance(5);
  assert(f.authority.begin({eventKey:'new'}).handle);assert.equal(f.store.get(old.run.run_id).status,'interrupted');
  assert.equal(f.authority.toolDecision({toolName:'fixture_read'},f.context(old.run)).block,true);
});

test('expired sending lease becomes unknown; recovery does not grant retry or steal live leases',t=>{
  const f=fixture(t),old=f.authority.begin({eventKey:'send',timeoutMs:5});f.authority.prepareDelivery(old.handle,'合成内容');
  assert.equal(f.open().recover(f.now()),0);f.advance(5);assert.equal(f.open().recover(f.now()),1);
  assert.equal(f.store.get(old.run.run_id).status,'unknown');assert.equal(f.authority.begin({eventKey:'send'}).skip,'duplicate');
  assert(f.authority.begin({eventKey:'independent-new'}).handle);
});

test('pause/resume advances epoch, cancels the in-flight decision and does not replay its event',t=>{
  const f=fixture(t),old=f.authority.begin({eventKey:'old'});f.store.invalidate(f.config.subjectKey,{paused:true});
  assert.equal(f.store.get(old.run.run_id).status,'cancelled');assert.throws(()=>f.authority.assertCurrent(old.handle));
  assert.equal(f.authority.begin({eventKey:'later'}).skip,'paused');f.store.invalidate(f.config.subjectKey,{paused:false});
  assert.equal(f.authority.begin({eventKey:'old'}).skip,'duplicate');assert(f.authority.begin({eventKey:'later'}).handle);
});

test('foreground activity invalidates the old decision, updates only its own scope and preserves pause',t=>{
  const f=fixture(t),old=f.authority.begin({eventKey:'foreground'});f.store.invalidate(f.config.subjectKey,{activityAt:f.now()});
  assert.throws(()=>f.authority.assertCurrent(old.handle));assert.equal(f.store.control(f.config.subjectKey).last_activity,f.now());
  assert.equal(f.store.control('qq:user:100009').last_activity,null);
  assert.throws(()=>f.store.invalidate(f.config.subjectKey,{activityAt:f.now()-1}),/activity_clock_reversed/);
});

test('policy revision, session reset, generation, notification and tool revocation fence active runs',t=>{
  const f=fixture(t);let index=0;
  for(const patch of [{policyRevision:7},{sessionId:'new-session'},{generation:1},{notifyEnabled:false},{tools:[]},{enabled:false}]){
    f.config=makeBinding();const old=f.authority.begin({eventKey:'policy-'+index++});f.config={...f.config,...patch};
    assert.equal(f.authority.toolDecision({toolName:'fixture_read'},f.context(old.run)).block,true);
    assert.throws(()=>f.authority.prepareDelivery(old.handle,'x'));f.authority.complete(old.handle,'cancelled');f.authority.release(old.handle);
  }
});

test('a quiet decision is successful without a sender call or persisted conversation text',async t=>{
  const f=fixture(t);let sent=0;const service=createWakeService({authority:f.authority,runModel:async()=>({kind:'silent'}),sendText:async()=>{sent++;}});
  const out=await service.wake({eventKey:'quiet'});assert.equal(out.status,'silent');assert.equal(sent,0);assert.equal(f.authority.activeCount(),0);
  const run=f.store.get(out.runId);assert.equal(run.text_hash,null);assert.equal(run.binding.role,'owner');
});

test('daytime notification uses host-only fixed route and one event key, without a message quota',async t=>{
  const f=fixture(t),sends=[];const service=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:' 合成陪伴文本 '}),
    sendText:async request=>{request.assertCurrent();sends.push(request);return {status:'sent',messageId:'id-'+sends.length};}});
  for(let n=0;n<3;n++)assert.equal((await service.wake({eventKey:'independent-'+n})).status,'delivered');
  assert.equal(sends.length,3);assert(sends.every(x=>x.route.to==='user:100001'&&x.text==='合成陪伴文本'));assert.equal(new Set(sends.map(x=>x.key)).size,3);
});

test('notification disabled rejects before any sender invocation',async t=>{
  const f=fixture(t);f.config.notifyEnabled=false;let sent=0;const out=await createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async()=>{sent++;}}).wake({eventKey:'no-grant'});
  assert.equal(out.status,'failed');assert.equal(out.reason,'wake_notify_not_allowed');assert.equal(sent,0);
});

test('night boundaries require fresh real activity; future/stale timestamps do not count',()=>{
  const p=makeBinding().night,at=Date.parse('2026-11-07T15:00:00Z');
  for(const activity of [null,undefined,at+1,at-p.activityMaxAgeMs-1])assert.throws(()=>assertContactTime(p,at,activity),/night_activity_required/);
  assert.doesNotThrow(()=>assertContactTime(p,at,at-p.activityMaxAgeMs));
  assert.doesNotThrow(()=>assertContactTime(p,Date.parse('2026-11-07T23:00:00Z'),null));
});

test('night without activity sends nothing, while fresh activity still permits silence',async t=>{
  const f=fixture(t);f.setTime(Date.parse('2026-11-07T15:00:00Z'));let sent=0;
  const s=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async r=>{r.assertCurrent();sent++;return {status:'sent',messageId:'1'};}});
  assert.equal((await s.wake({eventKey:'no-activity'})).reason,'night_activity_required');assert.equal(sent,0);
  f.store.invalidate(f.config.subjectKey,{activityAt:f.now()});assert.equal((await s.wake({eventKey:'fresh'})).status,'delivered');
  const silent=createWakeService({authority:f.authority,runModel:async()=>({kind:'silent'}),sendText:async()=>{sent++;}});
  assert.equal((await silent.wake({eventKey:'can-still-stay-quiet'})).status,'silent');assert.equal(sent,1);
});

test('a foreground message while the model awaits invalidates its eventual notification',async t=>{
  const f=fixture(t),entered=deferred(),model=deferred();let sent=0;
  const s=createWakeService({authority:f.authority,runModel:()=>{entered.resolve();return model.promise;},sendText:async()=>{sent++;}});
  const pending=s.wake({eventKey:'preempt'});await entered.promise;f.store.invalidate(f.config.subjectKey,{activityAt:f.now()});model.resolve({kind:'notify',text:'obsolete'});
  assert.equal((await pending).status,'cancelled');assert.equal(sent,0);assert.equal(f.authority.activeCount(),0);
});

test('the final synchronous sender guard catches pause after async transport preparation',async t=>{
  const f=fixture(t),entered=deferred(),ready=deferred();let effects=0;
  const s=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async r=>{entered.resolve();await ready.promise;r.assertCurrent();effects++;return {status:'sent',messageId:'1'};}});
  const pending=s.wake({eventKey:'late-pause'});await entered.promise;f.store.invalidate(f.config.subjectKey,{paused:true});ready.resolve();
  assert.equal((await pending).status,'unknown');assert.equal(effects,0);assert.equal((await s.wake({eventKey:'late-pause'})).reason,'paused');
});

test('revocation during transport preparation is checked again before the real effect',async t=>{
  const f=fixture(t),entered=deferred(),ready=deferred();let effects=0;
  const s=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async r=>{entered.resolve();await ready.promise;r.assertCurrent();effects++;return {status:'sent',messageId:'1'};}});
  const pending=s.wake({eventKey:'late-revoke'});await entered.promise;f.config.policyRevision++;ready.resolve();
  assert.equal((await pending).status,'unknown');assert.equal(effects,0);
});

test('receipt unknown/exception is durable and does not retry the same event after restart',async t=>{
  const f=fixture(t);let sends=0;
  const s=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async r=>{r.assertCurrent();sends++;throw Error('lost receipt; private details');}});
  const first=await s.wake({eventKey:'unknown'});assert.equal(first.status,'unknown');assert.equal(first.reason,'wake_run_failed');
  assert.equal((await s.wake({eventKey:'unknown'})).reason,'duplicate');
  const restarted=createWakeAuthority({store:f.open(),authorize:()=>f.config,now:f.now});assert.equal(restarted.begin({eventKey:'unknown'}).skip,'duplicate');assert.equal(sends,1);
});

test('sent without a platform message ID remains unknown',async t=>{
  const f=fixture(t),s=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async r=>{r.assertCurrent();return {status:'sent'};}});
  assert.equal((await s.wake({eventKey:'no-id'})).status,'unknown');
});

test('an actual receipt is retained when pause happens after the real send',async t=>{
  const f=fixture(t),s=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'x'}),sendText:async r=>{r.assertCurrent();f.store.invalidate(f.config.subjectKey,{paused:true});return {status:'sent',messageId:'accepted'};}});
  const out=await s.wake({eventKey:'already-accepted'});assert.equal(out.status,'delivered');assert.equal(f.store.get(out.runId).receipt.messageId,'accepted');
  assert.equal((await s.wake({eventKey:'future'})).reason,'paused');
});

test('a non-cooperative model times out, releases authority, and cannot use late tools',async t=>{
  const f=fixture(t),late=deferred();let context;
  const s=createWakeService({authority:f.authority,runModel:r=>{context={runId:r.runId,agentId:r.binding.agentId,sessionKey:r.binding.sessionKey,sessionId:r.binding.sessionId};return late.promise;},sendText:async()=>{throw Error('must not send');}});
  const out=await s.wake({eventKey:'timeout',timeoutMs:10});assert.equal(out.reason,'wake_aborted');assert.equal(f.authority.activeCount(),0);
  assert.equal(f.authority.toolDecision({toolName:'fixture_read'},context).block,true);late.resolve({kind:'notify',text:'late'});
});

test('an aborted caller before admission produces no lease or model work',async t=>{
  const f=fixture(t),s=createWakeService({authority:f.authority,runModel:()=>{throw Error('must not run');},sendText:()=>{throw Error('must not send');}});
  await assert.rejects(s.wake({eventKey:'cancel-before-start',signal:AbortSignal.abort()}));assert.equal(f.authority.activeCount(),0);
});
