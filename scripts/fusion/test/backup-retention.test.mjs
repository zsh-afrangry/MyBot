// Offline temporary points: preserve R1 until enough newer verified points exist; reject stale proof.
import test from 'node:test';import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';
import {hashFile} from '../lib/backup-layout.mjs';import {retentionPlan} from '../lib/backup-retention.mjs';
test('retention excludes incomplete, failed, legacy and changed points',()=>{
 const root=fs.mkdtempSync('/tmp/kurumi-retention-');
 try{
  function point(name,stamp,extra={}){const dir=path.join(root,name);fs.mkdirSync(dir);fs.writeFileSync(dir+'/EXPECTED.json',JSON.stringify({formatVersion:3,stamp}));fs.writeFileSync(dir+'/MANIFEST.sha256','fixture');fs.writeFileSync(dir+'/VERIFIED.json',JSON.stringify({ok:true,level:'isolated-gateway',manifestHash:hashFile(dir+'/MANIFEST.sha256'),expectedHash:hashFile(dir+'/EXPECTED.json'),...extra}));return dir;}
  point('R1','1');point('R2','2');point('failed','9',{ok:false});const interrupted=point('interrupted','8');fs.writeFileSync(interrupted+'/INCOMPLETE.json','{}');const changed=point('changed','7');fs.appendFileSync(changed+'/EXPECTED.json',' ');fs.mkdirSync(root+'/legacy');
  assert.deepEqual(retentionPlan(root),{retained:['R2','R1'],remove:[]});
  point('R3','3');assert.deepEqual(retentionPlan(root),{retained:['R3','R2'],remove:['R1']});assert.throws(()=>retentionPlan(root,{keep:1}));
 }finally{fs.rmSync(root,{recursive:true});}
});
