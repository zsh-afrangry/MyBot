// Complete autonomous decisions against real temporary SQLite; no host/network.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';
import {WakeStore} from '../../packages/proactive-core/store.js';
import {createProactiveEngine} from '../../packages/proactive-core/engine.js';
import {createRecentContext} from '../../packages/proactive-core/context.js';
import {createWakeScheduler} from '../../packages/proactive-core/scheduler.js';
import {createSelfRecords} from '../../packages/proactive-core/records.js';
const deferred=()=>{let resolve;return {promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
function fixture(t) {
  const root=fs.mkdtempSync(os.tmpdir()+'/kurumi-proactive-engine-'),store=new WakeStore(root+'/state.sqlite');
  let at=Date.parse('2026-11-09T04:00:00Z'),generation=0,model=async()=>({decision:{kind:'silent'}}),sender=async()=>({status:'sent',messageId:String(++sends)}),sends=0;
  const config={enabled:true,role:'owner',subjectKey:'qq:user:100001',policyRevision:6,agentId:'main',sessionKey:'agent:main:kurumi-proactive:100001',sessionId:'test-session',
    generation:0,notifyEnabled:true,tools:['kurumi_proactive'],route:{channel:'kurumi-qq',accountId:'default',to:'user:100001'},night:{startMinute:1380,endMinute:480,timeZone:'Asia/Shanghai',activityMaxAgeMs:900000}};
  const events=[],recent=createRecentContext({ownerId:'100001',now:()=>at}),engine=createProactiveEngine({store,scope:config.subjectKey,authorize:()=>({...config,generation}),
    getMemory:()=>({generation,revision:generation,facts:[{id:'abcdef123456',text:'合成兴趣',updatedAt:'2026-11-09T00:00:00Z'}],recentSummaries:[]}),recent,
    runHost:r=>model(r),query:async(kind,{verify})=>{verify();return {kind,verified:'synthetic'};},sendText:r=>sender(r),
    catalog:[{kind:'weather',available:true}],now:()=>at,emit:(...args)=>events.push(args)});
  const ctx=r=>({runId:r.runId,agentId:r.binding.agentId,sessionKey:r.binding.sessionKey,sessionId:r.binding.sessionId});
  t.after(()=>{store.close();fs.rmSync(root,{recursive:true,force:true});});
  return {root,store,engine,config,recent,events,ctx,now:()=>at,advance:n=>at+=n,setTime:n=>at=n,setGeneration:n=>generation=n,
    model:fn=>model=fn,sender:fn=>sender=fn,sends:()=>sends,wake:(eventKey='event')=>engine.wake({eventKey,timeoutMs:1000})};
}
test('one opportunity can query, remember, speak twice and finish; receipts remain independent',async t=>{
  const f=fixture(t);f.model(async r=>{
    const query=await f.engine.execute(f.ctx(r),'q',{action:'query',kind:'weather'});
    const note=await f.engine.execute(f.ctx(r),'r',{action:'remember',record:{kind:'interest',text:'合成经验',sources:[query.sourceId],ttlDays:30}});
    assert.equal(note.version,1);
    for(const id of ['first','followup'])assert.equal((await f.engine.execute(f.ctx(r),id,{action:'notify',text:'合成追加'})).status,'delivered');
    return {decision:{kind:'done'},usage:{total:25}};
  });
  const result=await f.wake();assert.equal(result.status,'completed');assert.equal(f.sends(),2);assert.equal(result.messages.length,2);
  assert(result.messages.every(m=>m.status==='delivered'));assert.equal(f.engine.records.list(0).length,1);
  assert.equal((await f.wake()).reason,'duplicate');assert.equal(f.sends(),2);
  assert(!JSON.stringify(f.events).includes('合成经验'));assert(!JSON.stringify(f.events).includes('合成追加'));
});
test('silent success does not fabricate notes, messages or progress',async t=>{
  const f=fixture(t),result=await f.wake();assert.equal(result.status,'silent');assert.equal(f.sends(),0);assert.deepEqual(result.messages,[]);assert.deepEqual(f.engine.records.list(0),[]);
});
test('public exploration provenance comes from actual allowed hook results and can support self records',async t=>{
  const f=fixture(t);f.config.tools.push('web_fetch');f.model(async r=>{
    assert.deepEqual((await f.engine.execute(f.ctx(r),'sources0',{action:'sources'})).sources,[]);
    f.engine.observeTool({toolName:'web_fetch',toolCallId:'observed',result:{content:[{type:'text',text:'synthetic public document'}]}},{...f.ctx(r),toolCallId:'observed'});
    f.engine.observeTool({toolName:'exec',toolCallId:'forbidden',result:'fake'},f.ctx(r));
    const sources=(await f.engine.execute(f.ctx(r),'sources1',{action:'sources'})).sources;assert.equal(sources.length,1);
    assert.equal(sources[0].tool,'web_fetch');
    await f.engine.execute(f.ctx(r),'remember',{action:'remember',record:{kind:'interest',text:'synthetic interest',sources:[sources[0].sourceId],ttlDays:30}});
    return {decision:{kind:'silent'}};
  });assert.equal((await f.wake()).status,'silent');assert.equal(f.engine.records.list(0).length,1);
});
test('forged source, recipient, action, write query and scheduling are rejected at execution',async t=>{
  const f=fixture(t);f.model(async r=>{
    for(const args of [{action:'remember',record:{kind:'interest',text:'x',sources:['invented'],ttlDays:30}},
      {action:'notify',text:'x',to:'user:100009'},{action:'query',kind:'bills'},{action:'exec',text:'ls'},{action:'notify',text:'x',nextWakeAt:1}])
      await assert.rejects(()=>f.engine.execute(f.ctx(r),'bad',args));
    return {decision:{kind:'silent'}};
  });assert.equal((await f.wake()).status,'silent');assert.equal(f.sends(),0);
});
test('a forged actual host context cannot use a real running opportunity',async t=>{
  const f=fixture(t);f.model(async r=>{
    for(const patch of [{runId:'fake'},{sessionId:'fake'},{agentId:'worker'},{requester:{senderIsOwner:true}}])
      await assert.rejects(()=>f.engine.execute({...f.ctx(r),...patch},'bad',{action:'notify',text:'x'}));
    return {decision:{kind:'silent'}};
  });await f.wake();assert.equal(f.sends(),0);
});
test('each message is idempotent by actual call ID, unknown is never resent, distinct speech is allowed',async t=>{
  const f=fixture(t);f.sender(async r=>{r.assertCurrent();throw Error('uncertain platform');});let effects=0;
  f.sender(async r=>{r.assertCurrent();effects++;return {status:'unknown'};});
  f.model(async r=>{
    const send=()=>f.engine.execute(f.ctx(r),'same',{action:'notify',text:'合成'});
    assert.equal((await send()).status,'unknown');assert.equal((await send()).duplicate,true);
    await assert.rejects(()=>f.engine.execute(f.ctx(r),'same',{action:'notify',text:'不同内容'}));
    await f.engine.execute(f.ctx(r),'independent-choice',{action:'notify',text:'自主新发言'});return {decision:{kind:'done'}};
  });const result=await f.wake();assert.equal(effects,2);assert(result.messages.every(m=>m.status==='unknown'));
});
test('pause between transport preparation and effect fences all messages and survives reopening',async t=>{
  const f=fixture(t);let effects=0;
  f.sender(async r=>{f.engine.authority.invalidate(f.config.subjectKey,{paused:true});r.assertCurrent();effects++;return {status:'sent',messageId:'fake'};});
  f.model(async r=>{await f.engine.execute(f.ctx(r),'n',{action:'notify',text:'x'});return {decision:{kind:'done'}};});
  const result=await f.wake();assert.equal(result.status,'cancelled');assert.equal(result.messages[0].status,'unknown');assert.equal(effects,0);
  const other=new WakeStore(f.root+'/state.sqlite');try{assert.equal(other.control(f.config.subjectKey).paused,1);}finally{other.close();}
  assert.equal((await f.wake('later')).reason,'paused');
});
test('late factual receipts converge after cancellation and capability release without granting another send',async t=>{
  const f=fixture(t),dispatched=deferred(),receipt=deferred();
  f.sender(async r=>{r.assertCurrent();dispatched.resolve();return receipt.promise;});
  f.model(async r=>{await f.engine.execute(f.ctx(r),'late',{action:'notify',text:'x'});return {decision:{kind:'done'}};});
  const work=f.wake();await dispatched.promise;f.engine.authority.invalidate(f.config.subjectKey,{paused:true});
  const result=await work;assert.equal(result.status,'cancelled');assert.equal(f.engine.authority.activeCount(),0);
  f.recent.clear();
  receipt.resolve({status:'sent',messageId:'real-late'});await new Promise(r=>setTimeout(r,10));
  assert.equal(f.store.messages(result.runId)[0].status,'delivered');assert.equal(f.store.get(result.runId).status,'cancelled');
  assert.deepEqual(f.recent.read(0),[]);
});
test('forget generation fences live tools, clears recent projection and excludes old self notes',async t=>{
  const f=fixture(t);
  f.model(async r=>{
    await f.engine.execute(f.ctx(r),'note',{action:'remember',record:{kind:'experience',text:'x',sources:[r.context.memory.facts[0].sourceId],ttlDays:30}});
    f.setGeneration(1);await assert.rejects(()=>f.engine.execute(f.ctx(r),'n',{action:'notify',text:'x'}),/wake_policy_changed/);
    return {decision:{kind:'silent'}};
  });assert.equal((await f.wake()).status,'failed');assert.equal(f.engine.records.list(1).length,0);assert.equal(f.engine.records.list(1,{includeInactive:true}).length,1);
});
test('night without activity refuses speech but still permits a quiet internal decision',async t=>{
  const f=fixture(t);f.setTime(Date.parse('2026-11-09T17:00:00Z'));f.model(async r=>{
    await assert.rejects(()=>f.engine.execute(f.ctx(r),'n',{action:'notify',text:'x'}),/night_activity_required/);return {decision:{kind:'silent'}};
  });assert.equal((await f.wake()).status,'silent');assert.equal(f.sends(),0);
});
test('record CAS, expiry, owner correction, deletion tombstone and scope isolation',t=>{
  const f=fixture(t),records=f.engine.records,proof=new Set(['actual']);
  const first=records.put({kind:'intention',text:'x',sources:['actual'],ttlDays:1},{generation:0,knownSources:proof});
  assert.throws(()=>records.put({id:first.id,expectedVersion:8,kind:'intention',text:'x',sources:['actual'],ttlDays:1},{generation:0,knownSources:proof}),/wake_record_conflict/);
  assert.equal(createSelfRecords({store:f.store,scope:'qq:user:100009',now:f.now}).list(0).length,0);
  const corrected=records.put({id:first.id,expectedVersion:1,kind:'experience',text:'corrected',sources:['actual'],ttlDays:1},{generation:1,knownSources:proof,owner:true});
  assert.equal(corrected.version,2);f.advance(86400000);assert.equal(records.list(1).length,0);
  assert.equal(records.remove({id:first.id,expectedVersion:2}).deleted,true);assert.equal(records.list(1,{includeInactive:true}).length,0);
  assert.equal(f.store.db.prepare('SELECT text,sources FROM proactive_record WHERE id=?').get(first.id).text,null);
});
test('message leases recover unknown without replaying a persisted event',t=>{
  const f=fixture(t),claim=f.engine.authority.begin({eventKey:'interrupted',timeoutMs:100});
  f.engine.authority.prepareMessage(claim.handle,'call','x');f.advance(100);f.store.recover(f.now());
  assert.equal(f.store.messages(claim.run.run_id)[0].status,'unknown');assert.equal(f.engine.authority.begin({eventKey:'interrupted'}).skip,'duplicate');
  f.engine.authority.release(claim.handle);
});
test('scheduler aligns to a future wall-clock slot, skips overlap and does not catch up',async()=>{
  let at=120001,scheduled=[],effects=0;const wait=deferred();
  const scheduler=createWakeScheduler({intervalMs:60000,now:()=>at,setTimer:(fn,delay)=>{scheduled.push({fn,delay});return 1;},clearTimer(){},wake:async({eventKey})=>{effects++;assert.equal(eventKey,'fixed:60000:3');await wait.promise;return {status:'silent'};}});
  scheduler.start();assert.equal(effects,0);assert.equal(scheduled[0].delay,59999);
  at=180000;scheduled[0].fn();assert.equal(effects,1);assert.equal((await scheduler.tick()).reason,'scheduler_busy');
  at=580000;wait.resolve();await new Promise(r=>setImmediate(r));assert.equal(effects,1);scheduler.stop();
  assert.throws(()=>createWakeScheduler({intervalMs:5,wake(){}}));
});
test('recent projection accepts only correlated real messages, expires and is cleared on forget/reset',()=>{
  let at=100000;const recent=createRecentContext({ownerId:'100001',now:()=>at,maxAgeMs:1000});
  const meta={origin:'onebot',subjectId:'100001',agentId:'main',sessionKey:'agent:main:kurumi-qq:direct:100001',postType:'message',messageId:'one',occurredAt:at};
  recent.accepted({...meta,origin:'synthetic'});recent.receive({MessageSid:'one'},'fake');assert.equal(recent.read(0).length,0);
  recent.accepted(meta);recent.receive({MessageSid:'one'},'hello token=synthetic-secret');assert(!JSON.stringify(recent.read(0)).includes('synthetic-secret'));
  assert.equal(recent.read(1).length,0);recent.accepted({...meta,messageId:'two'});recent.receive({MessageSid:'two'},'hello');
  at+=1000;assert.equal(recent.read(1).length,0);recent.clear();
});
test('owner pagination reaches expired records beyond the automatic context limit',t=>{
  const f=fixture(t),records=f.engine.records,proof=new Set(['actual']);
  for(let n=0;n<205;n++) {
    records.put({kind:'experience',text:'synthetic-'+n,sources:['actual'],ttlDays:1},{generation:0,knownSources:proof});
    f.advance(86400001);
  }
  const ids=new Set();let offset=0;
  do {const page=records.page(1,{offset});assert.equal(page.total,205);assert(page.records.every(r=>!r.active));
    for(const row of page.records)ids.add(row.id);offset=page.nextOffset;
  }while(offset!==null);
  assert.equal(ids.size,205);assert.throws(()=>records.page(1,{offset:-1}),/invalid_time/);
});
