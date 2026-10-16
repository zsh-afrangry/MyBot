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
// A recovery copy never starts paid paper jobs, even outside its test sandbox.
export function disablePaperRecovery(cfg,runtime){
 const paper=cfg.plugins?.entries?.['kurumi-papers']?.config;
 if(!paper)return;
 paper.liveTranslationEnabled=false;
 const file=paper.credentialsFile;
 const boundary=fs.realpathSync(runtime)+path.sep;
 if(typeof file!=='string'||!path.resolve(file).startsWith(boundary))throw Error('Recovery paper credential path must be inside restored runtime');
 if(fs.existsSync(file)){
  if(!fs.realpathSync(file).startsWith(boundary))throw Error('Recovery paper credential path must be inside restored runtime');
  if(fs.lstatSync(file).isSymbolicLink()||!fs.statSync(file).isFile())throw Error('Recovery paper credentials must be regular');
  fs.writeFileSync(file,'{}',{mode:0o600});fs.chmodSync(file,0o600);
 }
}
// Shared business data is external to the Fusion SQLite snapshot. Recovery probes
// must remain inert even if somebody starts a copied fixed runner outside bwrap.
export function disableKnowledgeMapRecovery(cfg,runtime){
 if(!runtime.startsWith('/tmp/')||fs.realpathSync(runtime)!==runtime)throw Error('Recovery runtime must be canonical and under /tmp');
 const boundary=fs.realpathSync(runtime)+path.sep;
 const token=path.join(runtime,'knowledgemap-recovery-disabled-token');
 if(fs.lstatSync(token,{throwIfNoEntry:false})?.isSymbolicLink())throw Error('Recovery token must not be a symlink');
 fs.writeFileSync(token,'recovery-disabled',{mode:0o600});fs.chmodSync(token,0o600);
 for(const name of ['kurumi-knowledgemap','personal-reminder-list','personal-weather']){
  const entry=cfg.plugins?.entries?.[name],config=entry?.config;
  if(!config)continue;
  if(name==='kurumi-knowledgemap'){
   entry.enabled=false;config.baseUrl='http://127.0.0.1:9';config.tokenFile=token;
  }else if(config.dataSource==='knowledgemap'||config.weatherBackend==='knowledgemap'){
   entry.enabled=false;config.bridgeBaseUrl='http://127.0.0.1:9';config.bridgeTokenFile=token;
  }
 }
 const marker=path.join(runtime,'state/personal-reminder-list/data-source.json');
 if(fs.existsSync(marker)){
  if(fs.lstatSync(marker).isSymbolicLink()||!fs.realpathSync(marker).startsWith(boundary))throw Error('Recovery cutover marker must be inside runtime');
  const source=JSON.parse(fs.readFileSync(marker,'utf8'));
  source.baseUrl='http://127.0.0.1:9';source.tokenFile=token;
  fs.writeFileSync(marker,JSON.stringify(source),{mode:0o600});fs.chmodSync(marker,0o600);
 }
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
 // Preserve the worker SDK allowlist path using only the recovered archive, never host SDK files.
 const sdk=path.join(target,'sdk/openclaw');
 const sdkAlias=fs.existsSync(sdk)?['--ro-bind',sdk,'/home/afrangry/.npm-global/lib/node_modules/openclaw']:[];
 return ['--unshare-all','--die-with-parent','--new-session','--cap-drop','ALL',
  '--ro-bind','/usr','/usr','--symlink','usr/bin','/bin','--symlink','usr/lib','/lib','--symlink','usr/lib64','/lib64',
  '--proc','/proc','--dev','/dev','--tmpfs','/tmp','--bind',target,target,
  ...sdkAlias,'--clearenv','--setenv','PATH','/usr/bin:/bin','--setenv','HOME',target+'/home',
  '--setenv','LANG','C.UTF-8','--setenv','TMPDIR','/tmp'];
}
