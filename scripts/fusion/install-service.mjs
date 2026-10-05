// Idempotent local cutover. Keeps original units and records their initial state privately.
import fs from 'node:fs';import {spawnSync} from 'node:child_process';import {homedir} from 'node:os';
const root='/home/afrangry/kurumi-fusion',state='/home/afrangry/.openclaw-fusion';const cfg=JSON.parse(fs.readFileSync(state+'/openclaw.json'));if(cfg.channels['kurumi-qq'].testIngress!==false)throw Error('Close acceptance ingress before installing the default service');
function run(args){const r=spawnSync('systemctl',['--user',...args],{encoding:'utf8',timeout:45000});if(r.status!==0)throw Error(r.stderr||'systemctl failed');return r.stdout.trim();}
const snapshot=state+'/migration/service-state-before-cutover.json';if(!fs.existsSync(snapshot)){const units={};for(const name of ['qq-bridge','openclaw-gateway','snowluma','snowluma-qq'])units[name]=run(['show',name+'.service','-p','ActiveState','-p','UnitFileState','-p','FragmentPath']);fs.writeFileSync(snapshot,JSON.stringify({at:new Date().toISOString(),units},null,2),{mode:0o600});}
const dir=homedir()+'/.config/systemd/user';fs.mkdirSync(dir,{recursive:true});fs.copyFileSync(root+'/scripts/fusion/systemd/kurumi-fusion.service',dir+'/kurumi-fusion.service');fs.chmodSync(dir+'/kurumi-fusion.service',0o600);
run(['daemon-reload']);run(['disable','--now','qq-bridge.service','openclaw-gateway.service']);
const stopped=spawnSync(process.execPath,[root+'/scripts/fusion/stop-gateway.mjs'],{encoding:'utf8',timeout:30000});if(stopped.status!==0)throw Error(stopped.stderr||stopped.stdout);
run(['enable','--now','kurumi-fusion.service']);console.log('Fusion enabled and started; old user assistant services disabled. SnowLuma transport retained.');
