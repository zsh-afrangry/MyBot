// Real native Cron CRUD + native channel delivery. No custom reminder scheduler.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {rpc,ready} from './rpc.mjs';
await ready();
const file='/home/afrangry/kurumi-fusion/docs/verification/fusion/04-native-cron.json';
const mode=process.argv[2]??'create';
if(mode==='create'){
 const base={enabled:true,sessionTarget:'isolated',wakeMode:'now',payload:{kind:'command',argv:['/usr/bin/printf','%s','【融合验收】这是 OpenClaw 原生调度经过新 QQ 频道发送的重启提醒。'],timeoutSeconds:10},delivery:{mode:'announce',channel:'kurumi-qq',to:'user:365999865',accountId:'default'},deleteAfterRun:true};
 const created=await rpc('cron.add',{...base,name:'kurumi.fusion.test.restart',schedule:{kind:'at',at:new Date(Date.now()+60000).toISOString()}});
 const id=created.id??created.job?.id;assert(id);
 const updated=await rpc('cron.update',{id,patch:{schedule:{kind:'at',at:new Date(Date.now()+90000).toISOString()}}});
 const other=await rpc('cron.add',{...base,name:'kurumi.fusion.test.cancel',schedule:{kind:'at',at:new Date(Date.now()+86400000).toISOString()}});
 const canceled=await rpc('cron.remove',{id:other.id??other.job?.id});
 fs.writeFileSync(file,JSON.stringify({boundary:'Native isolated Cron and native kurumi-qq outbound; operator-created deterministic command',created,updated,canceled,id},null,2));console.log(JSON.stringify({id,canceled}));
}else{
 const r=JSON.parse(fs.readFileSync(file));r.checkedAt=new Date().toISOString();r.runs=await rpc('cron.runs',{id:r.id,limit:10});r.jobs=await rpc('cron.list',{includeDisabled:true});fs.writeFileSync(file,JSON.stringify(r,null,2));console.log(JSON.stringify({runs:r.runs.entries?.map(x=>({status:x.status,completionStatus:x.completionStatus,deliveryStatus:x.deliveryStatus,error:x.error}))}));
}
