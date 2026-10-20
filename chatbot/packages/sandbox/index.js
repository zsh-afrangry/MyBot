// OS isolation for project code: only its checkout is writable, no host HOME or external network.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
export function sandboxArguments(project,argv){
 if(!Array.isArray(argv)||!argv.length||argv.some(x=>typeof x!=='string'||x.includes('\0')))throw Error('Invalid check command');
 const args=['--unshare-all','--die-with-parent','--new-session','--clearenv'];
 for(const dir of ['/usr','/bin','/lib','/lib64'])if(fs.existsSync(dir))args.push('--ro-bind',dir,dir);
 for(const dir of project.readOnlyDependencies??[]){const canonical=fs.realpathSync(dir);if(!canonical.startsWith('/home/afrangry/.npm-global/lib/node_modules/'))throw Error('Dependency mount outside installed package tree');args.push('--ro-bind',canonical,canonical);}
 args.push('--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',project.root,'/workspace','--chdir','/workspace','--setenv','HOME','/tmp','--setenv','PATH','/usr/bin:/bin','--setenv','LANG','C.UTF-8');
 for(const fixture of project.fixtures??[]){if(!/^\/checks\/[a-zA-Z0-9_.-]+$/.test(fixture.target))throw Error('Invalid fixture target');args.push('--ro-bind',fs.realpathSync(fixture.source),fixture.target);}
 return [...args,'--',...argv];
}
export async function runSandbox(project,argv,{signal,timeoutMs=60000}={}){
 signal?.throwIfAborted();const args=sandboxArguments(project,argv);
 return new Promise((resolve,reject)=>{
  const child=spawn('/usr/bin/bwrap',args,{env:{PATH:'/usr/bin:/bin'},stdio:['ignore','pipe','pipe'],detached:true});let output='',truncated=false,timedOut=false;
  const kill=()=>{try{process.kill(-child.pid,'SIGKILL');}catch{}};
  const timer=setTimeout(()=>{timedOut=true;kill();},Math.min(Math.max(timeoutMs,1000),180000));
  const abort=()=>kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const collect=bytes=>{const text=bytes.toString();const room=32000-output.length;output+=text.slice(0,Math.max(room,0));if(text.length>room)truncated=true;};child.stdout.on('data',collect);child.stderr.on('data',collect);
  const cleanup=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);};
  child.once('error',e=>{cleanup();reject(e);});child.once('exit',(code,stopped)=>{cleanup();resolve({code,signal:stopped,timedOut,aborted:signal?.aborted??false,truncated,output});});
 });
}
