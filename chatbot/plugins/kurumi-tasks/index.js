// Typed adapter for ordinary Host task sessions. Host owns execution and cancellation.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {callGatewayTool} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {ownerAuthorized as authorized} from '../kurumi-qq/src/config.js';
const root='/home/afrangry/.openclaw-fusion/code-workspace';
const prefix='agent:worker:kurumi-task-';
export default {id:'kurumi-tasks',name:'Kurumi native task sessions',register(api){
 api.registerTool({contextVersion:2,create:ctx=>({name:'kurumi_task',label:'Background project task',description:'在已配置的隔离代码工作区启动普通后台任务会话，主聊天可继续。返回真实sessionKey与runId用于status/cancel。任务完成后发给主人。当前仅用于隔离代码项目，不接收任意路径或收件人。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['start','status','cancel']},task:{type:'string'},sessionKey:{type:'string'},runId:{type:'string'}}},async execute(callId,args,signal){
  const cfg=ctx.getRuntimeConfig?.()??api.config;if(!authorized(ctx,cfg))throw Error('Task requires trusted owner private context');
  const call=(m,p)=>{ctx.assertInvocationCurrent();return callGatewayTool(m,{timeoutMs:15000},p,{signal,dispatchAuthority:{version:2,kind:'run',assertCurrent:ctx.assertInvocationCurrent}});};
  let result;
  if(args.action==='start'){
   if(typeof args.task!=='string'||!args.task.trim()||args.task.length>8000)throw Error('Task must be 1–8000 characters');
   const key=createHash('sha256').update(ctx.sessionId+':'+callId).digest('hex').slice(0,24);
   result=await call('agent',{agentId:'worker',sessionKey:prefix+key,message:args.task,deliver:true,replyChannel:'kurumi-qq',replyTo:'user:'+cfg.channels['kurumi-qq'].ownerId,replyAccountId:'default',idempotencyKey:key,timeout:180});
  }else{
   if(!new RegExp('^'+prefix+'[a-f0-9]{24}$').test(args.sessionKey??'')||!/^(?:[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(args.runId??''))throw Error('Invalid task identity');
   const saved=fs.existsSync(cfg.channels['kurumi-qq'].stateDir+'/task-receipts.jsonl')?fs.readFileSync(cfg.channels['kurumi-qq'].stateDir+'/task-receipts.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
   if(!saved.some(x=>x.action==='start'&&x.result?.runId===args.runId&&x.result?.sessionKey===args.sessionKey))throw Error('Task run/session binding mismatch');
   result=args.action==='status'?await call('agent.wait',{runId:args.runId,timeoutMs:0}):args.action==='cancel'?await call('chat.abort',{sessionKey:args.sessionKey,runId:args.runId}):(()=>{throw Error('Unknown task action');})();
  }
  fs.appendFileSync(cfg.channels['kurumi-qq'].stateDir+'/task-receipts.jsonl',JSON.stringify({at:Date.now(),action:args.action,result})+'\n',{mode:0o600});
  return {content:[{type:'text',text:JSON.stringify(result)}]};
 }} )},{name:'kurumi_task',optional:true});
 api.registerTool({contextVersion:2,create:ctx=>ctx.agentId==='worker'?{name:'kurumi_project_check',label:'Run isolated project tests',description:'运行当前隔离代码样例的固定Python unittest命令，无任意命令、路径或参数。',parameters:{type:'object',properties:{},additionalProperties:false},async execute(id,args,signal){
  ctx.assertInvocationCurrent();if(fs.realpathSync(ctx.workspaceDir)!==fs.realpathSync(root))throw Error('Unexpected worker workspace');
  const outcome=await new Promise((resolve,reject)=>{
   const child=spawn('/usr/bin/python3',['-m','unittest','-v'],{cwd:root,env:{PATH:'/usr/bin:/bin',PYTHONIOENCODING:'utf-8'},stdio:['ignore','pipe','pipe']});let output='';
   const timer=setTimeout(()=>child.kill('SIGKILL'),30000);const abort=()=>child.kill('SIGTERM');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
   const collect=b=>{if(output.length<16000)output+=b.toString().slice(0,16000-output.length);};child.stdout.on('data',collect);child.stderr.on('data',collect);child.once('error',reject);child.once('exit',(code,stopped)=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve({code,signal:stopped,output});});
  });return {content:[{type:'text',text:JSON.stringify(outcome)}]};
 }}:null},{name:'kurumi_project_check',optional:true});
}};
