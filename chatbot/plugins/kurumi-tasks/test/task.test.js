import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import plugin from '../index.js';
function setup(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-tasks-'));const cfg={channels:{'kurumi-qq':{ownerId:'365999865',stateDir:dir}}};const factories=[];plugin.register({config:cfg,registerTool:(factory,options)=>factories.push({factory,...options})});const ctx={agentId:'main',senderIsOwner:true,requesterSenderId:'365999865',messageChannel:'kurumi-qq',sessionKey:'agent:main:kurumi-qq:direct:365999865',assertInvocationCurrent:()=>{},getRuntimeConfig:()=>cfg};return {dir,cfg,ctx,make:c=>factories.find(x=>x.name==='kurumi_task').factory.create(c),check:c=>factories.find(x=>x.name==='kurumi_project_check').factory.create(c)};}
test('Owner task tool refuses other users and sessions before effects',async()=>{const {ctx,make}=setup();for(const patch of [{senderIsOwner:false},{requesterSenderId:'9'},{messageChannel:'qqbot'},{sessionKey:'agent:worker:kurumi-task-123'}])await assert.rejects(make({...ctx,...patch}).execute('x',{action:'start',task:'check'}),/trusted owner/);});
test('24 hex Host run ID accepted but saved run/session binding required',async()=>{const {ctx,make,dir}=setup();const runId='a'.repeat(24),sessionKey='agent:worker:kurumi-task-'+runId;await assert.rejects(make(ctx).execute('x',{action:'status',runId,sessionKey}),/binding mismatch/);fs.writeFileSync(path.join(dir,'task-receipts.jsonl'),JSON.stringify({action:'start',result:{runId,sessionKey:sessionKey.replace(/a$/,'b')}})+'\n');await assert.rejects(make(ctx).execute('x',{action:'cancel',runId,sessionKey}),/binding mismatch/);});
test('Fixed check is absent from main and rejects a different workspace',async()=>{const {ctx,check}=setup();assert.equal(check(ctx),null);await assert.rejects(check({...ctx,agentId:'project-fusion',workspaceDir:'/tmp'}).execute('x',{}),/registry|workspace/);});
