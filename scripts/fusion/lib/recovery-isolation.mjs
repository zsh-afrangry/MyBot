// Recovery verification is not production deployment. Only an empty private /tmp directory is allowed.
import fs from 'node:fs';
import path from 'node:path';
export const PRODUCTION_STATE='/home/afrangry/.openclaw-fusion';
export const PRODUCTION_REPO='/home/afrangry/kurumi-fusion';
export function newRecoveryTarget(requested){
 if(!requested)return fs.mkdtempSync('/tmp/kurumi-restore-');
 const p=path.resolve(requested),parent=path.dirname(p);
 if(!p.startsWith('/tmp/')||fs.realpathSync(parent)!==parent||fs.existsSync(p)||fs.lstatSync(parent).isSymbolicLink())throw Error('Recovery target must be a new directory directly under a canonical /tmp path');
 fs.mkdirSync(p,{mode:0o700});return p;
}
export function remap(value,runtime,repo){
 if(Array.isArray(value))return value.map(x=>remap(x,runtime,repo));
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,remap(v,runtime,repo)]));
 if(typeof value==='string')for(const [from,to] of [[PRODUCTION_STATE,runtime],[PRODUCTION_REPO,repo]])if(value===from||value.startsWith(from+'/'))return to+value.slice(from.length);
 return value;
}
export function assertNoProduction(value){
 if(typeof value==='string'&&(value.includes(PRODUCTION_STATE)||value.includes(PRODUCTION_REPO)))throw Error('Active recovery configuration still references production');
 if(value&&typeof value==='object')for(const v of Object.values(value))assertNoProduction(v);
}
export function remapLinks(root,runtime,repo){
 for(const e of fs.readdirSync(root,{withFileTypes:true})){
  const p=path.join(root,e.name);
  if(e.isSymbolicLink()){
   const to=fs.readlinkSync(p),mapped=remap(to,runtime,repo);
   if(mapped!==to){fs.unlinkSync(p);fs.symlinkSync(mapped,p);}
  }else if(e.isDirectory()&&e.name!=='.git')remapLinks(p,runtime,repo);
 }
}
export function sandboxArgs(target){
 if(!target.startsWith('/tmp/')||fs.realpathSync(target)!==target)throw Error('Noncanonical sandbox target');
 return ['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL',
  '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
  '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',target,target,
  '--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','HOME',target+'/home',
  '--setenv','LANG','C.UTF-8','--setenv','TMPDIR','/tmp'];
}
