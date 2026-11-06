// Offline temporary points: preserve R1 until enough newer verified points exist; reject stale proof.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {hashFile,ensureArtifact} from '../lib/backup-layout.mjs';import {retentionPlan,artifactRetentionPlan} from '../lib/backup-retention.mjs';
test('retention excludes incomplete, failed, legacy and changed points',()=>{
 const root=fs.mkdtempSync('/tmp/kurumi-retention-');
 try{
  function point(name,stamp,extra={}){const dir=path.join(root,name);fs.mkdirSync(dir);fs.writeFileSync(dir+'/EXPECTED.json',JSON.stringify({formatVersion:3,stamp}));fs.writeFileSync(dir+'/MANIFEST.sha256','fixture');fs.writeFileSync(dir+'/VERIFIED.json',JSON.stringify({ok:true,level:'isolated-gateway',manifestHash:hashFile(dir+'/MANIFEST.sha256'),expectedHash:hashFile(dir+'/EXPECTED.json'),...extra}));return dir;}
  point('R1','1');point('R2','2');point('failed','9',{ok:false});point('upgrade-only','6',{level:'upgrade-rehearsal'});const interrupted=point('interrupted','8');fs.writeFileSync(interrupted+'/INCOMPLETE.json','{}');const changed=point('changed','7');fs.appendFileSync(changed+'/EXPECTED.json',' ');fs.mkdirSync(root+'/legacy');
  assert.deepEqual(retentionPlan(root),{retained:['R2','R1'],remove:[]});
  point('R3','3');assert.deepEqual(retentionPlan(root),{retained:['R3','R2'],remove:['R1']});assert.throws(()=>retentionPlan(root,{keep:1}));
 }finally{fs.rmSync(root,{recursive:true});}
});
test('artifact retention preserves surviving and incomplete references, and only plans checked unreferenced archives',t=>{
 const root=fs.mkdtempSync('/tmp/kurumi-artifact-retention-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const source=root+'/source';fs.mkdirSync(source);
 const artifact=value=>{fs.writeFileSync(source+'/entry',value);return ensureArtifact('sdk','1.0',source,root+'/artifacts');};
 const old=artifact('old'),current=artifact('current'),unfinished=artifact('unfinished'),orphan=artifact('orphan');
 for(const [name,artifacts] of [['R1',[old]],['R2',[current]],['incomplete',[unfinished]]]){
  fs.mkdirSync(root+'/'+name);fs.writeFileSync(root+'/'+name+'/EXPECTED.json',JSON.stringify({formatVersion:3,artifacts}));
 }
 fs.writeFileSync(root+'/incomplete/INCOMPLETE.json','{}');
 fs.writeFileSync(root+'/artifacts/manual-note','unregistered');
 const plan=artifactRetentionPlan(root,{removePoints:['R1']});
 assert.deepEqual(plan.retained.sort(),[current.name,unfinished.name].sort());
 assert.deepEqual(plan.remove.sort(),[old.name,orphan.name].sort());
 assert.deepEqual(plan.unmanaged,['manual-note']);
 assert(fs.existsSync(root+'/artifacts/'+old.name),'planning must be read only');
 fs.appendFileSync(root+'/artifacts/'+orphan.name,'corrupted');
 assert.throws(()=>artifactRetentionPlan(root,{removePoints:['R1']}),/checksum mismatch/);
});
test('missing or unsafe references prevent artifact cleanup planning',t=>{
 const root=fs.mkdtempSync('/tmp/kurumi-artifact-missing-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(root+'/point');const expected=root+'/point/EXPECTED.json';
 fs.writeFileSync(expected,JSON.stringify({formatVersion:3,artifacts:[{name:'missing.tar.gz'}]}));
 assert.throws(()=>artifactRetentionPlan(root),/Referenced artifact missing/);
 fs.writeFileSync(expected,JSON.stringify({formatVersion:3,artifacts:[{name:'../outside.tar.gz'}]}));
 assert.throws(()=>artifactRetentionPlan(root),/Invalid artifact reference/);
});
