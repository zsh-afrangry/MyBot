// Offline task-result explanation, identity and lifecycle regressions. Contract: docs/22.
// Injected worker/host/QQ; synthetic data and temporary files only, no model or external delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AsyncLocalStorage} from 'node:async_hooks';
import {failureSummary} from '../../plugins/kurumi-papers/failure.js';
import {createFailureNotifier} from '../../plugins/kurumi-papers/notification.js';
import {PaperService} from '../../plugins/kurumi-papers/service.js';
import {pdf} from './fixtures.mjs';

const jobId='job_'+'a'.repeat(24);
const profile={provider:'deepseek',channel:'official',model:'deepseek-flash',effort:'high'};
const binding={subjectId:'fixture-member',accountId:'default',to:'user:fixture-member',sessionKey:'agent:fixture:qq:direct:member',agentId:'fixture'};
const failed=(extra={})=>({id:jobId,status:'failed',error:'translation_budget_exhausted',profile,
  engineProgress:{stage:'Translate Paragraphs'},usage:{requests:74,maxRequests:300,inputTokens:238387,outputTokens:62576,reportedTokens:300963,maxReportedTokens:300000,unknownUsageAttempts:5,failureDetails:{budgetExhaustedBy:'reported_tokens'}},...extra});
const config=()=>({agents:{entries:{fixture:{model:{primary:'deepseek/deepseek-flash'}}}}});

function setup(overrides={}) {
  const calls={runs:[],sends:[],injections:[],checks:[]};
  const runtime={agent:{
    resolveAgentWorkspaceDir:()=>'/fixture/workspace',resolveAgentDir:()=>'/fixture/agent',
    session:{resolveStorePath:()=>'/fixture/store',getSessionEntryAsync:async()=>({sessionId:'fixture-current-session'}),runWithWorkAdmission:async({signal},run)=>run(signal)},
    runEmbeddedAgent:async args=>{calls.runs.push(args);return {payloads:[{text:'本篇达到本地单篇用量上限，尚无完整译文。'}]};},
  }};
  const deps={runtime,workflow:{enqueueNextTurnInjection:async value=>{calls.injections.push(value);return{enqueued:true};}},
    config,authorize:(request,permission)=>{assert.equal(request,binding);calls.checks.push(permission);},
    sendText:async args=>{calls.sends.push(args);return{status:'sent'};},...overrides};
  return {calls,deps,notify:createFailureNotifier(deps)};
}

test('Local token/request budgets are distinguished from upstream quota and include safe counters',()=>{
  const summary=failureSummary(failed());
  assert.equal(summary.stage,'翻译正文');assert.equal(summary.exhaustedBy,'reported_tokens');
  assert.match(summary.message,/300,963 \/ 300,000/);assert.match(summary.message,/不是账号余额不足/);assert.match(summary.message,/5次请求用量未知/);
  assert.equal(summary.counters.inputTokens+summary.counters.outputTokens,summary.counters.reportedTokens);
  const requestLimit=failureSummary(failed({usage:{requests:300,maxRequests:300,failureDetails:{budgetExhaustedBy:'requests'}}}));
  assert.match(requestLimit.reason,/API请求/);
  for(const code of ['insufficient_quota','invalid_api_key','upstream_error']){
    const result=failureSummary(failed({error:'all_translation_credentials_unavailable',usage:{receipts:[{outcome:'quota_or_rate_limit',apiErrorCode:code}]}}));
    assert.equal(result.upstreamCode,code);
    assert.match(result.reason,code==='insufficient_quota'?/额度不足/:code==='invalid_api_key'?/鉴权/:/渠道/);
  }
  const balance=failureSummary(failed({error:'responses_http_402',usage:{receipts:[{outcome:'request_rejected',httpStatus:402,apiErrorCode:'private-code'}]}}));
  assert.equal(balance.upstreamCode,'responses_http_402');assert.match(balance.reason,/额度不足/);assert(!JSON.stringify(balance).includes('private-code'));
  const limited=failureSummary(failed({error:'all_translation_credentials_unavailable',usage:{receipts:[{outcome:'quota_or_rate_limit',httpStatus:429}]}}));
  assert.match(limited.reason,/请求过快/);assert.match(limited.reason,/不是账号余额不足/);
  const recovered=failureSummary(failed({error:'invalid_batch_translation',usage:{receipts:[{outcome:'quota_or_rate_limit',apiErrorCode:'insufficient_quota'}]}}));
  assert.match(recovered.reason,/校验/);
  const untrusted=failureSummary(failed({error:'arbitrary private text',engineProgress:{stage:'PRIVATE-DOCUMENT-TEXT'},usage:{receipts:[{outcome:'channel_failed',error:'private error text'}],reportedTokens:-1}}));
  assert(!JSON.stringify(untrusted).includes('private'));assert(!JSON.stringify(untrusted).includes('PRIVATE-DOCUMENT'));
  assert.equal(untrusted.counters.reportedTokens,undefined);
});

test('Delivery failure preserves successful translation and suggests checking receipts before resend',()=>{
  const summary=failureSummary(failed({status:'succeeded',delivery:{status:'failed_or_unknown'}}));
  assert.equal(summary.hasCompleteArtifact,true);assert.equal(summary.stage,'文件投递');
  assert.match(summary.message,/译文已生成/);assert.match(summary.message,/无需重新翻译/);assert(!summary.message.includes('尚无完整译稿'));
  assert.equal(failureSummary({status:'succeeded',delivery:{status:'platform_accepted'}}),undefined);
});

test('Incomplete output distinguishes output limit, content filtering and an unknown reason',()=>{
  const summary=reason=>failureSummary(failed({error:'response_not_completed',usage:{failureDetails:{responseStatus:'incomplete',incompleteReason:reason,maxOutputTokens:393216}}}));
  const capped=summary('max_output_tokens');
  assert.match(capped.reason,/393,216/);assert.match(capped.reason,/推理token/);assert.match(capped.reason,/截断/);
  assert.equal(capped.incompleteReason,'max_output_tokens');assert.match(capped.nextStep,/不是账号余额不足/);
  assert.match(summary('content_filter').reason,/内容过滤/);
  const unknown=summary('private upstream text');assert.match(unknown.reason,/没有明确/);assert(!JSON.stringify(unknown).includes('private'));
});

test('The bound existing chat receives a tool-free explanation and exactly one public QQ publication',async()=>{
  const {calls,notify}=setup(),summary=failureSummary(failed());
  const receipt=await notify(summary,jobId,binding);
  assert.equal(receipt.mode,'assistant');assert.equal(receipt.contextQueued,false);
  assert.equal(calls.runs.length,1);assert.equal(calls.sends.length,1);assert.equal(calls.injections.length,0);
  const run=calls.runs[0];
  assert.equal(run.agentId,binding.agentId);assert.equal(run.sessionKey,binding.sessionKey);assert.equal(run.sessionId,'fixture-current-session');
  assert.equal(run.provider,'deepseek');assert.equal(run.model,'deepseek-flash');
  assert.equal(run.disableTools,true);assert.deepEqual(run.toolsAllow,[]);assert.deepEqual(run.toolExecutionAllow,[]);assert.equal(run.disableMessageTool,true);
  assert.equal(run.inputProvenance.kind,'internal_system');assert.equal(run.senderIsOwner,undefined);
  assert.match(run.prompt,/300963/);assert.match(run.transcriptPrompt,/本地单篇/);
  assert.equal(calls.sends[0].to,binding.to);assert.equal(calls.sends[0].key,'paper-notice:'+jobId);assert.match(calls.sends[0].text,new RegExp(jobId));
  assert(calls.checks.filter(p=>p==='qq.notify').length>=3);
});

test('Host failure/empty response falls back to diagnostic Chinese and queues already-notified context',async()=>{
  for(const result of [null,{payloads:[]},{meta:{aborted:true},payloads:[{text:'not successful'}]},{payloads:[{text:'NO_REPLY'}]},{payloads:[{text:'reasoning only',isReasoning:true}]}]){
    const {calls,deps}=setup();deps.runtime.agent.runEmbeddedAgent=async()=>{if(result===null)throw Error('private upstream error');return result;};
    const receipt=await createFailureNotifier(deps)(failureSummary(failed()),jobId,binding);
    assert.equal(receipt.mode,'fallback');assert.equal(receipt.contextQueued,true);assert.equal(calls.sends.length,1);
    assert.match(calls.sends[0].text,/300,963 \/ 300,000/);assert(!calls.sends[0].text.includes('private'));
    assert.equal(calls.injections[0].sessionKey,binding.sessionKey);assert.equal(calls.injections[0].agentId,binding.agentId);assert.match(calls.injections[0].text,/不重复播报/);
  }
});

test('A missing chat falls back without creating a replacement session or using the owner route',async()=>{
  const {calls,deps}=setup();deps.runtime.agent.session.getSessionEntryAsync=async()=>undefined;
  const receipt=await createFailureNotifier(deps)(failureSummary(failed()),jobId,binding);
  assert.equal(receipt.mode,'fallback');assert.equal(calls.runs.length,0);assert.equal(calls.sends[0].to,binding.to);
});

test('Revocation during explanation, cancellation and an unknown send receipt never cause another send',async()=>{
  const {calls,deps}=setup();let permitted=true;
  deps.authorize=()=>{if(!permitted)throw Error('revoked');};
  deps.runtime.agent.runEmbeddedAgent=async()=>{permitted=false;return{payloads:[{text:'result'}]};};
  await assert.rejects(createFailureNotifier(deps)(failureSummary(failed()),jobId,binding),/revoked/);assert.equal(calls.sends.length,0);
  const stopped=new AbortController();stopped.abort();
  await assert.rejects(createFailureNotifier(deps)(failureSummary(failed()),jobId,binding,stopped.signal));
  const lost=setup();lost.deps.sendText=async args=>{lost.calls.sends.push(args);throw Error('receipt lost');};
  await assert.rejects(createFailureNotifier(lost.deps)(failureSummary(failed()),jobId,binding),/receipt lost/);
  assert.equal(lost.calls.sends.length,1);assert.equal(lost.calls.injections.length,0);
});

test('Explanation timeout falls back, while a service abort suppresses the fallback',async()=>{
  const first=setup({timeoutMs:10});
  first.deps.runtime.agent.runEmbeddedAgent=async({abortSignal})=>new Promise((_,reject)=>abortSignal.addEventListener('abort',()=>reject(abortSignal.reason),{once:true}));
  // Keep the test alive; AbortSignal.timeout does not itself retain the process event loop.
  const keepAlive=setInterval(()=>{},1000);
  try {
    assert.equal((await createFailureNotifier(first.deps)(failureSummary(failed()),jobId,binding)).mode,'fallback');
    assert.equal(first.calls.sends.length,1);
    const second=setup(),controller=new AbortController();
    second.deps.runtime.agent.runEmbeddedAgent=async({abortSignal})=>new Promise((_,reject)=>{controller.abort();reject(abortSignal.reason);});
    await assert.rejects(createFailureNotifier(second.deps)(failureSummary(failed()),jobId,binding,controller.signal));
    assert.equal(second.calls.sends.length,0);
  } finally {clearInterval(keepAlive);}
});

test('Worker evidence is persisted before notification; historical status/list also expose the explanation',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-notice-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const observed=[];let service;
  service=new PaperService({root,liveTranslationEnabled:true},{inspect:async()=>({pages:1}),
    runner:async({work})=>{fs.writeFileSync(path.join(work,'usage.json'),JSON.stringify(failed().usage));fs.writeFileSync(path.join(work,'progress.json'),JSON.stringify({stage:'Translate Paragraphs'}));throw Object.assign(Error('private failure body'),{code:'translation_budget_exhausted'});},
    notify:async summary=>{observed.push(summary);assert.equal(service.get(summary.jobId).usage.reportedTokens,300963);assert(!fs.existsSync(path.join(root,'work',summary.jobId)));return {mode:'assistant',status:'sent'};},
  });
  service.start();t.after(()=>service.stop());
  const doc=await service.documents.add(pdf(),{filename:'fixture.pdf'},{inspect:async()=>({pages:1})});
  const job=service.submit({documentId:doc.id},{key:'fixture-failure'});
  while(service.active||service.queue.length)await new Promise(r=>setTimeout(r,5));
  assert.equal(observed.length,1);assert.match(observed[0].message,/300,963/);
  assert.equal(service.get(job.id).notification.mode,'assistant');assert.equal(service.status(job.id).failureSummary.exhaustedBy,'reported_tokens');
  const old=service.get(job.id);delete old.failureSummary;service.save(old);
  assert.match(service.list()[0].failureSummary.message,/本地单篇/);assert.match(service.status(job.id).failureSummary.message,/本地单篇/);
  old.usage.receipts=Array.from({length:300},(_,i)=>({attempt:i,responseId:'PRIVATE-RESPONSE-ID',usage:{input_tokens:23000},message:'PRIVATE-RAW-BODY'}));
  old.engineProgress={stage:'Translate Paragraphs',overall_progress:51,stage_progress:27};
  old.requester={subjectId:'PRIVATE-IDENTITY',sessionKey:'PRIVATE-CHAT'};old.engineFailure={path:'/PRIVATE-PATH'};service.save(old);
  const visible=JSON.stringify(service.status(job.id));
  assert(visible.length<4000);assert(visible.indexOf('failureSummary')<100);assert(!visible.includes('PRIVATE'));
  assert.equal(service.get(job.id).usage.receipts.length,300);assert.equal(service.list()[0].usage.receipts,undefined);
  assert.deepEqual(service.status(job.id).engineProgress,{stage:'Translate Paragraphs',overall_progress:51,stage_progress:27});
  await service.stop();const pending=service.get(job.id);pending.notification={status:'pending'};service.save(pending);
  const fresh=new PaperService({root},{notify:()=>{throw Error('must not replay');}});fresh.start();
  assert.equal(fresh.get(job.id).notification.status,'failed_or_unknown');await fresh.stop();
});

test('A delayed job and its notice outlive the submitting tool scope',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-scope-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const scope=new AsyncLocalStorage(),submittedScope={closed:false};let notifications=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const service=new PaperService({root,liveTranslationEnabled:true},{
    runner:async()=>{await gate;assert.equal(scope.getStore(),undefined);throw Object.assign(Error('Synthetic failure'),{code:'response_not_completed'});},
    notify:async()=>{assert.equal(submittedScope.closed,true);assert.equal(scope.getStore(),undefined);notifications++;return{mode:'assistant',status:'sent'};},
  });
  service.start();t.after(()=>service.stop());
  const doc=await service.documents.add(pdf(),{filename:'fixture.pdf'},{inspect:async()=>({pages:1})});
  const job=scope.run(submittedScope,()=>service.submit({documentId:doc.id,delivery:'none'},{key:'closed-invocation'}));
  submittedScope.closed=true;release();
  while(service.active||service.queue.length)await new Promise(r=>setTimeout(r,5));
  assert.equal(notifications,1);assert.equal(service.get(job.id).notification.mode,'assistant');
});
