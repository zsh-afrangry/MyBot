// Authorized maintenance fault injection. No model calls or QQ sends.
import fs from 'node:fs';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';import {rpc} from './rpc.mjs';
const state='/home/afrangry/.openclaw-fusion',r={at:new Date().toISOString(),boundary:'SIGKILL only verified fusion Gateway; systemd restarts it. Restart only SnowLuma transport, preserving its source/config and QQ client.'};
const ctl=(...args)=>{const p=spawnSync('systemctl',['--user',...args],{encoding:'utf8',timeout:45000});if(p.status!==0)throw Error(p.stderr);return p.stdout.trim();};
const sleep=ms=>new Promise(x=>setTimeout(x,ms));async function connected(){try{const s=await rpc('channels.status',{probe:true},3000);return s.channelAccounts?.['kurumi-qq']?.some(x=>x.running&&x.connected);}catch{return false;}}
try{assert.equal(ctl('is-active','kurumi-fusion.service'),'active');r.before=JSON.parse(fs.readFileSync(state+'/gateway-pid.json')).child;assert(fs.readFileSync(`/proc/${r.before}/environ`,'utf8').split('\0').includes('OPENCLAW_STATE_DIR='+state));process.kill(r.before,'SIGKILL');
 for(let i=0;i<35;i++){await sleep(1000);r.after=JSON.parse(fs.readFileSync(state+'/gateway-pid.json')).child;if(r.after!==r.before&&await connected())break;}
 assert.notEqual(r.after,r.before);assert(await connected());r.restartProperties=ctl('show','kurumi-fusion.service','-p','ActiveState','-p','NRestarts');
 ctl('stop','snowluma.service');for(let i=0;i<10;i++){await sleep(500);if(!await connected()){r.disconnectObserved=true;break;}}assert(r.disconnectObserved);
 ctl('start','snowluma.service');for(let i=0;i<30;i++){await sleep(1000);if(await connected()){r.reconnected=true;break;}}assert(r.reconnected);assert.equal(JSON.parse(fs.readFileSync(state+'/gateway-pid.json')).child,r.after);r.passed=true;
}catch(e){r.passed=false;r.error=e.message;process.exitCode=1;}
finally{if(ctl('show','snowluma.service','-p','ActiveState','--value')!=='active')ctl('start','snowluma.service');}
fs.writeFileSync('docs/verification/migration/35-service-recovery.json',JSON.stringify(r,null,2));console.log(JSON.stringify(r));
