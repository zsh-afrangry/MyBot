// Offline temporary-directory retention checks; no production or network access.
import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import{pruneDiagnostics,clearGatewayCaptures}from'../lib/runtime-retention.mjs';
test('retention removes expired and excess diagnostics while preserving active logs, credentials and symlinks',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fusion-retention-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const now=Date.now();fs.mkdirSync(root+'/logs',{recursive:true});
 const write=(name,size,age=0)=>{fs.writeFileSync(root+'/'+name,Buffer.alloc(size));fs.utimesSync(root+'/'+name,new Date(now-age),new Date(now-age));};
 write('runtime.log',10);write('runtime.1.log',10,1000);write('runtime.2.log',10,2000);write('logs/expired.json',1,8*86400000);write('http-token',12);fs.symlinkSync(root+'/http-token',root+'/logs/link');
 const result=pruneDiagnostics(root,{now,maxBytes:20});assert.equal(result.retainedBytes,20);assert.deepEqual(result.removed.sort(),['logs/expired.json','runtime.2.log']);assert.ok(fs.existsSync(root+'/runtime.log'));assert.equal(fs.statSync(root+'/http-token').size,12);assert.ok(fs.lstatSync(root+'/logs/link').isSymbolicLink());
});
test('capture cleanup refuses symlinks and leaves adjacent state intact',t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'fusion-captures-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(root+'/tmp/plugin-captures',{recursive:true});fs.writeFileSync(root+'/tmp/plugin-captures/runner.js','fixture');fs.writeFileSync(root+'/tmp/keep','state');clearGatewayCaptures(root);assert.ok(!fs.existsSync(root+'/tmp/plugin-captures'));assert.ok(fs.existsSync(root+'/tmp/keep'));fs.symlinkSync(root+'/tmp',root+'/tmp/plugin-captures');assert.throws(()=>clearGatewayCaptures(root),/symlink/);
});
