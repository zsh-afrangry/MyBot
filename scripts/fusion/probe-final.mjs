// Read-only handoff assertions. Does not send a QQ message or create a task.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from './rpc.mjs';
await ready();const state='/home/afrangry/.openclaw-fusion',cfg=JSON.parse(fs.readFileSync(`${state}/openclaw.json`));
const report={at:new Date().toISOString(),testIngress:cfg.channels['kurumi-qq'].testIngress};assert.equal(report.testIngress,false);
try{await rpc('kurumi-qq.testInbound',{});throw Error('Synthetic ingress still callable');}catch(e){report.testMethodError=e.message;assert.match(e.message,/unknown method|not found/i);}
const jobs=await rpc('cron.list',{includeDisabled:true});report.enabledJobs=jobs.jobs.filter(j=>j.enabled).map(j=>({id:j.id,name:j.name}));assert.equal(report.enabledJobs.length,0);
const status=await rpc('channels.status',{probe:true});report.channel=status.channelAccounts?.['kurumi-qq']?.map(x=>({accountId:x.accountId,running:x.running,connected:x.connected}));assert(report.channel?.some(x=>x.running&&x.connected),'QQ channel not connected');
const db=new DatabaseSync(`${state}/channel/channel.sqlite`,{readOnly:true});report.outbound=db.prepare('SELECT status,COUNT(*) count FROM outbound GROUP BY status').all();db.close();assert(report.outbound.reduce((n,x)=>n+x.count,0)<=10);
report.passed=true;fs.writeFileSync('docs/verification/fusion/18-final-runtime.json',JSON.stringify(report,null,2));console.log(JSON.stringify(report));
