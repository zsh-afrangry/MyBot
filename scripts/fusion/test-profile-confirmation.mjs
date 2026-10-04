// Temporarily change the isolated copy, exercise confirmation, then restore its original location.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();const state='/home/afrangry/.openclaw-fusion',cfg=JSON.parse(fs.readFileSync(`${state}/openclaw.json`)),a=account(cfg),login=await onebot(a,'get_login_info',{});let id=-Date.now();
const receipts=()=>fs.readFileSync(a.stateDir+'/native-tool-receipts.jsonl','utf8').trim().split('\n').filter(Boolean).map(JSON.parse);
const resultOf=x=>JSON.parse(x.result.content.find(p=>p.type==='text').text);
const send=text=>rpc('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:id--,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}},150000);
const report={boundary:'Synthetic owner and real model on fusion copy; temporarily set Panyu in isolated copy, negative commit without approval, then original confirmation text, idempotent replay and restore Yangzhong. No QQ send.'},start=Date.now();
try{
 report.propose=await send('这是融合副本的受控写入验收。请将当前所在地暂设为番禺区，先调用personal_profile_change_propose生成提案，location.text使用“番禺区”，不传administrative_area。本轮不提交。验收后我会将副本恢复为扬中市。');
 const proposalCall=receipts().findLast(x=>x.at>=start&&x.tool==='personal_profile_change_propose');assert(proposalCall);const p=resultOf(proposalCall);assert(p.ok&&p.status==='pending');report.proposalId=p.proposalId;
 let at=Date.now();report.denied=await send(`这是拒绝路径验收，不授权提交。请仅调用一次 personal_profile_change_commit，proposal_id=${p.proposalId}，payload_hash=${p.payloadHash}，以检查后端是否拒绝；如后端拒绝就报告，不得换用其他工具。`);
 const denied=receipts().findLast(x=>x.at>=at&&x.tool==='personal_profile_change_commit');assert(denied,'Negative commit was not exercised');report.deniedResult=resultOf(denied);assert.equal(report.deniedResult.ok,false);
 at=Date.now();report.confirmed=await send(p.confirmationInstruction);const committed=receipts().findLast(x=>x.at>=at&&x.tool==='personal_profile_change_commit');assert(committed);report.commitResult=resultOf(committed);assert.equal(report.commitResult.ok,true);
 at=Date.now();report.replayed=await send(p.confirmationInstruction);const repeated=receipts().findLast(x=>x.at>=at&&x.tool==='personal_profile_change_commit');report.replayResult=repeated?resultOf(repeated):null;
 report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
if(report.commitResult?.ok){try{const at=Date.now();await send('验收结束，请把融合副本当前所在地恢复为扬中市，先生成提案。location.text用扬中市，不传administrative_area。');const p=resultOf(receipts().findLast(x=>x.at>=at&&x.tool==='personal_profile_change_propose'));assert(p.ok);if(p.status==='pending'){const confirmAt=Date.now();await send(p.confirmationInstruction);report.restored=resultOf(receipts().findLast(x=>x.at>=confirmAt&&x.tool==='personal_profile_change_commit'));assert(report.restored.ok);}else report.restored=p;}catch(e){report.restoreError=e.message;report.passed=false;process.exitCode=1;}}
fs.writeFileSync('docs/verification/migration/08-profile-confirmation.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,denied:report.deniedResult,committed:report.commitResult,replay:report.replayResult}));
