// Memory operation telemetry only: actual host binding, revisions and IDs. Never
// persist text, queries, evidence, arguments, source hashes or arbitrary errors.
import fs from 'node:fs';import path from 'node:path';import {DatabaseSync} from 'node:sqlite';
import {createTraceSink} from './index.js';
function revision(cfg,ctx){
 const owner=cfg.channels?.['kurumi-qq']?.ownerId;
 if(ctx.agentId!=='main'||ctx.requesterSenderId!==owner||ctx.sessionKey!==`agent:main:kurumi-qq:direct:${owner}`)return;
 const workspace=cfg.agents?.entries?.main?.workspace;if(typeof workspace!=='string')return;
 const file=path.join(workspace,'.kurumi-memory','state.sqlite');if(!fs.existsSync(file))return;
 const db=new DatabaseSync(file,{readOnly:true});try{
  const v=db.prepare('PRAGMA user_version').get().user_version;
  return v===2?db.prepare('SELECT revision FROM memory_state WHERE singleton=1').get()?.revision:v===3?JSON.parse(db.prepare('SELECT state_json FROM memory_aux WHERE singleton=1').get().state_json).revision:undefined;
 }finally{db.close();}
}
const code=error=>/^[A-Za-z0-9_.:-]{1,80}$/.test(error?.code??'')?error.code
 :/revision|记忆已改变/.test(error?.message??'')?'memory_revision_conflict'
 :/owner private|本人当前|本次本人原文/.test(error?.message??'')?'memory_current_owner_required'
 :'memory_operation_rejected';
const resultValue=result=>{for(const p of result?.content??[])if(p.type==='text'){try{return JSON.parse(p.text);}catch{}}return{};};
export async function auditMemoryCall({api,ctx,callId,args,runId},execute){
 const cfg=ctx.getRuntimeConfig?.()??api.config;let before;try{before=revision(cfg,ctx);}catch{}
 const started=Date.now();let result,error;
 try{result=await execute();return result;}catch(e){error=e;throw e;}finally{
  try{
   if(api.registrationMode==='discovery'||api.registrationMode==='setup')throw Error('audit_not_registered');
   const root=cfg.channels?.['kurumi-qq']?.stateDir;if(typeof root!=='string'||!path.isAbsolute(root))throw Error('audit_root_missing');
   const value=resultValue(result),ids=[...new Set([...(Array.isArray(value.ids)?value.ids:[]),...(Array.isArray(value.entries)?value.entries.map(r=>r.id):[])])].filter(id=>typeof id==='string'&&/^[a-zA-Z0-9_-]{1,100}$/.test(id)).slice(0,64);
   createTraceSink(path.join(root,'memory-events.jsonl'), {maxBytes:4*1024*1024}).emit({source:'kurumi-memory',kind:'memory.operation',
    correlation:{sessionKey:ctx.sessionKey,sessionId:ctx.sessionId,runId,toolCallId:callId},
    data:{action:['list','search','observe','upsert','delete'].includes(args?.action)?args.action:'unknown',revisionBefore:before,revisionAfter:revision(cfg,ctx),ids,count:ids.length,status:error?'rejected':'ok',...(error?{code:code(error)}:{}),durationMs:Date.now()-started}});
  }catch{/* Telemetry cannot change business results or replace the original error. */}
 }
}
