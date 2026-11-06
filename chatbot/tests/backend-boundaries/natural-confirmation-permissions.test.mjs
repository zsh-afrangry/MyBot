// Actual registered v2 factory and capability checks; synthetic policy only.
import test from 'node:test';
import assert from 'node:assert/strict';
import entry from '../../plugins/personal-confirmation/dist/index.js';
import {ownerPolicy,memberRow,context} from '../access-control/fixtures.mjs';

function fixture() {
 const owner='100001',policy=ownerPolicy(owner);policy.subjects.push(memberRow());
 const cfg={channels:{'kurumi-qq':{ownerId:owner,accessControl:policy}}};
 let factory;
 entry.register({config:cfg,on(){},registerService(){},registerTool(f){factory=f;},logger:{info(){},warn(){}}});
 return {cfg,policy,tool:(row=policy.subjects[0])=>factory.create({...context(row),getRuntimeConfig:()=>cfg})};
}
const target=domain=>({domain,proposalId:'12345678-1234-4234-8234-123456789abc',payloadHash:'a'.repeat(64)});
test('batch preflights each target permission, so a reminder outer domain cannot grant mail permission',async()=>{
 const f=fixture();f.policy.subjects[0].permissions['mail.send']=false;
 await assert.rejects(()=>f.tool().execute('call',{action:'confirm',domain:'personal_reminder',targets:[target('personal_reminder'),target('mail')]}),{code:'capability_not_allowed'});
});
test('missing, aliased and unknown batch domains continue to fail closed',async()=>{
 const f=fixture();
 for(const domain of[undefined,'reminder','reminders','weather_travel','unknown']){
  await assert.rejects(()=>f.tool().execute('call',{action:'list',domain}),{code:'unmapped_tool'});
 }
 await assert.rejects(()=>f.tool().execute('call',{action:'confirm',domain:'personal_reminder',targets:[target('unknown')]}),{code:'unmapped_tool'});
});
test('member identity cannot inherit owner confirmation, even when the outer domain is valid',async()=>{
 const f=fixture();await assert.rejects(()=>f.tool(f.policy.subjects[1]).execute('call',{action:'confirm',domain:'personal_reminder',targets:[target('personal_reminder')]}),{code:'capability_not_allowed'});
});
test('tool discovery includes exact domains, re-preview instruction and bounded multi-target schema',async()=>{
 const f=fixture(),tool=f.tool();assert(tool.parameters.required.includes('domain'));
 assert.deepEqual(tool.parameters.properties.domain.enum,['personal_reminder','personal_profile','planning','mail','coding']);
 assert.equal(tool.parameters.properties.targets.maxItems,16);assert.match(tool.description,/MUST use action=preview/);
 const result=await tool.execute('unbound',{action:'confirm',domain:'personal_reminder',targets:[target('personal_reminder')]});
 assert.equal(result.details.code,'confirmation_not_current');
});
