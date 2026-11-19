// Read-only adapter for current job snapshots and their original per-request receipts.
import fs from 'node:fs';
import path from 'node:path';
import {readExecutionStore,traceId,EVIDENCE_STORE} from '../observability/execution.js';
import {normalizeQueryEvent} from './log-query-privacy.mjs';

export function paperUsage(receipt) {
  const u=receipt.usage??{},input=u.input_tokens,output=u.output_tokens;
  return Object.fromEntries(Object.entries({inputTokens:input,outputTokens:output,
    reasoningTokens:u.output_tokens_details?.reasoning_tokens,cacheReadTokens:u.input_tokens_details?.cached_tokens}).filter(([,v])=>Number.isFinite(v)&&v>=0));
}
export function readPaperHistory(root,from,to,options={}) {
  const file=path.join(root,'observability','executions.sqlite');
  const events=readExecutionStore(file,{from,to,executionId:options.executionId}).map(e=>({...normalizeQueryEvent({...e,sourceRef:{path:file,table:'trace_events',id:e.eventId}},options),[EVIDENCE_STORE]:file}));
  const known=new Set(events.map(e=>e.correlation.executionId));
  const dir=path.join(root,'jobs');if(!fs.existsSync(dir))return events;
  const requested=options.executionId;
  const names=requested?(/^paper:job_[a-f0-9]{24}$/.test(requested)&&fs.existsSync(path.join(dir,requested.slice(6)+'.json'))?[requested.slice(6)+'.json']:[]):fs.readdirSync(dir).filter(n=>/^job_[a-f0-9]{24}\.json$/.test(n));
  if(names.length>10000)throw Error('paper_history_read_limit');
  for(const name of names){
    const source=path.join(dir,name);if(fs.lstatSync(source).isSymbolicLink())throw Error('Invalid job source');
    let job;try{job=JSON.parse(fs.readFileSync(source,'utf8'));}catch(error){options.onIssue?.(error);continue;}
    const executionId='paper:'+job.id;if(known.has(executionId))continue;
    const at=Date.parse(job.updatedAt??job.createdAt);if(at<from||at>to)continue;
    const emit=(spanId,parentSpanId,data)=>events.push(normalizeQueryEvent({eventId:'legacy:'+traceId(job.id,spanId),at,source:'papers',kind:'execution.node',
      correlation:{...job.correlation,taskId:job.id,executionId,spanId,...(parentSpanId?{parentSpanId}:{})},
      data:{business:'papers',historicalSnapshot:true,details:{request:{status:'not_collected'},response:{status:'not_collected'}},...data},
      sourceRef:{path:source,table:'job_snapshot',id:job.id}},options));
    emit('root',null,{type:'execution',name:'论文翻译',status:job.status,links:[{documentId:job.documentId}],startedAtMs:Date.parse(job.createdAt),
      captureStatus:Array.isArray(job.usage?.receipts)?'historical_receipts_only':'history_details_missing',expectedRequests:job.usage?.requests});
    emit('task','root',{type:'task',name:'后台翻译',status:job.status,delivery:job.delivery?.status});
    const batches=new Set();
    for(const [index,r] of (job.usage?.receipts??[]).entries()){
      const batch='batch:'+String(r.batchId??'unknown');if(!batches.has(batch)){batches.add(batch);emit(batch,'task',{type:'batch',name:batch,status:'historical'});}
      emit('request:'+String(r.attempt??index),batch,{type:'api',name:'Responses API',status:r.outcome??'unknown',usage:paperUsage(r),usageKnown:r.usageStatus==='reported',
        details:{receipt:{status:'inline_receipt',content:r},request:{status:'not_collected'},response:{status:'not_collected'}}});
    }
  }
  return events;
}
