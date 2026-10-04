// Real model creates a clearly tagged trip in the isolated database; operator archives only that test row.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
await ready();const state='/home/afrangry/.openclaw-fusion',a=account(JSON.parse(fs.readFileSync(`${state}/openclaw.json`))),login=await onebot(a,'get_login_info',{});
const db=new DatabaseSync(`${state}/state/personal-weather/weather.sqlite`);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000');
const original=db.prepare('SELECT * FROM trips ORDER BY id').all(),prefs=JSON.stringify(db.prepare('SELECT * FROM notification_preferences').all());
const report={boundary:'Synthetic owner and real model, original confirmation, one tagged test trip in fusion copy only, captured replies. Operator marks created test row cancelled afterward; no owner trip edited.',started:Date.now()};let id=-Date.now();
const send=text=>rpc('kurumi-qq.testInbound',{capture:true,event:{post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:id--,time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text}}]}},150000);
const result=tool=>{const call=fs.readFileSync(a.stateDir+'/native-tool-receipts.jsonl','utf8').trim().split('\n').map(JSON.parse).findLast(x=>x.at>=report.started&&x.tool===tool);assert(call,tool);return JSON.parse(call.result.content.find(x=>x.type==='text').text);};
try{
 report.proposed=await send('请生成一条行程保存提案：标题“架构验证-行程迁移”，目的地扬中市，交通方式汽车，日期尚未决定，天气模式none。只生成提案，不填写出发到达时间，不要改变所在地。');report.proposal=result('personal_planning_change_propose');assert(report.proposal.ok);assert.equal(db.prepare('SELECT count(*) n FROM trips').get().n,original.length);
 report.confirmed=await send(report.proposal.confirmationInstruction);report.committed=result('personal_planning_change_commit');assert(report.committed.ok);
 const created=db.prepare('SELECT * FROM trips WHERE id NOT IN ('+(original.map(()=>'?').join(',')||'NULL')+')').all(...original.map(r=>r.id));assert.equal(created.length,1);assert.equal(created[0].title,'架构验证-行程迁移');report.createdId=created[0].id;assert.equal(created[0].departure_earliest_utc,null);assert.equal(created[0].arrival_earliest_utc,null);assert.equal(JSON.stringify(db.prepare('SELECT * FROM notification_preferences').all()),prefs);report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
finally{if(report.createdId){report.cleanup=db.prepare("UPDATE trips SET state='cancelled',updated_at_utc=? WHERE id=? AND title='架构验证-行程迁移'").run(Math.floor(Date.now()/1000),report.createdId);assert.equal(report.cleanup.changes,1);}report.originalTripsUnchanged=original.every(row=>JSON.stringify(db.prepare('SELECT * FROM trips WHERE id=?').get(row.id))===JSON.stringify(row));db.close();}
fs.writeFileSync('docs/verification/migration/11-planning-confirmation.json',JSON.stringify(report,null,2));console.log(JSON.stringify({passed:report.passed,error:report.error,originalTripsUnchanged:report.originalTripsUnchanged}));
