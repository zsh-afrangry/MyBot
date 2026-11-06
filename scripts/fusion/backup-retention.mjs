// Record an isolated restore receipt and preview/apply retention for verified v3 Fusion points.
// Historical and unrelated project backups are never selected by this command.
import fs from 'node:fs';
import path from 'node:path';
import {BACKUP_ROOT,hashFile} from './lib/backup-layout.mjs';
import {retentionPlan} from './lib/backup-retention.mjs';
const argv=process.argv.slice(2),i=argv.indexOf('--record');
if(i>=0){
  const result=JSON.parse(fs.readFileSync(argv[i+1]));
  const dir=fs.realpathSync(result.backup);
  if(path.dirname(dir)!==BACKUP_ROOT||!result.ok||result.level!=='isolated-gateway'
    ||result.manifestHash!==hashFile(dir+'/MANIFEST.sha256')||result.expectedHash!==hashFile(dir+'/EXPECTED.json')) throw Error('A successful matching isolated restore receipt is required');
  fs.writeFileSync(dir+'/VERIFIED.json',JSON.stringify({...result,verifiedAt:new Date().toISOString()},null,2)+'\n',{mode:0o600});
}
const plan=retentionPlan(BACKUP_ROOT);console.log(JSON.stringify(plan,null,2));
if(argv.includes('--apply'))for(const name of plan.remove)fs.rmSync(path.join(BACKUP_ROOT,name),{recursive:true});
