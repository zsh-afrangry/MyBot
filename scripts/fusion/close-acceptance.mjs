// Close synthetic ingress after all acceptance tasks finish; never reset the send ledger.
import fs from 'node:fs';
import {DatabaseSync} from 'node:sqlite';
import {rpc,ready} from './rpc.mjs';
await ready();
const state='/home/afrangry/.openclaw-fusion',p=`${state}/openclaw.json`,cfg=JSON.parse(fs.readFileSync(p));
const jobs=await rpc('cron.list',{includeDisabled:true});if(jobs.jobs?.some(j=>j.enabled))throw Error('Pending Cron tasks must be reviewed before closeout');
const db=new DatabaseSync(`${state}/channel/channel.sqlite`,{readOnly:true});const inbound=db.prepare('SELECT id FROM inbound').all();db.close();
// Do not rotate a conversation if an actual positive QQ event has arrived during testing.
const syntheticOnly=inbound.every(x=>Number(x.id.split(':').at(-1))<0);
let rotated=false;
if(syntheticOnly){const result=await rpc('sessions.reset',{key:'agent:main:kurumi-qq:direct:365999865',reason:'new'});rotated=result.ok===true;}
cfg.channels['kurumi-qq'].testIngress=false;
cfg.agents.entries.main.tools.alsoAllow=cfg.agents.entries.main.tools.alsoAllow.filter(x=>x!=='kurumi_test_wait');
fs.writeFileSync(p,JSON.stringify(cfg,null,2),{mode:0o600});
fs.writeFileSync('docs/verification/fusion/16-closeout.json',JSON.stringify({at:new Date().toISOString(),enabledJobs:jobs.jobs?.filter(j=>j.enabled).length??0,disabledDeclarations:jobs.jobs?.filter(j=>!j.enabled).map(j=>({id:j.id,name:j.name}))??[],syntheticOnly,rotated,testIngress:false,sendLedgerPreserved:true},null,2));
console.log('Acceptance ingress disabled; restart Gateway to verify method removal.');
