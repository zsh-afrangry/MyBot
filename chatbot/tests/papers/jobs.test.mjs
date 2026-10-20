import {withAccess} from '../access-control/fixtures.mjs';
// Offline lifecycle tests: injected worker, no real model or delivery. Contract: docs/22.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {PaperService,normalizePages} from '../../plugins/kurumi-papers/service.js';
import {resolveProfile} from '../../plugins/kurumi-papers/profiles.js';
import {createPaperPlugin} from '../../plugins/kurumi-papers/index.js';
import {pdf} from './fixtures.mjs';
const inspect=async()=>({pages:1});
async function setup(t,deps={}) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-jobs-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runner=async({work,signal})=>{signal.throwIfAborted();const files={};for(const kind of ['mono','dual']){files[kind]=path.join(work,kind+'.pdf');fs.writeFileSync(files[kind],pdf(kind));}return {...files,usage:{requests:1}};};
  const service=new PaperService({root,liveTranslationEnabled:true},{runner,sendFile:async()=>({status:'platform_accepted'}),inspect,...deps});
  service.start();t.after(()=>service.stop());
  const doc=await service.documents.add(pdf(),{filename:'input.pdf'},{inspect});return {service,doc,root};
}
async function terminal(service,id) {for(let i=0;i<200;i++){const job=service.get(id);if(!['queued','running'].includes(job.status))return job;await new Promise(r=>setTimeout(r,5));}throw Error('test job timed out');}
test('Explicit provider/model/effort; pages cannot silently truncate or execute',()=>{
  assert.equal(resolveProfile().model,'gpt-6.1-sol');assert.equal(resolveProfile().effort,'high');
  assert.equal(resolveProfile({effort:'MAX'}).effort,'max');
  assert.equal(resolveProfile({provider:'deepseek',effort:'MAX'}).effort,'max');
  for(const args of [{provider:'grok'},{model:'gpt-5.6-sol'},{channel:'other'},{effort:'ultra'}]) assert.throws(()=>resolveProfile(args));
  assert.equal(normalizePages('3,1-2,2',8,3),'1,2,3');
  for(const range of ['0','3-1','1;curl x','1-10000'])assert.throws(()=>normalizePages(range,8,3));
  assert.throws(()=>normalizePages(null,31,30));
});
test('DeepSeek jobs persist an explicit profile and never mutate default GPT settings',async t=>{
  let received;
  const {service,doc}=await setup(t,{runner:async request=>{
    received=request.profile;const files={};for(const kind of ['mono','dual']){files[kind]=path.join(request.work,kind+'.pdf');fs.writeFileSync(files[kind],pdf(kind));}return files;
  }});
  const job=service.submit({documentId:doc.id,provider:'deepseek',delivery:'none'},{key:'deepseek'});
  assert.equal((await terminal(service,job.id)).status,'succeeded');
  assert.deepEqual(received,resolveProfile({provider:'deepseek'}));
  assert.deepEqual(service.get(job.id).profile,received);
  assert.throws(()=>service.submit({documentId:doc.id,delivery:'none'},{key:'deepseek'}),/different/);
  assert.equal(resolveProfile().provider,'openai');assert.equal(resolveProfile().effort,'high');
});
test('Lifecycle, immutable invocation identity and separate output/delivery state',async t=>{
  let files=0;const {service,doc,root}=await setup(t,{sendFile:async()=>{files++;return{status:'platform_accepted'};}});
  const args={documentId:doc.id,pages:'1'},job=service.submit(args,{key:'first'});
  assert.equal(service.submit(args,{key:'first'}).id,job.id);
  assert.throws(()=>service.submit({...args,pages:undefined},{key:'first'}),/different/);
  const result=await terminal(service,job.id);assert.equal(result.status,'succeeded');
  // Success is saved before asynchronous delivery; wait for the independent receipt.
  while(service.active)await new Promise(r=>setTimeout(r,5));
  assert.equal(service.get(job.id).delivery.status,'platform_accepted');assert.equal(files,1);
  assert(service.documents.get(result.artifacts.dual).content.subarray(0,8).includes(Buffer.from('%PDF-')));
  assert.match(service.documents.describe(result.artifacts.dual).filename,/-pages-1-dual\.pdf$/);
  assert(!fs.existsSync(path.join(root,'work',job.id)));
});
test('Only selected PDFs are passed to the worker, registered and delivered; originals survive',async t=>{
  for(const output of ['dual','mono','both']){
    const sent=[];let received;
    const {service,doc}=await setup(t,{runner:async request=>{
      received=request.outputKind;const files={};
      for(const kind of (output==='both'?['dual','mono']:[output])){
        files[kind]=path.join(request.work,kind+'.pdf');fs.writeFileSync(files[kind],pdf(kind));
      }
      // An unselected, missing output must never be read/registered by the service.
      if(output!=='both')files[output==='dual'?'mono':'dual']=path.join(request.work,'must-not-open.pdf');
      return files;
    },sendFile:async id=>{sent.push(id);return {status:'platform_accepted'};}});
    const job=service.submit({documentId:doc.id,output},{key:'selected-'+output});
    await terminal(service,job.id);while(service.active)await new Promise(r=>setTimeout(r,5));
    const result=service.get(job.id),kinds=output==='both'?['dual','mono']:[output];
    assert.equal(received,output);assert.equal(result.status,'succeeded');
    assert.deepEqual(Object.keys(result.artifacts),kinds);
    assert.deepEqual(sent,kinds.map(kind=>result.artifacts[kind]));
    assert.equal(service.documents.list({kind:'artifact'}).length,kinds.length);
    assert.deepEqual(service.documents.get(doc.id).content,pdf());
    assert.throws(()=>service.submit({documentId:doc.id,output:'english'},{key:'invalid'}),{code:'invalid_pdf_output'});
  }
});
test('A missing selected PDF fails clearly without registering or sending the other version',async t=>{
  let sends=0;
  const {service,doc}=await setup(t,{runner:async({work})=>{
    const mono=path.join(work,'mono.pdf');fs.writeFileSync(mono,pdf('mono'));return {mono};
  },sendFile:async()=>{sends++;}});
  const job=service.submit({documentId:doc.id,output:'dual'},{key:'missing-dual'});
  const result=await terminal(service,job.id);
  assert.equal(result.status,'failed');assert.equal(result.error,'missing_selected_pdf_output');
  assert.deepEqual(result.artifactFailure,{kind:'dual',code:'missing_selected_pdf_output'});
  assert.deepEqual(result.artifacts,{});assert.equal(sends,0);
  assert.equal(service.documents.list({kind:'artifact'}).length,0);
  assert.deepEqual(service.documents.get(doc.id).content,pdf());
});
test('Dual output over the input limit registers and sends without relaxing original PDF imports',async t=>{
  let sends=0;
  const {service,doc}=await setup(t,{runner:async({work})=>{
    const dual=path.join(work,'dual.pdf');
    const bytes=Buffer.alloc(27*1024*1024);pdf('large dual').copy(bytes);fs.writeFileSync(dual,bytes);return {dual};
  },sendFile:async()=>{sends++;return {status:'platform_accepted'};}});
  const job=service.submit({documentId:doc.id,output:'dual'},{key:'large-dual'});
  await terminal(service,job.id);while(service.active)await new Promise(r=>setTimeout(r,5));
  const result=service.get(job.id);assert.equal(result.status,'succeeded');assert.equal(sends,1);
  assert.deepEqual(Object.keys(result.artifacts),['dual']);
  const bytes=service.documents.get(result.artifacts.dual).content;
  assert.equal(bytes.length,27*1024*1024);
  await assert.rejects(service.documents.add(bytes,{kind:'input'},{inspect}),{code:'pdf_size_limit_exceeded'});
});
test('Cancel running/queued jobs, no post-cancel delivery and restart never replays API',async t=>{
  let calls=0,sends=0;const {service,doc}=await setup(t,{runner:({signal})=>new Promise((resolve,reject)=>{calls++;signal.addEventListener('abort',()=>reject(Error('cancelled')),{once:true});}),sendFile:async()=>{sends++;}});
  const first=service.submit({documentId:doc.id},{key:'first'});await new Promise(r=>setTimeout(r,5));
  const second=service.submit({documentId:doc.id},{key:'second'});
  assert.equal((await service.cancel(second.id)).status,'cancelled');
  assert.equal((await service.cancel(first.id)).status,'cancelled');assert.equal(calls,1);assert.equal(sends,0);
  const third=service.submit({documentId:doc.id},{key:'third'});await new Promise(r=>setTimeout(r,5));
  await service.stop(); assert.equal(service.get(third.id).status,'interrupted');
  const fresh=new PaperService(service.config,{inspect,runner:()=>{throw Error('must not replay');}});fresh.start();
  assert.equal(fresh.get(third.id).status,'interrupted');await fresh.stop();
});
test('A lost send receipt preserves successful translation and does not replay worker',async t=>{
  const {service,doc}=await setup(t,{sendFile:async()=>{throw Error('unknown');}});
  const job=service.submit({documentId:doc.id},{key:'failure'});await terminal(service,job.id);
  while(service.active)await new Promise(r=>setTimeout(r,5));
  const state=service.get(job.id);assert.equal(state.status,'succeeded');assert.equal(state.delivery.status,'failed_or_unknown');
  state.delivery.status='dispatching';service.save(state);
  const fresh=new PaperService(service.config,{inspect});fresh.start();
  assert.equal(fresh.get(job.id).delivery.status,'failed_or_unknown');await fresh.stop();
});
test('Multiple papers stay serial and send each completed paper before translating the next',async t=>{
  const events=[];let translations=0,sends=0,release,entered;
  const sending=new Promise(resolve=>{entered=resolve;}),gate=new Promise(resolve=>{release=resolve;});
  const {service,doc}=await setup(t,{
    runner:async({work})=>{
      events.push('translate-'+(++translations));const files={};
      for(const kind of ['mono','dual']){files[kind]=path.join(work,kind+'.pdf');fs.writeFileSync(files[kind],pdf(kind));}
      return files;
    },
    sendFile:async()=>{
      const n=++sends;events.push('send-'+n+'-start');
      if(n===1){entered();await gate;}
      events.push('send-'+n+'-end');return {status:'platform_accepted'};
    }
  });
  service.config.apiConcurrency=4;service.config.apiQps=1;
  const first=service.submit({documentId:doc.id},{key:'serial-first'});
  const second=service.submit({documentId:doc.id},{key:'serial-second'});
  try{
    await sending;
    assert.equal(service.get(first.id).status,'succeeded');
    assert.deepEqual(service.get(first.id).execution,{apiConcurrency:4,apiQps:1,batchValidationRetries:1,channelRecoveryRetries:1});
    assert.equal(service.get(second.id).status,'queued');
    assert.deepEqual(events,['translate-1','send-1-start']);
  }finally{release();}
  await terminal(service,second.id);
  while(service.active)await new Promise(r=>setTimeout(r,5));
  assert.deepEqual(events,['translate-1','send-1-start','send-1-end','translate-2','send-2-start','send-2-end']);
  assert.equal(service.get(second.id).delivery.status,'platform_accepted');
});
test('Worker failure retains bounded structural diagnostics before removing its work directory',async t=>{
  const {service,doc,root}=await setup(t,{runner:async({work})=>{
    fs.writeFileSync(path.join(work,'engine-error.json'),JSON.stringify({code:'pdf_engine_TypeError',errorType:'TypeError',frames:[{file:'engine.py',function:'translate',line:1}]}));
    throw Object.assign(Error('worker failure'),{code:'pdf_engine_TypeError'});
  }});
  const job=service.submit({documentId:doc.id,delivery:'none'},{key:'engine-failure'});
  const result=await terminal(service,job.id);
  assert.equal(result.status,'failed');assert.equal(result.error,'pdf_engine_TypeError');
  assert.equal(result.engineFailure.frames[0].file,'engine.py');
  assert(!fs.existsSync(path.join(root,'work',job.id)));
});
test('Registered tools reject non-owner, keep generic filesystem tools absent',async t=>{
  const {service}=await setup(t), tools=[],services=[];
  createPaperPlugin({serviceFactory:()=>service}).register({pluginConfig:service.config,config:withAccess({}),registerTool:tool=>tools.push(tool),registerService:s=>services.push(s)});
  assert.deepEqual(tools.map(t=>t.create({}).name),['kurumi_document','kurumi_translate','kurumi_document_send']);
  for(const tool of tools)await assert.rejects(tool.create({getRuntimeConfig:()=>({channels:{'kurumi-qq':{ownerId:'365999865'}}}),senderIsOwner:false}).execute('id',{action:'list'}),/untrusted_identity_context/);
});
