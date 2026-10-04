// Authorized synthetic natural-language CRUD; future task must be canceled before return.
import fs from 'node:fs';
import {rpc,ready} from './rpc.mjs';
await ready();
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
const cfg=JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/openclaw.json')),a=account(cfg),login=await onebot(a,'get_login_info',{});
const at=new Date(Date.now()+86400000).toISOString(),updatedAt=new Date(Date.now()+90000000).toISOString();
const receiptFile=a.stateDir+'/native-tool-receipts.jsonl';const started=Date.now();
const report={boundary:'Synthetic trusted owner turn, real model and reminder tool, native Cron. Final reply captured locally (no QQ send); temporary tasks scheduled tomorrow and cleaned up.',at,updatedAt};
const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:-1900000006,message:[{type:'text',data:{text:`这是开发者授权的隔离提醒工具验收。请先用 tool_search 找到原生 automations 工具并查看参数，并严格按工具实际返回：1.创建 ${at} 的一次性任务，name="kurumi.fusion.native-owner-test"，payload 使用 agentTurn，message="仅回复：融合验收临时提醒"，toolsAllow=[]，sessionTarget="isolated"，delivery={mode:"announce",channel:"kurumi-qq",to:"user:365999865",accountId:"default"}；2.使用返回的真实ID把时间改为 ${updatedAt}、内容改为“融合验收已修改”；3.取消这个提醒；4.list确认它不在列表。全部操作已经明确授权。若工具失败立即停止，不要换用别的工具绕过权限。最后仅用一句【融合验收】开头的话报告真实结果，不能编造成功。`}}]};
try{report.result=await rpc('kurumi-qq.testInbound',{event,capture:true},120000);report.after=await rpc('cron.list',{includeDisabled:true});}catch(e){report.error=e.message;process.exitCode=1;}
const catalog=await rpc('cron.list',{includeDisabled:true});report.cleanup=[];
for(const job of catalog.jobs??[]){if((job.name?.startsWith('kurumi.reminder.')||job.name==='kurumi.fusion.native-owner-test')&&(job.payload?.argv?.[2]?.startsWith('融合验收')||job.payload?.message?.includes('融合验收')))report.cleanup.push(await rpc('cron.remove',{id:job.id}));}
report.receipts=fs.existsSync(receiptFile)?fs.readFileSync(receiptFile,'utf8').trim().split('\n').filter(Boolean).map(JSON.parse).filter(x=>x.at>=started):[];
report.passed=['add','update','remove','list'].every(action=>report.receipts.some(x=>x.action===action&&!x.error))&&report.cleanup.length===0;
fs.writeFileSync('/home/afrangry/kurumi-fusion/docs/verification/fusion/09-native-agent-reminder.json',JSON.stringify(report,null,2));console.log(JSON.stringify({result:report.result,error:report.error,cleanup:report.cleanup.length}));
