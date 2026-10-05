// Only the isolated fusion runtime is launched. Keep credentials out of argv/log output.
import fs from 'node:fs';
import {spawn,spawnSync} from 'node:child_process';
const state='/home/afrangry/.openclaw-fusion';
const installed=JSON.parse(fs.readFileSync('/home/afrangry/.npm-global/lib/node_modules/openclaw/package.json'));
if(installed.version!=='2026.9.7')throw Error('OpenClaw version changed; rerun contract acceptance first');
const bridge=spawnSync('systemctl',['--user','is-active','qq-bridge.service'],{encoding:'utf8',timeout:3000});
if(bridge.stdout?.trim()==='active')throw Error('Stop old qq-bridge.service before starting fusion (avoid double replies)');
try{const old=JSON.parse(fs.readFileSync(`${state}/gateway-pid.json`));const oldEnv=fs.readFileSync(`/proc/${old.child}/environ`,'utf8');if(oldEnv.split('\0').includes(`OPENCLAW_STATE_DIR=${state}`))throw Error('Fusion Gateway already running');}catch(e){if(e.code!=='ENOENT')throw e;}
const env=JSON.parse(fs.readFileSync(`${state}/runtime-env.json`));
const journal=process.env.KURUMI_LOG_TARGET==='journal';
const fd=journal?undefined:fs.openSync(`${state}/gateway.log`,'a',0o600);
const child=spawn(process.execPath,['/home/afrangry/.npm-global/lib/node_modules/openclaw/openclaw.mjs','gateway','run','--port','18890','--bind','loopback','--auth','token','--tailscale','off'],{env:{...process.env,...env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:`${state}/openclaw.json`,OPENCLAW_AGENT_DIR:`${state}/agents/main/agent`},stdio:journal?['ignore','inherit','inherit']:['ignore',fd,fd]});if(fd!==undefined)fs.closeSync(fd);
fs.writeFileSync(`${state}/gateway-pid.json`,JSON.stringify({child:child.pid}),{mode:0o600});
let stopping=false;for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>{stopping=true;child.kill(signal);});
child.on('error',()=>{console.error('Fusion Gateway failed to start');process.exitCode=1;});
child.on('exit',(code,signal)=>{console.log('Fusion Gateway exited: '+(code??signal));process.exitCode=stopping?0:(code??1);});
