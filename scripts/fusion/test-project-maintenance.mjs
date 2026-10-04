// Real QQ main model -> native project worker -> OS-isolated regression -> local commit.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
import {projectCatalog} from '../../chatbot/plugins/kurumi-tasks/projects.js';
import {runSandbox} from '../../chatbot/plugins/kurumi-tasks/sandbox.js';
await ready();const state='/home/afrangry/.openclaw-fusion',cfg=JSON.parse(fs.readFileSync(state+'/openclaw.json')),a=account(cfg),p=projectCatalog(cfg).find(p=>p.id==='fusion'),login=await onebot(a,'get_login_info',{});let id=-Date.now();
const hash=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex'),test=p.root+'/chatbot/plugins/kurumi-memory/test/memory.test.js';
const git=(...args)=>{const r=spawnSync('/usr/bin/git',args,{cwd:p.root,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);return r.stdout.trim();};
const report={boundary:'Real main model starts ordinary project worker in independent clone. Bubblewrap checks, immutable external fixture, local Git commit. Main replies captured, worker final to owner QQ.',started:Date.now(),beforeCommit:git('rev-parse','HEAD'),testHash:hash(test),fixtureHash:hash(p.fixtures[0].source)};
const send=text=>rpc('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:id--,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}},180000);
try{
 report.accepted=await send('这是已授权的融合项目副本维护验收。请用kurumi_task start，projectId=fusion，仅启动一次后台任务：先用kurumi_project_git检查状态并创建kurumi/memory-validation分支，运行kurumi_project_check复现失败；修复chatbot/plugins/kurumi-memory/store.js的负数revision未拒绝、悬空符号链接被视为不存在两项问题。不要改弱或修改测试文件，不碰其他仓库。复测通过后查看diff并用kurumi_project_git创建本地提交，不推送。完成后用一段不超过250字、以【架构验证】开头的中文报告实际结果和提交号。主聊天接受后立即回复已启动，不等待完成。');
 const tasks=fs.readFileSync(a.stateDir+'/task-receipts.jsonl','utf8').trim().split('\n').map(JSON.parse);report.task=tasks.findLast(x=>x.at>=report.started&&x.action==='start');assert(report.task?.result?.runId);
 report.beforeChat=await rpc('agent.wait',{runId:report.task.result.runId,timeoutMs:0});const chatAt=Date.now();report.chat=await send('代码任务继续跑就好。现在陪我闲聊一句：忙了一晚上，终于能躺下啦。不要操作任何工具。');report.chatMs=Date.now()-chatAt;
 for(let i=0;i<15;i++){const r=await rpc('agent.wait',{runId:report.task.result.runId,timeoutMs:30000},40000);if(r.status!=='running'&&r.status!=='timeout'&&r.status!=='queued'){report.worker=r;break;}}
 assert.equal(report.worker?.status,'ok','Worker not successful');assert.equal(hash(test),report.testHash,'Worker changed tests');assert.equal(hash(p.fixtures[0].source),report.fixtureHash);
 report.afterCommit=git('rev-parse','HEAD');report.changedFiles=git('diff-tree','--no-commit-id','--name-only','-r',report.afterCommit).split('\n');assert.deepEqual(report.changedFiles,['chatbot/plugins/kurumi-memory/store.js'],'Unexpected commit scope');assert.notEqual(report.afterCommit,report.beforeCommit);report.gitStatus=git('status','--porcelain');assert.equal(report.gitStatus,'');report.branch=git('branch','--show-current');assert.equal(report.branch,'kurumi/memory-validation');
 report.independent=await runSandbox(p,p.checks[0].argv);assert.equal(report.independent.code,0,report.independent.output);
 const tools=report.worker.terminalReceipt?.successfulToolNames??[];assert(tools.includes('kurumi_project_check'));assert(tools.includes('kurumi_project_git'));report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
fs.writeFileSync('docs/verification/migration/22-project-maintenance.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,task:report.task,worker:report.worker,commit:report.afterCommit}));
