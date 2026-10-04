// Real owner tool status/cancel. Main reply is captured; abort worker before final send.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();
const cfg=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json')),a=account(cfg),login=await onebot(a,'get_login_info',{}),started=Date.now();
const report={boundary:'Real main model invokes task adapter with trusted synthetic owner; captured acknowledgement, ordinary worker, real Host status and abort.'};
const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:-1900000008,message:[{type:'text',data:{text:'这是已授权的任务控制验收。找到kurumi_task工具，先start且只一次，内容为“仔细读取stats.py和test_stats.py，对每个函数逐项审查边界条件，然后实际运行kurumi_project_check，详细分析结果，最后报告”。获得真实runId与sessionKey后，立刻status，再立刻cancel，不要等待后台任务完成。最后如实报告取消结果；不要新建第二个任务。'}}]};
try{
 report.reply=await rpc('kurumi-qq.testInbound',{event,capture:true},120000);
 report.receipts=fs.readFileSync(a.stateDir+'/task-receipts.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(x=>x.at>=started);
 const start=report.receipts.find(x=>x.action==='start');assert(start);
 assert(report.receipts.some(x=>x.action==='status'));
 assert(report.receipts.some(x=>x.action==='cancel'&&x.result.aborted===true));
 report.terminal=await rpc('agent.wait',{runId:start.result.runId,timeoutMs:15000});
 report.passed=report.terminal.status==='error';assert(report.passed);
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
fs.writeFileSync('docs/verification/fusion/12-task-control.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
