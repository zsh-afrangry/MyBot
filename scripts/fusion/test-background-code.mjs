// Synthetic owner starts one ordinary code task session through the assistant tool.
// Main acknowledgement is captured locally; worker terminal result may use one QQ message.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();
const state='/home/afrangry/.openclaw-fusion';const cfg=JSON.parse(fs.readFileSync(`${state}/openclaw.json`)),a=account(cfg),login=await onebot(a,'get_login_info',{});
const hash=()=>createHash('sha256').update(fs.readFileSync(`${state}/code-workspace/test_stats.py`)).digest('hex');
const report={boundary:'Synthetic owner to real main model/task tool, ordinary worker session restricted to code fixture. Captured main acknowledgement, actual QQ terminal delivery requested.',startedAt:Date.now(),testHash:hash()};
const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:-1900000007,message:[{type:'text',data:{text:'这是开发者授权的后台代码验收。请用 tool_search 找到 kurumi_task，调用start且仅一次，任务为：读取隔离工作区的stats.py和test_stats.py，修复stats.py，不能修改测试，用kurumi_project_check运行测试，最终用【融合验收】开头报告真实结果。你不要自己修改代码，不等待任务完成，工具实际接受后仅告诉我已启动；失败就如实说失败。'}}]};
try{
 report.start=await rpc('kurumi-qq.testInbound',{event,capture:true},120000);
 const receipts=fs.existsSync(`${a.stateDir}/task-receipts.jsonl`)?fs.readFileSync(`${a.stateDir}/task-receipts.jsonl`,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
 report.task=receipts.findLast(x=>x.at>=report.startedAt&&x.action==='start');assert(report.task?.result?.runId,'No task accepted');
 report.chat=await rpc('agent',{sessionKey:'agent:main:fusion-while-coding',message:'用一句话回应：今天忙了一晚，终于可以休息了。不要使用工具。',deliver:false,idempotencyKey:'fusion-chat-while-code'});
 report.chatFinished=await rpc('agent.wait',{runId:report.chat.runId,timeoutMs:20000});
 report.worker=await rpc('agent.wait',{runId:report.task.result.runId,timeoutMs:90000},100000);
 assert.equal(hash(),report.testHash,'Tests changed');report.passed=report.worker.status==='ok';
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
fs.writeFileSync('/home/afrangry/kurumi-fusion/docs/verification/fusion/10-background-code.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
