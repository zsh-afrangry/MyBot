// Only the isolated fusion runtime is launched. Keep credentials out of argv/log output.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
const state='/home/afrangry/.openclaw-fusion';
const env=JSON.parse(fs.readFileSync(`${state}/runtime-env.json`));
const fd=fs.openSync(`${state}/gateway.log`,'a',0o600);
const child=spawn(process.execPath,['/home/afrangry/.npm-global/lib/node_modules/openclaw/openclaw.mjs','gateway','run','--port','18890','--bind','loopback','--auth','token','--tailscale','off'],{env:{...process.env,...env,OPENCLAW_STATE_DIR:state,OPENCLAW_CONFIG_PATH:`${state}/openclaw.json`,OPENCLAW_AGENT_DIR:`${state}/agents/main/agent`},stdio:['ignore',fd,fd]});fs.closeSync(fd);
fs.writeFileSync(`${state}/gateway-pid.json`,JSON.stringify({child:child.pid}),{mode:0o600});
process.on('SIGTERM',()=>child.kill('SIGTERM'));child.on('exit',code=>{console.log('Fusion Gateway exited: '+code);process.exitCode=code??0;});
