// Fusion v3 backup layout: immutable dependency artifacts and complete retained SQLite discovery.
import fs from 'node:fs';import path from 'node:path';import{createHash,randomUUID}from'node:crypto';import{spawnSync}from'node:child_process';
export const BACKUP_ROOT='/home/afrangry/kurumi-backups';
export const PILOT_ROOT='/home/afrangry/.local/share/kurumi-coding-pilot-20261029';
export const DSH_HOME='/var/lib/dsh/.dsh';
export const EXEC_FENCE_ROOT='/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64';
export const LEGACY_EXEC_FENCE_ROOT='/opt/deepseek-harness/node_modules/@deepseek-ai/node-addon-system-linux-x64';
export const SDK_ROOT='/home/afrangry/.npm-global/lib/node_modules/openclaw';
// Unscoped v3 points retain their original DSH recovery contract; new points own only Fusion.
export function artifactKindsForRestore(expected){
 if(expected?.formatVersion!==3)throw Error('Fusion v3 EXPECTED.json required');
 if(expected.scope===undefined)return ['openclaw','paper-python','dsh'];
 if(expected.scope!=='fusion-only')throw Error('Unknown backup scope');
 return ['openclaw','paper-python','exec-fence'];
}
export const SKIP_RUNTIME=new Set(['tmp','plugins','venvs','gateway.log','runtime.log','runtime.1.log','runtime.2.log','logs','gateway-pid.json','paper-acceptance','research-cache','cache']);
export function skippedRuntime(name){return SKIP_RUNTIME.has(name)||/^openclaw\.json\.bak(?:\.|$)/.test(name)||/\.tmp\.\d+$/.test(name);}
export function hashFile(file){const h=createHash('sha256'),b=Buffer.alloc(1024*1024),fd=fs.openSync(file,'r');try{let n;while((n=fs.readSync(fd,b,0,b.length,null)))h.update(b.subarray(0,n));}finally{fs.closeSync(fd);}return h.digest('hex');}
export function treeHash(root){const h=createHash('sha256');function walk(dir,base=''){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(e.name==='__pycache__')continue;const rel=base?base+'/'+e.name:e.name,f=path.join(dir,e.name);if(e.isDirectory())walk(f,rel);else if(e.isSymbolicLink())h.update(JSON.stringify([rel,'link',fs.readlinkSync(f)])+'\n');else if(e.isFile())h.update(JSON.stringify([rel,fs.statSync(f).mode&0o777,hashFile(f)])+'\n');else throw Error('Unsupported artifact entry');}}walk(root);return h.digest('hex');}
export function ensureArtifact(kind,version,source,store=path.join(BACKUP_ROOT,'artifacts')){
 if(!/^[\w.-]+$/.test(kind)||!/^[\w.-]+$/.test(version))throw Error('Invalid artifact identity');
 fs.mkdirSync(store,{recursive:true,mode:0o700});const fingerprint=treeHash(source),name=`${kind}-${version}-${fingerprint.slice(0,16)}.tar.gz`,archive=path.join(store,name),meta=archive+'.json';
 if(fs.existsSync(meta)){const prior=JSON.parse(fs.readFileSync(meta));if(prior.treeHash!==fingerprint||hashFile(archive)!==prior.sha256)throw Error('Cached artifact corrupted');return prior;}
 if(fs.existsSync(archive))throw Error('Unregistered artifact already exists');const tmp=archive+'.tmp-'+randomUUID();
 try{const r=spawnSync('tar',['-I','gzip -1','--exclude=__pycache__','-cf',tmp,'-C',path.dirname(source),path.basename(source)],{encoding:'utf8',timeout:180000});if(r.status!==0)throw Error('Dependency artifact archive failed');if(treeHash(source)!==fingerprint)throw Error('Dependency source changed while archiving');const record={kind,version,name,rootName:path.basename(source),sha256:hashFile(tmp),treeHash:fingerprint,bytes:fs.statSync(tmp).size,platform:process.platform,arch:process.arch};fs.chmodSync(tmp,0o600);fs.renameSync(tmp,archive);fs.writeFileSync(meta,JSON.stringify(record,null,2)+'\n',{mode:0o600});return record;}finally{fs.rmSync(tmp,{force:true});}
}
export function discoverDatabases(root,{skip=SKIP_RUNTIME}={}){
 const out=[];function walk(dir,depth=0){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory()){if((depth===0&&skip.has(e.name))||['node_modules','__pycache__','.git','.cache'].includes(e.name))continue;walk(f,depth+1);}else if(e.isFile()&&/\.(sqlite|db)$/.test(e.name))out.push(f);}}walk(root);return out.sort();
}
