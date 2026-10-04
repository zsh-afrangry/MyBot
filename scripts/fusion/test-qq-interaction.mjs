// Authorized owner-only physical acceptance: two natural segments and one catalog sticker.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();const state='/home/afrangry/.openclaw-fusion',a=account(JSON.parse(fs.readFileSync(state+'/openclaw.json'))),login=await onebot(a,'get_login_info',{});let id=-Date.now();
const report={boundary:'Synthetic owner, real model. Two physical paragraph messages and one sticker to owner only; sticker final acknowledgement captured.',started:Date.now()};
const send=(text,capture)=>rpc('kurumi-qq.testInbound',{capture,event:{post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:id--,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}},150000);
try{
 await send('这是已授权的本人QQ交互验收。请不调用工具，只原样回复下面两个短段落，中间一个空行，不加其他内容：\n\n【架构验证】Kurumi 的短段消息测试。\n\n【架构验证】这一段应稍后独立送达。',false);
 const at=Date.now();report.stickerReply=await send('这是已授权的本人表情发送验收。请先用kurumi_sticker list搜索“晚安”，再只发送一个找到的晚安表情，不发送其他表情；发送成功后简短报告，不要再次附图。',true);
 const calls=fs.readFileSync(a.stateDir+'/native-tool-receipts.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(x=>x.at>=at&&x.tool==='kurumi_sticker');
 assert(calls.some(x=>x.action==='list'&&!x.error));const sent=calls.find(x=>x.action==='send'&&!x.error);assert(sent,'Missing successful sticker send');report.stickerResult=JSON.parse(sent.result.content.find(x=>x.type==='text').text);assert(report.stickerResult.ok);
 const ledger=new DatabaseSync(a.stateDir+'/channel.sqlite',{readOnly:true});report.receipts=ledger.prepare('SELECT status,message_id,at FROM outbound WHERE at>=? ORDER BY at').all(report.started);ledger.close();
 assert.equal(report.receipts.length,3);report.readback=[];
 for(const row of report.receipts){assert.equal(row.status,'sent');const msg=await onebot(a,'get_msg',{message_id:Number(row.message_id)});report.readback.push({messageId:row.message_id,types:msg.message.map(x=>x.type),text:msg.message.filter(x=>x.type==='text').map(x=>x.data.text).join('')});}
 assert(report.readback[0].text.includes('短段消息'));assert(report.readback[1].text.includes('独立送达'));assert(report.readback[2].types.includes('image'));assert(report.receipts[1].at-report.receipts[0].at>=400);report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
fs.writeFileSync('docs/verification/migration/15-qq-natural-sticker.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
