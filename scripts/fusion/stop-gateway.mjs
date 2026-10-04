// Stop only the PID proven to belong to the isolated fusion Gateway launcher.
import fs from 'node:fs';
const state='/home/afrangry/.openclaw-fusion';
const {child}=JSON.parse(fs.readFileSync(`${state}/gateway-pid.json`));
try{const env=fs.readFileSync(`/proc/${child}/environ`,'utf8');if(!env.split('\0').includes(`OPENCLAW_STATE_DIR=${state}`))throw Error('PID is not fusion Gateway');process.kill(child,'SIGTERM');}catch(e){if(e.code!=='ENOENT')throw e;}
