// Real inbound handler and temporary SQLite; synthetic transport/model metadata
// only, no production reads/writes, external model/API, QQ or service operations.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {WakeStore} from '../../packages/proactive-core/store.js';
import {createWakeAuthority} from '../../packages/proactive-core/authority.js';
import {createWakeService} from '../../packages/proactive-core/service.js';
import {createWakeLifecycle} from '../../packages/proactive-core/lifecycle.js';
import {handleInbound} from '../../plugins/kurumi-qq/src/inbound.js';
import {withAccess,memberRow} from '../access-control/fixtures.mjs';

const owner='100001',key='agent:main:kurumi-qq:direct:'+owner;
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};
function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-wake-lifecycle-'));
  let now=Date.parse('2026-11-09T04:00:00Z');
  const store=new WakeStore(root+'/wake.sqlite');
  const binding={enabled:true,role:'owner',subjectKey:'qq:user:'+owner,policyRevision:1,
    agentId:'main',sessionKey:key,sessionId:'isolated-session',generation:0,notifyEnabled:true,tools:[],
    route:{channel:'kurumi-qq',accountId:'default',to:'user:'+owner},
    night:{startMinute:1380,endMinute:420,timeZone:'Asia/Shanghai',activityMaxAgeMs:600000}};
  const authority=createWakeAuthority({store,authorize:()=>binding,now:()=>now});
  const lifecycle=createWakeLifecycle({authority,ownerId:owner,activityMaxAgeMs:300000,now:()=>now});
  const message=(patch={})=>({origin:'onebot',subjectId:owner,agentId:'main',sessionKey:key,messageId:'123',postType:'message',occurredAt:now,...patch});
  const cfg=withAccess({channels:{'kurumi-qq':{enabled:true,ownerId:owner,stateDir:root,mediaRoot:root,httpUrl:'http://127.0.0.1:1',wsUrl:'ws://127.0.0.1:2'}}},owner);
  const event=(patch={})=>({post_type:'message',message_type:'private',self_id:100002,user_id:Number(owner),
    message_id:123,time:now/1000,message:[{type:'text',data:{text:'synthetic private text'}}],...patch});
  const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:key})},
    session:{resolveStorePath:()=>root+'/sessions.json',recordInboundSession:async()=>{}},
    reply:{finalizeInboundContext:x=>x,dispatchReplyWithBufferedBlockDispatcher:async()=>{}}}};
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,store,binding,authority,lifecycle,message,cfg,event,runtime,
    now:()=>now,advance:ms=>{now+=ms;},control:()=>store.control(binding.subjectKey),
    inbound:(patch={})=>handleInbound({cfg,runtime,event:event(),selfId:'100002',onAcceptedInbound:lifecycle.acceptInbound,...patch})};
}

test('lifecycle requires explicit valid owner and activity freshness, with no production defaults',()=>{
  for(const options of [{},{ownerId:'x',activityMaxAgeMs:1},{ownerId:owner,activityMaxAgeMs:0},
    {ownerId:owner,activityMaxAgeMs:1,authority:{}}])assert.throws(()=>createWakeLifecycle(options),/invalid_wake_lifecycle/);
});

test('accepted owner metadata immediately aborts model work and fences its late result',async t=>{
  const f=fixture(t),entered=deferred(),late=deferred();let signal,sends=0;
  const service=createWakeService({authority:f.authority,runModel:r=>{signal=r.signal;entered.resolve();return late.promise;},sendText:async()=>{sends++;}});
  const pending=service.wake({eventKey:'foreground'});await entered.promise;
  assert(f.lifecycle.acceptInbound(f.message()));assert(signal.aborted);
  const result=await pending;assert.equal(result.status,'cancelled');assert.equal(f.authority.activeCount(),0);
  assert.equal(f.control().last_activity,f.now());late.resolve({kind:'notify',text:'obsolete'});await Promise.resolve();assert.equal(sends,0);
});

test('member, synthetic, wrong route or malformed metadata cannot affect owner control',t=>{
  const f=fixture(t),before=f.control();
  for(const patch of [{origin:'synthetic'},{origin:undefined},{subjectId:'100009'},{agentId:'worker'},
    {sessionKey:key+':other'},{messageId:''},{messageId:123}])assert.equal(f.lifecycle.acceptInbound(f.message(patch)),false);
  assert.deepEqual(f.control(),before);
});

test('stale, missing, future or invalid platform time still preempts without creating online evidence',t=>{
  const f=fixture(t);let index=0;
  for(const occurredAt of [null,undefined,f.now()-300001,f.now()+1,NaN,0.5]){
    const {handle,run}=f.authority.begin({eventKey:'time-'+index++});
    assert(f.lifecycle.acceptInbound(f.message({occurredAt})));
    assert(handle.signal.aborted);assert.equal(f.store.get(run.run_id).status,'cancelled');assert.equal(f.control().last_activity,null);
    f.authority.release(handle);
  }
});

test('legitimate out-of-order messages preempt without rewinding the newest activity',t=>{
  const f=fixture(t);f.lifecycle.acceptInbound(f.message());const before=f.control();
  const {handle}=f.authority.begin({eventKey:'out-of-order'});
  f.advance(1000);assert(f.lifecycle.acceptInbound(f.message({occurredAt:before.last_activity-1000})));
  assert.equal(f.control().last_activity,before.last_activity);assert.equal(f.control().epoch,before.epoch+1);
  assert(handle.signal.aborted);f.authority.release(handle);
});

test('offline-file notices invalidate decisions but do not count as current human activity',t=>{
  const f=fixture(t);assert(f.lifecycle.acceptInbound(f.message({postType:'notice'})));
  assert.equal(f.control().last_activity,null);assert.equal(f.control().epoch,1);
});

test('reset/end hooks only invalidate the owner session, preserve pause and do not mark activity',t=>{
  const f=fixture(t),hooks={};f.lifecycle.attach({on:(name,fn)=>{hooks[name]=fn;}});
  f.authority.invalidate(f.binding.subjectKey,{paused:true});const before=f.control();
  for(const fn of Object.values(hooks)){
    assert.equal(fn({sessionKey:key+':other'},{}),false);
    assert.equal(fn({sessionKey:key},{agentId:'worker'}),false);
    assert.equal(fn({sessionKey:key},{sessionKey:'other'}),false);
  }
  assert.deepEqual(f.control(),before);
  assert(hooks.before_reset({sessionKey:key,reason:'new'},{}));assert(hooks.session_end({}, {sessionKey:key,agentId:'main'}));
  assert.equal(f.control().paused,1);assert.equal(f.control().last_activity,null);assert.equal(f.control().epoch,before.epoch+2);
});

test('metadata-only plugin discovery does not install lifecycle hooks',t=>{
  const f=fixture(t);f.lifecycle.attach({registrationMode:'discovery',on:()=>{throw Error('must not register');}});
});

test('actual inbound observer runs before attachment I/O, carries no body and ignores replay',async t=>{
  const f=fixture(t),{handle}=f.authority.begin({eventKey:'incoming'});let observed,stages=0;
  const event=f.event({message:[{type:'text',data:{text:'private text must stay out'}},{type:'file',data:{name:'private.pdf',file_id:'file'}}]});
  const args={event,onAcceptedInbound:metadata=>{observed=metadata;assert.equal(stages,0);f.lifecycle.acceptInbound(metadata);},
    stageFile:async()=>{assert(handle.signal.aborted);stages++;return {id:'synthetic-document',pages:1};}};
  assert((await f.inbound(args)).ok);const after=f.control();assert((await f.inbound(args)).duplicate);
  assert.deepEqual(f.control(),after);assert.equal(stages,1);
  assert.deepEqual(Object.keys(observed).sort(),['agentId','messageId','occurredAt','origin','postType','sessionKey','subjectId']);
  assert(!JSON.stringify(observed).includes('private'));f.authority.release(handle);
});

test('actual synthetic ingress cannot provide activity, while rejected transport/route never calls observer',async t=>{
  const f=fixture(t);assert((await f.inbound({ingressKind:'synthetic'})).ok);assert.equal(f.control().epoch,0);
  let calls=0;const onAcceptedInbound=()=>{calls++;};
  for(const patch of [{message_type:'group'},{user_id:100009},{self_id:999999}])assert((await f.inbound({event:f.event(patch),onAcceptedInbound})).ignored);
  f.runtime.channel.routing.resolveAgentRoute=()=>({agentId:'worker',sessionKey:key});
  await assert.rejects(f.inbound({event:f.event({message_id:124}),onAcceptedInbound}),/identity_route_mismatch/);assert.equal(calls,0);
});

test('accepted member traffic has no owner observation callback',async t=>{
  const f=fixture(t),member='100009';f.cfg.channels['kurumi-qq'].accessControl.subjects.push(memberRow(member));
  const workspace=f.root+'/users/'+member+'/workspace';fs.mkdirSync(workspace,{recursive:true});
  fs.writeFileSync(workspace+'/AGENTS.md','kurumi-isolated-member-v1');
  f.cfg.agents={entries:{main:{workspace:f.root+'/workspace'},['qq-user-'+member]:{workspace}}};
  f.runtime.channel.routing.resolveAgentRoute=()=>({agentId:'qq-user-'+member,sessionKey:'agent:qq-user-'+member+':kurumi-qq:direct:'+member});
  let calls=0;assert((await f.inbound({event:f.event({user_id:Number(member)}),onAcceptedInbound:()=>{calls++;}})).ok);
  assert.equal(calls,0);assert.equal(f.control().epoch,0);
});

test('observer persistence failure is propagated before model execution',async t=>{
  const f=fixture(t);let models=0;f.runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher=async()=>{models++;};
  await assert.rejects(f.inbound({onAcceptedInbound:()=>{throw Error('synthetic persistence unavailable');}}),/persistence unavailable/);assert.equal(models,0);
});

test('cancelling transport preparation fences physical I/O and preserves unknown semantics',async t=>{
  const f=fixture(t),entered=deferred(),ready=deferred();let effects=0;
  const service=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'synthetic'}),
    sendText:async r=>{entered.resolve();await ready.promise;r.assertCurrent();effects++;return {status:'sent',messageId:'must-not-send'};}});
  const pending=service.wake({eventKey:'preparation'});await entered.promise;f.lifecycle.acceptInbound(f.message());
  const result=await pending;assert.equal(result.status,'unknown');ready.resolve();await Promise.resolve();assert.equal(effects,0);
  assert.equal((await service.wake({eventKey:'preparation'})).reason,'duplicate');
});

test('a real late receipt after cancellation/release is reconciled without enabling replay',async t=>{
  const f=fixture(t),sent=deferred(),receipt=deferred();let sends=0;
  const service=createWakeService({authority:f.authority,runModel:async()=>({kind:'notify',text:'synthetic'}),
    sendText:async r=>{r.assertCurrent();sends++;sent.resolve();return receipt.promise;}});
  const pending=service.wake({eventKey:'late-receipt'});await sent.promise;f.lifecycle.acceptInbound(f.message());
  const result=await pending;assert.equal(result.status,'unknown');assert.equal(f.authority.activeCount(),0);
  receipt.resolve({status:'sent',messageId:'platform-receipt'});await new Promise(r=>setImmediate(r));
  assert.equal(f.store.get(result.runId).status,'delivered');assert.equal(f.store.get(result.runId).receipt.messageId,'platform-receipt');
  assert.equal((await service.wake({eventKey:'late-receipt'})).reason,'duplicate');assert.equal(sends,1);
});
