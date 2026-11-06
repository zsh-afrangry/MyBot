// Bounded private diagnostic retention; no business database or credential access.
import fs from 'node:fs';
import path from 'node:path';

export function pruneDiagnostics(root, {now=Date.now(), maxAgeMs=7*86400000, maxBytes=60*1024*1024}={}) {
  const candidates=[];
  const add=file=>{const s=fs.lstatSync(file);if(s.isFile())candidates.push({file,size:s.size,mtime:s.mtimeMs});};
  const logs=path.join(root,'logs');
  function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())walk(f);else if(e.isFile())add(f);}}
  if(fs.existsSync(logs)&&!fs.lstatSync(logs).isSymbolicLink())walk(logs);
  for(const name of ['runtime.1.log','runtime.2.log'])if(fs.existsSync(path.join(root,name)))add(path.join(root,name));
  const primary=path.join(root,'runtime.log');
  let total=fs.existsSync(primary)?fs.lstatSync(primary).size:0;
  const removed=[];
  for(const item of candidates.sort((a,b)=>b.mtime-a.mtime)){
    if(now-item.mtime>maxAgeMs||total+item.size>maxBytes){fs.unlinkSync(item.file);removed.push(path.relative(root,item.file));}
    else total+=item.size;
  }
  return {removed,retainedBytes:total};
}

// Called only before a new gateway starts or after its child has exited. Captured code is
// recreated by the plugin loader; document jobs persist no references to an old capture path.
export function clearGatewayCaptures(root) {
  const dir=path.join(root,'tmp/plugin-captures');
  if(!fs.existsSync(dir))return;
  if(fs.lstatSync(dir).isSymbolicLink())throw Error('Unexpected plugin capture symlink');
  fs.rmSync(dir,{recursive:true});
}
