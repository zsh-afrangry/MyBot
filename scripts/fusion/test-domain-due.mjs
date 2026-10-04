// Create via real model and original confirmation. Check in a later invocation after restart.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();const state='/home/afrangry/.openclaw-fusion',file='docs/verification/migration/10-reminder-restart-delivery.json';
const a=account(JSON.parse(fs.readFileSync(`${state}/openclaw.json`)));
if(process.argv[2]==='check'){
 const report=JSON.parse(fs.readFileSync(file));report.runs=await rpc('cron.runs',{id:report.job.id,limit:10});
 const db=new DatabaseSync(`${state}/state/personal-reminders/reminders.sqlite`,{readOnly:true});report.domain=db.prepare('SELECT reminder_id,status,cron_job_id FROM reminders WHERE reminder_id=?').get(report.reminderId);db.close();
 const ledger=new DatabaseSync(`${a.stateDir}/channel.sqlite`,{readOnly:true});report.newReceipts=ledger.prepare('SELECT status,message_id FROM outbound WHERE at>=?').all(report.started);ledger.close();
 report.readback=[];for(const r of report.newReceipts)if(r.status==='sent') {const msg=await onebot(a,'get_msg',{message_id:Number(r.message_id)});report.readback.push({messageId:r.message_id,types:msg.message.map(x=>x.type),text:msg.message.filter(x=>x.type==='text').map(x=>x.data.text).join('')});}
 report.passed=report.runs.entries?.some(r=>r.status==='ok'&&r.deliveryStatus==='delivered')&&report.domain?.status==='delivered'&&report.readback.some(r=>r.text.includes('架构验证：确定性提醒跨重启'));
 fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify(report));if(!report.passed)process.exitCode=1;
}else{
 const report={boundary:'Synthetic owner creates/confirms through real model. One actual owner QQ message. Restart before due then inspect native Cron/domain receipts and QQ readback.',started:Date.now()};
 const login=await onebot(a,'get_login_info',{});let id=-Date.now();
 const send=text=>rpc('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:id--,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}},150000);
 const result=tool=>{const call=fs.readFileSync(a.stateDir+'/native-tool-receipts.jsonl','utf8').trim().split('\n').map(JSON.parse).findLast(x=>x.at>=report.started&&x.tool===tool);assert(call);return JSON.parse(call.result.content.find(x=>x.type==='text').text);};
 const at=new Date(Date.now()+240000+8*3600000).toISOString().slice(0,16);report.localTime=at;
 try{report.proposalReply=await send(`请用个人提醒工具创建待确认提案，Asia/Shanghai时间 ${at}，内容“架构验证：确定性提醒跨重启，只发本人”。只生成提案。`);const p=result('personal_reminder_propose');assert(p.ok);report.confirmationReply=await send(p.confirmationInstruction);report.committed=result('personal_reminder_commit');assert.equal(report.committed.status,'scheduled');report.reminderId=report.committed.reminder.reminderId;report.job=(await rpc('cron.list',{includeDisabled:true})).jobs.find(j=>j.name===`kurumi.personal-reminder.${report.reminderId}`);assert(report.job);assert.equal(report.job.payload.cwd,'/home/afrangry/kurumi-fusion/chatbot/plugins/personal-weather');report.created=true;}catch(e){report.error=e.message;process.exitCode=1;}
 fs.writeFileSync(file,JSON.stringify(report,null,2));console.log(JSON.stringify({created:report.created,localTime:at,error:report.error}));
}
