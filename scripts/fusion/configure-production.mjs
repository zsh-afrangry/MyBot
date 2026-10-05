// Close acceptance-only capability without deleting any conversation or delivery history.
import fs from 'node:fs';import {DatabaseSync} from 'node:sqlite';import {rpc,ready} from './rpc.mjs';
await ready();const state='/home/afrangry/.openclaw-fusion',file=state+'/openclaw.json',cfg=JSON.parse(fs.readFileSync(file));
const jobs=await rpc('cron.list',{includeDisabled:true,limit:100});if(jobs.hasMore||jobs.jobs.some(x=>x.enabled))throw Error('Review active jobs before cutover; no automatic deletion');
const dir=state+'/migration';fs.mkdirSync(dir,{recursive:true,mode:0o700});const before=dir+'/before-production-config.json';if(!fs.existsSync(before))fs.copyFileSync(file,before);fs.chmodSync(before,0o600);
cfg.channels['kurumi-qq'].testIngress=false;delete cfg.channels['kurumi-qq'].sendLimit;cfg.channels['kurumi-qq'].dailySendLimit=500;
cfg.agents.entries.main.tools.alsoAllow=cfg.agents.entries.main.tools.alsoAllow.filter(x=>x!=='kurumi_test_wait');
// Retire the prototype worker configuration; historical state is retained on disk.
delete cfg.agents.entries.worker;
fs.writeFileSync(file,JSON.stringify(cfg,null,2),{mode:0o600});
const db=new DatabaseSync(state+'/channel/channel.sqlite',{readOnly:true});const origins=db.prepare('SELECT origin,COUNT(*) count FROM inbound GROUP BY origin').all();db.close();
fs.writeFileSync('docs/verification/migration/33-production-config.json',JSON.stringify({at:new Date().toISOString(),testIngress:false,lifetimeLimitRemoved:true,dailySendLimit:500,historyPreserved:true,sessionRotated:false,reason:'Historical unknown ingress origin is not assumed synthetic; preserve all conversation history.',origins,activeJobs:0},null,2));console.log('Production configuration saved; restart required. History and delivery ledger preserved.');
