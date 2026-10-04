import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {runSandbox} from '../sandbox.js';
test('project code cannot read host-private files, write fixtures or reach host loopback',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'project-isolation-')),root=path.join(dir,'repo');fs.mkdirSync(root);const secret=path.join(dir,'private-marker'),fixture=path.join(dir,'fixture');fs.writeFileSync(secret,'outside-marker');fs.writeFileSync(fixture,'immutable');
 const server=http.createServer((req,res)=>res.end('host'));await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{const code=`const fs=require('fs'),net=require('net'),assert=require('assert');assert.equal(fs.existsSync(${JSON.stringify(secret)}),false);assert.equal(fs.existsSync('/home/afrangry/.openclaw-fusion/runtime-env.json'),false);assert.throws(()=>fs.writeFileSync('/checks/fixture','bad'));assert.equal(process.env.OPENCLAW_GATEWAY_TOKEN,undefined);fs.writeFileSync('/workspace/owned','allowed');const s=net.connect(${server.address().port},'127.0.0.1');s.on('connect',()=>{console.error('NETWORK_ESCAPE');process.exit(2)});s.on('error',()=>console.log('isolation verified'));setTimeout(()=>{s.destroy();process.exit(3)},2000).unref();`;
  const r=await runSandbox({root,fixtures:[{source:fixture,target:'/checks/fixture'}]},['/usr/bin/node','-e',code]);assert.equal(r.code,0,r.output);assert.match(r.output,/isolation verified/);assert.equal(fs.readFileSync(fixture,'utf8'),'immutable');assert.equal(fs.readFileSync(path.join(root,'owned'),'utf8'),'allowed');
 }finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
test('abort terminates the isolated process tree',async()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'project-abort-')),controller=new AbortController();
 try{const pending=runSandbox({root},['/usr/bin/node','-e','setInterval(()=>{},1000)'],{signal:controller.signal});setTimeout(()=>controller.abort(),150);const r=await pending;assert.equal(r.aborted,true);assert.notEqual(r.code,0);}finally{fs.rmSync(root,{recursive:true,force:true});}
});
