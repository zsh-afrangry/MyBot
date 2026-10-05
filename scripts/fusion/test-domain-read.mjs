// Read-only natural language domain acceptance. No QQ send and no preference writes.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {rpc,ready} from './rpc.mjs';
import {account} from '../../chatbot/plugins/kurumi-qq/src/config.js';
import {onebot} from '../../chatbot/plugins/kurumi-qq/src/transport.js';
import {freshMessageId} from './lib/fresh-id.mjs';
await ready();const state='/home/afrangry/.openclaw-fusion',cfg=JSON.parse(fs.readFileSync(`${state}/openclaw.json`)),a=account(cfg),login=await onebot(a,'get_login_info',{}),started=Date.now();
function hashFacts(){const db=new DatabaseSync(`${state}/state/personal-weather/weather.sqlite`,{readOnly:true});try{return createHash('sha256').update(JSON.stringify(['notification_preferences','trips'].map(t=>db.prepare(`SELECT * FROM ${t}`).all()))).digest('hex');}finally{db.close();}}
const report={boundary:'Synthetic trusted owner, real model and QWeather tools, captured reply; unchanged preferences/trips required.',before:hashFacts()};
const event={post_type:'message',message_type:'private',self_id:login.user_id,user_id:Number(a.ownerId),message_id:freshMessageId(),time:Math.floor(Date.now()/1000),message:[{type:'text',data:{text:'请实际调用personal_profile_state_get告诉我当前保存的天气地点，再调用personal_weather_get_brief查询广州番禺区天气。这只是临时查询，不要修改任何所在地或行程；没有调用成功就说明失败，不要搜索网页代替天气工具。'}}]};
try{
 const reply=await rpc('kurumi-qq.testInbound',{event,capture:true},180000);report.reply=reply.captured;
 const calls=fs.readFileSync(a.stateDir+'/native-tool-receipts.jsonl','utf8').trim().split('\n').map(JSON.parse).filter(x=>x.at>=started);
 report.tools=calls.map(x=>{let r;try{r=JSON.parse(x.result?.content?.find(c=>c.type==='text')?.text??'null');}catch{}return {name:x.tool,ok:r?.ok??null,error:x.error,code:r?.code??r?.error?.code};});
 for(const name of ['personal_profile_state_get','personal_weather_get_brief'])assert(report.tools.some(x=>x.name===name&&x.ok===true&&!x.error),'Missing successful '+name);
 report.after=hashFacts();assert.equal(report.before,report.after);report.passed=true;
}catch(e){report.error=e.message;report.passed=false;process.exitCode=1;}
fs.writeFileSync('docs/verification/migration/06-domain-read.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
