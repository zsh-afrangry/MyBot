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
