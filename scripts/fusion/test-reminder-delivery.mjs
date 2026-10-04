// Natural language -> real automations -> due agentTurn -> owner QQ.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();
const cfg=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json')),a=account(cfg),login=await onebot(a,'get_login_info',{});
const report={boundary:'Synthetic trusted owner, actual native automations creation and due agentTurn. Main acknowledgement captured; one actual owner QQ reminder intended.',at:new Date(Date.now()+65000).toISOString()};
const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:-1900000009,message:[{type:'text',data:{text:`已授权一次真实提醒投递测试。用原生automations创建且只创建一次：name="kurumi.fusion.natural-due"，时间=${report.at}，sessionTarget="isolated"，payload={kind:"agentTurn",message:"只输出这一句：【融合验收】这是通过聊天创建、由 OpenClaw 到点唤醒并投递的提醒。",toolsAllow:[]}，delivery={mode:"announce",channel:"kurumi-qq",to:"user:365999865",accountId:"default"}，deleteAfterRun=true。不要立即执行，不要再建其他任务。按真实工具结果报告创建状态。`}}]};
try{
 report.reply=await rpc('kurumi-qq.testInbound',{event,capture:true},120000);
 const jobs=await rpc('cron.list',{includeDisabled:true});const job=jobs.jobs.find(j=>j.name==='kurumi.fusion.natural-due');assert(job,'Native task not found');report.job=job;
 fs.writeFileSync('docs/verification/fusion/13-natural-reminder-delivery.json',JSON.stringify(report,null,2));
 for(let i=0;i<36;i++){
  const runs=await rpc('cron.runs',{id:job.id,limit:5});
  if(runs.entries?.length){report.runs=runs;break;}
  await new Promise(r=>setTimeout(r,5000));
 }
 assert(report.runs?.entries?.some(r=>r.status==='ok'&&r.deliveryStatus==='delivered'),'No successful due delivery');report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
finally{if(report.job){const remaining=await rpc('cron.list',{includeDisabled:true});if(remaining.jobs?.some(j=>j.id===report.job.id))report.cleanup=await rpc('cron.remove',{id:report.job.id});}}
fs.writeFileSync('docs/verification/fusion/13-natural-reminder-delivery.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
