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
