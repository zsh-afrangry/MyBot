// The backup owns only the stop it performed. Signals restore availability, never validate a partial backup.
import {spawnSync} from 'node:child_process';
export function serviceLease({run=spawnSync, service='kurumi-fusion.service', record=()=>{}}={}) {
 let restartNeeded=false, quiesced=false;
 const invoke=(...args)=>run('systemctl',['--user',...args,service],{encoding:'utf8',timeout:60000});
 const state=()=>{const r=invoke('show','-p','ActiveState','--value');if(r.status!==0)throw Error('Cannot inspect backup service');return r.stdout.trim();};
 return {
  get quiesced(){return quiesced;},
  stop(){
   const before=state();if(!['active','inactive','failed'].includes(before))throw Error(`Refusing backup during service transition: ${before}`);
   record({service,before,restartNeeded:before==='active'});
   if(before==='active'){
    restartNeeded=true; // Set before stop: a failing stop can still change service state.
    const r=invoke('stop');if(r.status!==0)throw Error('Cannot stop backup service');
   }
   if(!['inactive','failed'].includes(state()))throw Error('Service did not stop');
   quiesced=true;
  },
  restore(){
   if(!restartNeeded)return;
   const r=invoke('start');
   if(r.status!==0||state()!=='active')throw Error('Service restart failed; manually inspect kurumi-fusion.service');
   restartNeeded=false;
  }
 };
}
export function installBackupExitHandlers(lease,{onFailure=()=>{}}={}) {
 const finish=()=>{try{lease.restore();}catch(e){onFailure(e);process.exitCode=1;}};
 const signals=new Map([['SIGINT',130],['SIGTERM',143],['SIGHUP',129]]);
 const handlers=[];
 for(const [signal,code] of signals){const fn=()=>{finish();process.exit(code);};process.once(signal,fn);handlers.push([signal,fn]);}
 const fatal=e=>{onFailure(e);finish();process.exit(1);};
 for(const event of ['uncaughtException','unhandledRejection']){process.once(event,fatal);handlers.push([event,fatal]);}
 process.once('exit',finish);handlers.push(['exit',finish]);
 return ()=>{for(const [event,fn] of handlers)process.removeListener(event,fn);};
}
