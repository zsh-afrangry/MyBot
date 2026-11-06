// Retention applies only to v3 points attested by a successful isolated restoration.
import fs from 'node:fs';
import path from 'node:path';
import {hashFile} from './backup-layout.mjs';
export function retentionPlan(root,{keep=2}={}) {
  if (!Number.isInteger(keep)||keep<2) throw Error('Keep at least two verified points');
  const points=[];
  for (const e of fs.readdirSync(root,{withFileTypes:true})) {
    if (!e.isDirectory()||e.name.startsWith('.')) continue;
    const dir=path.join(root,e.name);
    if (!fs.existsSync(dir+'/EXPECTED.json')||!fs.existsSync(dir+'/VERIFIED.json')||fs.existsSync(dir+'/INCOMPLETE.json')) continue;
    const expected=JSON.parse(fs.readFileSync(dir+'/EXPECTED.json'));
    const receipt=JSON.parse(fs.readFileSync(dir+'/VERIFIED.json'));
    if (expected.formatVersion===3&&receipt.ok&&receipt.level==='isolated-gateway'
      &&receipt.manifestHash===hashFile(dir+'/MANIFEST.sha256')&&receipt.expectedHash===hashFile(dir+'/EXPECTED.json')) points.push({name:e.name,stamp:expected.stamp});
  }
  points.sort((a,b)=>b.stamp.localeCompare(a.stamp)||b.name.localeCompare(a.name));
  return {retained:points.slice(0,keep).map(p=>p.name),remove:points.slice(keep).map(p=>p.name)};
}

// Plan artifact deletion only after considering every surviving point, including failed points.
// Unregistered files are reported for manual review, never swept by a filename glob.
export function artifactRetentionPlan(root,{removePoints=[]}={}) {
  const store=path.join(root,'artifacts'),referenced=new Set();
  for(const e of fs.readdirSync(root,{withFileTypes:true})){
    if(!e.isDirectory()||removePoints.includes(e.name))continue;
    const file=path.join(root,e.name,'EXPECTED.json');
    if(!fs.existsSync(file))continue;
    const expected=JSON.parse(fs.readFileSync(file));
    if(expected.formatVersion!==3)continue;
    for(const a of expected.artifacts??[]){
      if(typeof a.name!=='string'||path.basename(a.name)!==a.name||!a.name.endsWith('.tar.gz'))throw Error('Invalid artifact reference');
      if(!fs.existsSync(path.join(store,a.name)))throw Error('Referenced artifact missing: '+a.name);
      referenced.add(a.name);
    }
  }
  const retained=[],remove=[],managed=new Set();
  if(!fs.existsSync(store))return {retained,remove,unmanaged:[]};
  const entries=fs.readdirSync(store).sort();
  for(const name of entries.filter(n=>n.endsWith('.tar.gz.json'))){
    const meta=path.join(store,name);
    if(!fs.lstatSync(meta).isFile())throw Error('Artifact metadata must be a regular file');
    const rec=JSON.parse(fs.readFileSync(meta));
    if(typeof rec.name!=='string'||path.basename(rec.name)!==rec.name||rec.name+'.json'!==name
      ||!/^[\w.-]+$/.test(rec.kind??'')||!/^[\w.-]+$/.test(rec.version??'')
      ||!/^[a-f0-9]{64}$/.test(rec.treeHash??'')||!/^[a-f0-9]{64}$/.test(rec.sha256??'')
      ||rec.name!==`${rec.kind}-${rec.version}-${rec.treeHash.slice(0,16)}.tar.gz`)throw Error('Invalid artifact metadata');
    const archive=path.join(store,rec.name);
    if(!fs.lstatSync(archive,{throwIfNoEntry:false})?.isFile()||hashFile(archive)!==rec.sha256)throw Error('Artifact checksum mismatch: '+rec.name);
    managed.add(name);managed.add(rec.name);
    (referenced.has(rec.name)?retained:remove).push(rec.name);
  }
  return {retained,remove,unmanaged:entries.filter(n=>!managed.has(n))};
}
