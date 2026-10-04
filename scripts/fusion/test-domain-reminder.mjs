// Real model + original confirmation ingress; all conversational replies captured locally.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();
const a=account(JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json'))),login=await onebot(a,'get_login_info',{});
let id=-Date.now();const report={boundary:'Synthetic owner, real model and native domain confirmation. CRUD scheduled tomorrow, captured acknowledgements, no actual QQ send.'};
const receipts=()=>fs.readFileSync(a.stateDir+'/native-tool-receipts.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const send=text=>rpc('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:id--,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}},150000);
async function invoke(text,tool){const at=Date.now();const reply=await send(text);const call=receipts().findLast(x=>x.at>=at&&x.tool===tool);assert(call,`Missing ${tool}`);const result=JSON.parse(call.result.content.find(p=>p.type==='text').text);report.steps??=[];report.steps.push({tool,result,reply});assert(result.ok,JSON.stringify(result));return result;}
const local=offset=>new Date(Date.now()+offset+8*3600000).toISOString().slice(0,16);
try{
 const p=await invoke(`请创建个人提醒提案：明天 ${local(86400000)}（Asia/Shanghai），内容“架构验证：确定性提醒CRUD”。仅用 personal_reminder_propose，不使用automations，先不提交。`,'personal_reminder_propose');
 const c=await invoke(p.confirmationInstruction,'personal_reminder_commit');assert.equal(c.status,'scheduled');report.reminderId=c.reminder.reminderId;
 const before=(await rpc('cron.list',{includeDisabled:true})).jobs.find(j=>j.name===`kurumi.personal-reminder.${report.reminderId}`);assert(before);report.jobId=before.id;
 const u=await invoke(`请生成修改提醒 ${report.reminderId} 的提案，将时间改为 ${local(90000000)}（Asia/Shanghai），内容改为“架构验证：已修改”。只生成提案。`,'personal_reminder_change_propose');
 const updated=await invoke(u.confirmationInstruction,'personal_reminder_change_commit');assert.equal(updated.status,'updated');
 const after=(await rpc('cron.list',{includeDisabled:true})).jobs.find(j=>j.id===before.id);assert(after);assert.notEqual(after.schedule.at,before.schedule.at);report.sameJobId=true;
 const d=await invoke(`请生成取消提醒 ${report.reminderId} 的提案。`,'personal_reminder_cancel_propose');
 const cancelled=await invoke(d.confirmationInstruction,'personal_reminder_cancel_commit');assert.equal(cancelled.status,'cancelled');
 assert(!(await rpc('cron.list',{includeDisabled:true})).jobs.some(j=>j.id===before.id));report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
fs.writeFileSync(process.argv[2]??'docs/verification/migration/09-reminder-crud.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,reminderId:report.reminderId,jobId:report.jobId}));
