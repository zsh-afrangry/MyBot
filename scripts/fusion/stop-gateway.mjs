// Idempotently stop only the PID whose environment proves isolated fusion ownership.
import fs from 'node:fs';
const state='/home/afrangry/.openclaw-fusion';
try{
 const {child}=JSON.parse(fs.readFileSync(`${state}/gateway-pid.json`));
 const env=fs.readFileSync(`/proc/${child}/environ`,'utf8');
 if(!env.split('\0').includes(`OPENCLAW_STATE_DIR=${state}`))throw Error('PID is not fusion Gateway');
 process.kill(child,'SIGTERM');
 for(let i=0;i<100;i++){if(!fs.existsSync(`/proc/${child}`)){console.log('Fusion Gateway stopped');process.exit(0);}await new Promise(r=>setTimeout(r,200));}
 throw Error('Fusion Gateway did not exit within 20 seconds; inspect before restart');
}catch(e){if(e.code!=='ENOENT'&&e.code!=='ESRCH')throw e;console.log('Fusion Gateway already stopped');}
