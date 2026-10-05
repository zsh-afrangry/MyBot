// Thin adapter: native Host sessions own task execution, status, cancellation and delivery.
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import {callGatewayTool} from 'openclaw/plugin-sdk/agent-harness-runtime';
import {ownerAuthorized as authorized} from '../kurumi-qq/src/config.js';
import {projectCatalog,workerProject} from './projects.js';
import {runSandbox} from './sandbox.js';
const json=result=>({content:[{type:'text',text:JSON.stringify(result)}]});
export default {id:'kurumi-tasks',name:'Kurumi native task sessions',register(api){
 api.registerTool({contextVersion:2,create:ctx=>({name:'kurumi_task',label:'Background project task',description:'列出已注册项目或在独立项目副本启动后台代码工作或论文研究（kind=research）。主聊天可继续；Host完成后回到本人QQ。只接受项目ID和任务说明，无任意路径或命令。list也列最近任务，status/cancel使用返回的真实runId/sessionKey。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['list','start','status','cancel']},projectId:{type:'string'},kind:{type:'string',enum:['code','research']},task:{type:'string'},sessionKey:{type:'string'},runId:{type:'string'}}},async execute(callId,args,signal){
  const cfg=ctx.getRuntimeConfig?.()??api.config;if(!authorized(ctx,cfg))throw Error('Task requires trusted owner private context');ctx.assertInvocationCurrent();signal?.throwIfAborted();
  const receiptFile=cfg.channels['kurumi-qq'].stateDir+'/task-receipts.jsonl';
  const saved=fs.existsSync(receiptFile)?fs.readFileSync(receiptFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const call=(m,p)=>{ctx.assertInvocationCurrent();return callGatewayTool(m,{timeoutMs:15000},p,{signal,dispatchAuthority:{version:2,kind:'run',assertCurrent:ctx.assertInvocationCurrent}});};
  let result;
  if(args.action==='list')return json({researchAvailable:!!cfg.agents.entries.researcher,projects:projectCatalog(cfg).map(({id,name})=>({id,name})),recent:saved.filter(x=>x.action==='start').slice(-10).map(x=>({projectId:x.projectId,at:x.at,...x.result}))});
  if(args.action==='start'){
   if(typeof args.task!=='string'||!args.task.trim()||args.task.length>8000)throw Error('Task must be 1–8000 characters');
   const project=args.kind==='research'&&cfg.agents.entries.researcher?{agentId:'researcher'}:args.kind==='research'?undefined:projectCatalog(cfg).find(p=>p.id===(args.projectId??'fusion'));if(!project)throw Error('Unknown registered project or researcher');
   const key=createHash('sha256').update(ctx.sessionId+':'+callId).digest('hex').slice(0,24);
   result=await call('agent',{agentId:project.agentId,sessionKey:`agent:${project.agentId}:kurumi-task-${key}`,message:args.task,deliver:true,replyChannel:'kurumi-qq',replyTo:'user:'+cfg.channels['kurumi-qq'].ownerId,replyAccountId:'default',idempotencyKey:key,timeout:600});
  }else{
   if(!/^agent:(?:worker|researcher|project-[a-z0-9-]+):kurumi-task-[a-f0-9]{24}$/.test(args.sessionKey??'')||!/^(?:[a-f0-9]{24}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/.test(args.runId??''))throw Error('Invalid task identity');
   if(!saved.some(x=>x.action==='start'&&x.result?.runId===args.runId&&x.result?.sessionKey===args.sessionKey))throw Error('Task run/session binding mismatch');
   result=args.action==='status'?await call('agent.wait',{runId:args.runId,timeoutMs:0}):args.action==='cancel'?await call('chat.abort',{sessionKey:args.sessionKey,runId:args.runId}):(()=>{throw Error('Unknown task action');})();
  }
  fs.appendFileSync(receiptFile,JSON.stringify({at:Date.now(),action:args.action,kind:args.kind??'code',projectId:args.kind==='research'?null:args.projectId??'fusion',result})+'\n',{mode:0o600});return json(result);
 }})},{name:'kurumi_task',optional:true});
 api.registerTool({contextVersion:2,create:ctx=>ctx.agentId?.startsWith('project-')?{name:'kurumi_project_check',label:'Run registered project checks',description:'在Bubblewrap隔离环境运行本项目已登记检查，无任意命令参数。外网和助手私有目录不可访问，固定验收文件只读。实际返回退出码与输出。',parameters:{type:'object',properties:{},additionalProperties:false},async execute(id,args,signal){
  ctx.assertInvocationCurrent();const project=workerProject(ctx,ctx.getRuntimeConfig?.()??api.config),results=[];
  for(const check of project.checks){ctx.assertInvocationCurrent();const result=await runSandbox(project,check.argv,{signal,timeoutMs:check.timeoutMs??60000});results.push({name:check.name,...result});if(result.code!==0)break;}
  return json({ok:results.length===project.checks.length&&results.every(r=>r.code===0),checks:results});
 }}:null},{name:'kurumi_project_check',optional:true});
 api.registerTool({contextVersion:2,create:ctx=>ctx.agentId?.startsWith('project-')?{name:'kurumi_project_git',label:'Local project Git',description:'本项目隔离环境中的status/diff/branch/commit。只做本地Git操作，不提供push、网络或任意命令。commit必须明确列出本次文件paths，仅提交这些文件；应先审阅diff和通过检查。',parameters:{type:'object',additionalProperties:false,required:['action'],properties:{action:{type:'string',enum:['status','diff','branch','commit']},name:{type:'string',maxLength:80},message:{type:'string',maxLength:300},paths:{type:'array',minItems:1,maxItems:50,items:{type:'string',maxLength:300}}}},async execute(id,args,signal){
  ctx.assertInvocationCurrent();const project=workerProject(ctx,ctx.getRuntimeConfig?.()??api.config),git=['/usr/bin/git','-c','safe.directory=/workspace','-c','core.hooksPath=/dev/null'];let argv;
  if(args.action==='status')argv=[...git,'status','--short','--branch'];
  else if(args.action==='diff')argv=[...git,'diff','--no-ext-diff','HEAD','--'];
  else if(args.action==='branch'){if(!/^kurumi\/[a-z0-9][a-z0-9-]{0,60}$/.test(args.name??''))throw Error('Branch must be kurumi/<name>');argv=[...git,'switch','-c',args.name];}
  else if(args.action==='commit'){
   if(typeof args.message!=='string'||!args.message.trim()||args.message.length>300||args.message.includes('\0'))throw Error('Commit message required');
   if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>50||args.paths.some(p=>typeof p!=='string'||!p||p.length>300||p.startsWith('/')||p.startsWith('-')||p.includes('\0')||p.split('/').some(s=>!s||s==='..'||s==='.'||s==='.git')))throw Error('Explicit relative file paths required');
   for(const file of args.paths){try{if(fs.lstatSync(project.root+'/'+file).isDirectory())throw Error('Commit paths must be files');}catch(e){if(e.code!=='ENOENT')throw e;}}
   const staged=await runSandbox(project,[...git,'add','--',...args.paths],{signal});if(staged.code!==0)return json(staged);ctx.assertInvocationCurrent();
   argv=[...git,'-c','user.name=Kurumi','-c','user.email=kurumi@localhost','commit','--only','-m',args.message,'--',...args.paths];
  }else throw Error('Invalid Git action');
  return json(await runSandbox(project,argv,{signal}));
 }}:null},{name:'kurumi_project_git',optional:true});
}};
