// Actual domain stores + shared confirmation + domain commits. Temporary SQLite only;
// Cron is a recorder, SMTP uses the repository's loopback mock. No production state.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import * as core from '../../packages/confirmation-core/dist/index.js';
import {ReminderStore} from '../../packages/personal-domains/dist/reminder-store.js';
import {WeatherStore} from '../../packages/personal-domains/dist/store.js';
import {proposeReminderCreate,proposeReminderUpdate,proposeReminderCancellation,commitReminderProposal,getReminderState} from '../../packages/personal-domains/dist/reminders.js';
import {proposeProfileChange,commitProfileChange,getProfileState} from '../../packages/personal-domains/dist/profile.js';
import {proposePlanningChange,commitPlanningProposal,getPlanningState} from '../../packages/personal-domains/dist/planning.js';
import {geoLookupFixture} from '../../packages/personal-domains/dist/test-fixtures.js';
import {registerDomainBackend} from '../../packages/personal-domains/dist/confirmation-backends.js';
import {MailStore} from '../../plugins/kurumi-mail/store.js';
import {createMailService} from '../../plugins/kurumi-mail/service.js';
import {defaultMailPolicy} from '../../plugins/kurumi-mail/policy.js';

function fixture(t) {
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'natural-confirmation-'));
 const owner='100001',sessionKey=`agent:main:kurumi-qq:direct:${owner}`;
 const now=Math.floor(Date.now()/1000),state=path.join(root,'reminders'),weather=path.join(root,'weather');
 const event=(content='确认')=>({channel:'kurumi-qq',accountId:'default',senderId:owner,conversationId:`user:${owner}`,sessionKey,messageId:randomUUID(),timestamp:now*1000,content,isGroup:false});
 const scope=core.scopeFromInboundEvent(event()),context={scope,delivery:{channel:'kurumi-qq',to:`user:${owner}`,accountId:'default'}};
 const reminders=new ReminderStore({stateDirectory:state,now:()=>now}),store=new WeatherStore({stateDirectory:weather,now:()=>now});
 const mailRoot=path.join(root,'mail'),mail=new MailStore({stateDirectory:mailRoot,allowedRecipients:['friend@example.test'],now:()=>now});
 const services=[];
 for(const [id,domain,open]of[
  ['personal-reminder','personal_reminder',()=>new ReminderStore({stateDirectory:state,now:()=>now})],
  ['personal-profile','personal_profile',()=>new WeatherStore({stateDirectory:weather,now:()=>now})],
  ['personal-planning','planning',()=>new WeatherStore({stateDirectory:weather,now:()=>now})],
 ])registerDomainBackend({registerService:s=>services.push(s)},{id,domain,open});
 services.forEach(s=>s.start());
 const off=core.registerConfirmationBackend({id:'kurumi-mail',open:()=>new MailStore({stateDirectory:mailRoot,allowedRecipients:['friend@example.test'],now:()=>now})});
 t.after(()=>{core.clearNaturalConfirmationRequest(sessionKey);off();services.forEach(s=>s.stop());reminders.close();store.close();mail.close();fs.rmSync(root,{recursive:true,force:true});});
 const selection=(p,domain)=>({domain,proposalId:p.proposalId??p.draftId,payloadHash:p.payloadHash});
 const present=(p,domain)=>{
  const e=event('生成测试预览');assert.equal(core.prepareConfirmationPreview(e,selection(p,domain),p.previewText),true);
  core.recordConfirmationDelivery({accountId:'default',conversationId:e.conversationId,sourceMessageId:e.messageId,messageId:randomUUID(),text:p.previewText});
 };
 const confirm=(p,domain,text='确认指定测试提案')=>{
  const e=event(text);core.captureNaturalConfirmationRequest(e);
  const result=core.confirmNaturalProposal(e,selection(p,domain),now*1000);assert.equal(result.ok,true,JSON.stringify(result));return e;
 };
 const input=p=>({proposal_id:p.proposalId,payload_hash:p.payloadHash});
 const localAt=offset=>new Date((now+offset+8*3600)*1000).toISOString().slice(0,16);
 const create=(content='离线测试',offset=3600)=>({schema_version:1,request:{kind:'reminder.create',content,schedule:{timezone:'Asia/Shanghai',local_date_time:localAt(offset)}}});
 const calls=[];
 const scheduler={add:async()=>{calls.push('add');return{jobId:'mock-cron'};},update:async()=>{calls.push('update');},remove:async()=>{calls.push('remove');}};
 return{now,event,scope,context,reminders,store,mail,root,present,confirm,input,create,localAt,calls,scheduler};
}

test('one-off creation, update and cancellation accept natural confirmation and preserve commit idempotency',async t=>{
 const f=fixture(t);const p=proposeReminderCreate(f.reminders,f.create(),f.context);assert.equal(p.status,'pending');
 assert.deepEqual(getReminderState(f.reminders).activeReminders,[]);assert.deepEqual(f.calls,[]);
 f.present(p,'personal_reminder');f.confirm(p,'personal_reminder','确认');
 const created=await commitReminderProposal(f.reminders,f.input(p),f.context,f.scheduler);assert.equal(created.status,'scheduled');
 const repeat=await commitReminderProposal(f.reminders,f.input(p),f.context,f.scheduler);assert.equal(repeat.idempotent,true);assert.deepEqual(f.calls,['add']);
 const u=proposeReminderUpdate(f.reminders,{schema_version:1,request:{kind:'reminder.update',reminder_id:created.reminder.reminderId,content:'更新后的离线测试',schedule:{timezone:'Asia/Shanghai',local_date_time:f.localAt(7200)}}},f.context);
 assert.equal(u.status,'pending');assert.equal(u.confirmationInstruction,'确认');f.present(u,'personal_reminder');f.confirm(u,'personal_reminder');
 assert.equal((await commitReminderProposal(f.reminders,f.input(u),f.context,f.scheduler)).status,'updated');
 const c=proposeReminderCancellation(f.reminders,{schema_version:1,request:{kind:'reminder.cancel',reminder_id:created.reminder.reminderId}},f.context);
 f.present(c,'personal_reminder');f.confirm(c,'personal_reminder','确认取消那条提醒');
 assert.equal((await commitReminderProposal(f.reminders,f.input(c),f.context,f.scheduler)).status,'cancelled');assert.deepEqual(f.calls,['add','update','remove']);
});
test('a newer owner message invalidates an issued but unconsumed natural grant',async t=>{
 const f=fixture(t),p=proposeReminderCreate(f.reminders,f.create(),f.context);f.present(p,'personal_reminder');f.confirm(p,'personal_reminder');
 core.captureNaturalConfirmationRequest(f.event('先别执行'));
 const result=await commitReminderProposal(f.reminders,f.input(p),f.context,f.scheduler);
 assert.equal(result.ok,false);assert.equal(result.error.code,'confirmation_context_mismatch');assert.deepEqual(f.calls,[]);
});
test('Profile and planning share historical storage but list and grant only their own proposal',async t=>{
 const f=fixture(t),trip=proposePlanningChange(f.store,{schema_version:1,request:{kind:'trip.create',destination:{text:'南京'}}},f.scope);
 const profile=await proposeProfileChange(f.store,{lookupPlace:async()=>({...geoLookupFixture,location:[{...geoLookupFixture.location[0],name:'扬中',id:'101190704',lat:'32.2373',lon:'119.8281',adm1:'江苏省',adm2:'镇江市'}]})},
  {schema_version:1,request:{kind:'current_location.set',location:{text:'扬中市'}}},undefined,f.scope);
 assert.equal(trip.status,'pending');assert.equal(profile.status,'pending');f.present(trip,'planning');f.present(profile,'personal_profile');
 const rows=core.listNaturalConfirmations(f.event());assert.equal(rows.filter(p=>p.domain==='planning').length,1);assert.equal(rows.filter(p=>p.domain==='personal_profile').length,1);
 f.confirm(profile,'personal_profile');assert.equal(commitProfileChange(f.store,f.input(profile),f.scope).ok,true);
 assert.equal(commitPlanningProposal(f.store,f.input(trip),f.scope).error.code,'approval_required');
 f.confirm(trip,'planning');assert.equal(commitPlanningProposal(f.store,f.input(trip),f.scope).ok,true);
 assert.equal(getProfileState(f.store).currentLocation.displayName.includes('扬中'),true);assert.equal(getPlanningState(f.store).trips.length,1);
});
test('mail previews freeze recipients/body/attachment metadata; natural approval remains single use',t=>{
 const f=fixture(t),service=createMailService(defaultMailPolicy);
 const draft=service.createDraft(f.mail,{to:'friend@example.test',subject:'离线主题',text:'离线正文'},f.scope,['friend@example.test']);
 assert.equal(draft.status,'needs_confirmation');assert.equal(draft.confirmationInstruction,'确认');assert.match(draft.previewText,/离线正文/);
 assert.match(draft.previewText,/friend@example.test/);f.present(draft,'mail');f.confirm(draft,'mail','可以发送');
 assert.equal(f.mail.consumeApproval({draftId:draft.draftId,scope:f.scope}).ok,true);
 assert.equal(f.mail.consumeApproval({draftId:draft.draftId,scope:f.scope}).code,'grant_replayed');
 assert.equal(core.listNaturalConfirmations(f.event()).some(p=>p.proposalId===draft.draftId),false);
});
test('cancelled mail drafts disappear from the actual shared confirmation candidates',t=>{
 const f=fixture(t),service=createMailService(defaultMailPolicy),draft=service.createDraft(f.mail,{to:'friend@example.test',subject:'取消测试',text:'取消'},f.scope,['friend@example.test']);
 f.present(draft,'mail');assert.equal(f.mail.cancelDraft(draft.draftId),true);
 assert.equal(core.listNaturalConfirmations(f.event()).some(p=>p.proposalId===draft.draftId),false);
});

test('Q10 commits two actual reminders with one message, records two grants and schedules each exactly once',async t=>{
 const f=fixture(t),a=proposeReminderCreate(f.reminders,f.create('Q10甲'),f.context),b=proposeReminderCreate(f.reminders,f.create('Q10乙',7200),f.context);
 for(const p of[a,b])f.present(p,'personal_reminder');
 const e=f.event('这两个都确认。');core.captureNaturalConfirmationRequest(e);
 const choices=[a,b].map(p=>({domain:'personal_reminder',proposalId:p.proposalId,payloadHash:p.payloadHash}));
 assert.equal(core.confirmNaturalProposals(e,choices,f.now*1000).ok,true);
 for(const p of[a,b])assert.equal((await commitReminderProposal(f.reminders,f.input(p),f.context,f.scheduler)).ok,true);
 for(const p of[a,b])assert.equal((await commitReminderProposal(f.reminders,f.input(p),f.context,f.scheduler)).idempotent,true);
 assert.equal(getReminderState(f.reminders).activeReminders.length,2);assert.deepEqual(f.calls,['add','add']);
});
test('explicit cross-domain batch commits reminder and Profile independently, without authorizing an unselected trip',async t=>{
 const f=fixture(t),a=proposeReminderCreate(f.reminders,f.create('多领域甲'),f.context);
 const b=await proposeProfileChange(f.store,{lookupPlace:async()=>({...geoLookupFixture,location:[{...geoLookupFixture.location[0],name:'扬中',id:'101190704',lat:'32.2373',lon:'119.8281',adm1:'江苏省',adm2:'镇江市'}]})},
  {schema_version:1,request:{kind:'current_location.set',location:{text:'扬中市'}}},undefined,f.scope);
 const c=proposePlanningChange(f.store,{schema_version:1,request:{kind:'trip.create',destination:{text:'南京'}}},f.scope);
 for(const [p,domain]of[[a,'personal_reminder'],[b,'personal_profile'],[c,'planning']])f.present(p,domain);
 const e=f.event('这两个都确认。');core.captureNaturalConfirmationRequest(e);
 const result=core.confirmNaturalProposals(e,[{domain:'personal_reminder',proposalId:a.proposalId,payloadHash:a.payloadHash},{domain:'personal_profile',proposalId:b.proposalId,payloadHash:b.payloadHash}],f.now*1000);
 assert.equal(result.ok,true,JSON.stringify(result));
 assert.equal((await commitReminderProposal(f.reminders,f.input(a),f.context,f.scheduler)).ok,true);
 assert.equal(commitProfileChange(f.store,f.input(b),f.scope).ok,true);
 assert.equal(commitPlanningProposal(f.store,f.input(c),f.scope).error.code,'approval_required');
 assert.deepEqual(f.calls,['add']);assert.equal(getPlanningState(f.store).trips.length,0);
});

test('Profile natural-confirmation round trip restores the original location facts in temporary state',async t=>{
 const f=fixture(t),initial=getProfileState(f.store).currentLocation,initialPlace=f.store.getCurrentLocation().place;
 const changed={...geoLookupFixture,location:[{...geoLookupFixture.location[0],name:'扬中',id:'101190704',lat:'32.2373',lon:'119.8281',adm1:'江苏省',adm2:'镇江市'}]};
 for(const [text,geo]of[['扬中市',changed],['天河区',geoLookupFixture]]){
  const p=await proposeProfileChange(f.store,{lookupPlace:async()=>geo},{schema_version:1,request:{kind:'current_location.set',location:{text}}},undefined,f.scope);
  assert.equal(p.status,'pending');f.present(p,'personal_profile');f.confirm(p,'personal_profile');
  assert.equal(commitProfileChange(f.store,f.input(p),f.scope).ok,true);
 }
 const restored=getProfileState(f.store).currentLocation;
 assert.equal(typeof initialPlace.qweatherLocationId,'string');
 assert.equal(f.store.getCurrentLocation().place.qweatherLocationId,initialPlace.qweatherLocationId);
 for(const key of['displayName','countryCode','timezone','precision'])assert.equal(restored[key],initial[key]);
 assert.deepEqual(f.calls,[]);
});

test('a fresh process preserves previews but cannot consume an old unused natural grant',async t=>{
 const {execFile}=await import('node:child_process'),{promisify}=await import('node:util');
 const f=fixture(t),p=proposeReminderCreate(f.reminders,f.create('重启夹具'),f.context);f.present(p,'personal_reminder');f.confirm(p,'personal_reminder');
 const urls=Object.fromEntries(['core','store','reminders'].map((name,i)=>[name,new URL(['../../packages/confirmation-core/dist/index.js','../../packages/personal-domains/dist/reminder-store.js','../../packages/personal-domains/dist/reminders.js'][i],import.meta.url).href]));
 const program=`import assert from 'node:assert/strict';
 import * as core from ${JSON.stringify(urls.core)};import {ReminderStore} from ${JSON.stringify(urls.store)};
 import {commitReminderProposal} from ${JSON.stringify(urls.reminders)};
 const store=new ReminderStore({stateDirectory:${JSON.stringify(path.join(f.root,'reminders'))},now:()=>${f.now}});
 const off=core.registerConfirmationBackend({id:'reopened',open:()=>({natural:store.natural,listInboundConfirmationCandidates:()=>[],recordInboundConfirmation:()=>false,close(){}})});
 try{const event=${JSON.stringify(f.event())},context=${JSON.stringify(f.context)};
  assert.equal(core.listNaturalConfirmations(event).length,1);
  let cronCalls=0;const scheduler={add:async()=>{cronCalls++;return{jobId:'isolated'};}};
  const blocked=await commitReminderProposal(store,${JSON.stringify(f.input(p))},context,scheduler);
  assert.equal(blocked.error.code,'confirmation_context_mismatch');assert.equal(cronCalls,0);
  core.captureNaturalConfirmationRequest(event);
  assert.equal(core.confirmNaturalProposal(event,${JSON.stringify({domain:'personal_reminder',proposalId:p.proposalId,payloadHash:p.payloadHash})},${f.now*1000}).ok,true);
  assert.equal((await commitReminderProposal(store,${JSON.stringify(f.input(p))},context,scheduler)).ok,true);assert.equal(cronCalls,1);
 }finally{off();store.close();}console.log('persistent-preview-and-new-message-passed');`;
 const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',program],{timeout:15000});
 assert.match(stdout,/persistent-preview-and-new-message-passed/);assert.deepEqual(f.calls,[]);
});

test('one delivered batch across reminder and mail databases stays ambiguous and never lends a grant across domains',async t=>{
 const f=fixture(t),reminder=proposeReminderCreate(f.reminders,f.create('跨库同批预览'),f.context);
 const mail=createMailService(defaultMailPolicy).createDraft(f.mail,{to:'friend@example.test',subject:'跨库同批',text:'不发送'},f.scope,['friend@example.test']);
 const source=f.event('同时生成两项'),selections=[{domain:'personal_reminder',proposalId:reminder.proposalId,payloadHash:reminder.payloadHash},{domain:'mail',proposalId:mail.draftId,payloadHash:mail.payloadHash}];
 for(const [i,p]of[reminder,mail].entries())assert.equal(core.prepareConfirmationPreview(source,selections[i],p.previewText),true);
 core.recordConfirmationDelivery({accountId:'default',conversationId:source.conversationId,sourceMessageId:source.messageId,messageId:randomUUID(),text:reminder.previewText+'\n\n'+mail.previewText});
 const presented=core.listNaturalConfirmations(f.event());assert.equal(presented.length,2);assert.equal(presented[0].presentationOrder,presented[1].presentationOrder);
 const bare=f.event('确认');core.captureNaturalConfirmationRequest(bare);
 assert.equal(core.confirmNaturalProposal(bare,selections[0],f.now*1000).code,'confirmation_target_ambiguous');
 f.confirm(reminder,'personal_reminder','只确认创建刚才的提醒，邮件先不要发。');
 assert.equal((await commitReminderProposal(f.reminders,f.input(reminder),f.context,f.scheduler)).ok,true);
 assert.equal(f.mail.consumeApproval({draftId:mail.draftId,scope:f.scope}).code,'approval_required');
});

for(const [label,options,accepted]of[['success',{},1],['authentication-failure',{failAuth:true},0],['DATA-accepted-but-receipt-lost',{dropAfterData:true},1]]){
 test(`natural mail grant and loopback TLS SMTP: ${label}, never auto-resend`,async t=>{
  const {MockSmtpServer,TEST_PASS,TEST_USER}=await import('../../plugins/kurumi-mail/test/helpers/mock-smtp.js');
  const {defaultConnector}=await import('../../plugins/kurumi-mail/smtp.js');
  const f=fixture(t),server=new MockSmtpServer(options),{host,port}=await server.start();t.after(()=>server.stop());
  const ca=fs.readFileSync(new URL('../../plugins/kurumi-mail/test/fixtures/cert.pem',import.meta.url));
  const service=createMailService(defaultMailPolicy),draft=service.createDraft(f.mail,{to:'friend@example.test',subject:'自然确认SMTP隔离',text:'仅发送到本机夹具'},f.scope,['friend@example.test']);
  const ctx={scope:f.scope,config:{host,port,user:TEST_USER,authCode:TEST_PASS,configured:true},allowedRecipients:['friend@example.test'],connector:opts=>defaultConnector({...opts,tlsOptions:{ca,servername:'localhost'}})};
  assert.equal((await service.sendDraft(f.mail,{draftId:draft.draftId},ctx)).code,'approval_required');assert.equal(server.sessions.length,0);
  f.present(draft,'mail');f.confirm(draft,'mail','可以发送');
  const first=await service.sendDraft(f.mail,{draftId:draft.draftId},ctx);
  assert.equal(first.ok,label==='success');assert.equal(server.receivedCount,accepted);
  const sessions=server.sessions.length;assert.equal((await service.sendDraft(f.mail,{draftId:draft.draftId},ctx)).ok,false);
  assert.equal(server.sessions.length,sessions);assert.equal(server.receivedCount,accepted);
 });
}
