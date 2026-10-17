// Offline real Bubblewrap filesystem test; no model/network or production state changes. docs/22.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {workerCommand,runTranslation,executionSettings,reliabilitySettings,translationTimeoutSeconds} from '../../plugins/kurumi-papers/runner.js';
import {disablePaperRecovery} from '../../../scripts/fusion/lib/recovery-isolation.mjs';

test('Operator concurrency is validated and reaches actual sandbox stdin, never argv',async t=>{
  assert.deepEqual(executionSettings({}),{apiConcurrency:1,apiQps:1});
  for(const value of [0,5,true,'4',1.5]){
    assert.throws(()=>executionSettings({apiConcurrency:value}),/Invalid/);
    assert.throws(()=>executionSettings({apiQps:value}),/Invalid/);
  }
  const root=fs.mkdtempSync('/var/tmp/kurumi-worker-stdin-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['work','cache','venv/bin'])fs.mkdirSync(path.join(root,name),{recursive:true});
  const python=path.join(root,'venv/bin/python'),credentialsFile=path.join(root,'keys.json');
  fs.writeFileSync(credentialsFile,JSON.stringify({OPENAI_API_KEY1_014:'synthetic'}),{mode:0o600});
  const script="import json,sys,pathlib; r=json.load(sys.stdin); assert r[\"apiConcurrency\"]==4 and r[\"apiQps\"]==1; assert r[\"maxRequests\"]==300; assert r[\"batchValidationRetries\"]==3 and r[\"channelRecoveryRetries\"]==2 and r[\"executionTimeoutSeconds\"]==1800; assert r[\"outputKind\"]==\"dual\" and r[\"profile\"][\"effort\"]==\"high\"; p=pathlib.Path; p(\"/work/dual.pdf\").write_bytes(b\"pdf\"); p(\"/work/result.json\").write_text(json.dumps({\"ok\":True,\"dual\":\"/work/dual.pdf\",\"mono\":\"/must-not-read.pdf\",\"usage\":{\"maxConcurrency\":r[\"apiConcurrency\"],\"maxQps\":r[\"apiQps\"]}}))";
  fs.writeFileSync(python,"#!/bin/sh\nexec /usr/bin/python3 -c '"+script+"'\n",{mode:0o700});
  const result=await runTranslation({config:{python,credentialsFile,apiConcurrency:4,apiQps:1,batchValidationRetries:3,channelRecoveryRetries:2},
    work:path.join(root,'work'),cache:path.join(root,'cache'),profile:{},sourceLang:'en',targetLang:'zh'});
  assert.deepEqual(result.usage,{maxConcurrency:4,maxQps:1});
  assert(!Object.hasOwn(result,'mono'));assert(result.dual.endsWith('/dual.pdf'));
});

test('Retry defaults, operator overrides and schema keep independent bounded counters',()=>{
  assert.deepEqual(reliabilitySettings({}),{batchValidationRetries:1,channelRecoveryRetries:1});
  const properties=JSON.parse(fs.readFileSync(new URL('../../plugins/kurumi-papers/openclaw.plugin.json',import.meta.url))).configSchema.properties;
  for(const key of ['batchValidationRetries','channelRecoveryRetries']){
    for(const value of [0,1,2,3,4])assert.equal(reliabilitySettings({[key]:value})[key],value);
    for(const value of [-1,5,true,'1',1.5,NaN])assert.throws(()=>reliabilitySettings({[key]:value}),/retry limit/);
    assert.equal(properties[key].default,1);assert.equal(properties[key].minimum,0);assert.equal(properties[key].maximum,4);
  }
});

test('Default deadline is 30 minutes, longer configuration is rejected and schema agrees',()=>{
  assert.equal(translationTimeoutSeconds({}),1800);
  assert.equal(translationTimeoutSeconds({timeoutSeconds:1200}),1200);
  for(const timeoutSeconds of [0,-1,1801,Infinity,NaN,'1800'])assert.throws(()=>translationTimeoutSeconds({timeoutSeconds}),/deadline/);
  const schema=JSON.parse(fs.readFileSync(new URL('../../plugins/kurumi-papers/openclaw.plugin.json',import.meta.url))).configSchema.properties.timeoutSeconds;
  assert.equal(schema.default,1800);assert.equal(schema.maximum,1800);
});

test('Real sandbox propagates each output choice and rejects missing/escaped selected files',async t=>{
  const root=fs.mkdtempSync('/var/tmp/kurumi-worker-outputs-');t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['cache','venv/bin'])fs.mkdirSync(path.join(root,name),{recursive:true});
  const python=path.join(root,'venv/bin/python'),credentialsFile=path.join(root,'keys.json');
  fs.writeFileSync(credentialsFile,JSON.stringify({OPENAI_API_KEY1_014:'synthetic'}),{mode:0o600});
  for(const outputKind of ['dual','mono','both']){
    const work=path.join(root,outputKind);fs.mkdirSync(work);
    fs.writeFileSync(python,`#!/usr/bin/python3
import json,sys,pathlib
r=json.load(sys.stdin); assert r["outputKind"]==${JSON.stringify(outputKind)}
kinds=["dual","mono"] if r["outputKind"]=="both" else [r["outputKind"]]
result={"ok":True}
for kind in kinds:
 result[kind]="/work/"+kind+".pdf"; pathlib.Path(result[kind]).write_bytes(b"pdf")
if r.get("pages")=="missing": result.pop("dual",None)
if r.get("pages")=="escape": result["dual"]="/etc/hosts"
pathlib.Path("/work/result.json").write_text(json.dumps(result))
`,{mode:0o700});
    const request={config:{python,credentialsFile},work,cache:path.join(root,'cache'),profile:{},outputKind};
    const result=await runTranslation(request);
    assert.deepEqual(Object.keys(result).filter(key=>['dual','mono'].includes(key)),outputKind==='both'?['dual','mono']:[outputKind]);
    if(outputKind==='dual'){
      for(const pages of ['missing','escape'])await assert.rejects(runTranslation({...request,pages}),{code:'invalid_worker_result'});
      assert.throws(()=>runTranslation({...request,outputKind:'english'}),{code:'invalid_pdf_output'});
    }
  }
});

test('Recovery disables paid translation and erases its active credential values',t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-recovery-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const file=path.join(root,'paper-credentials.json');fs.writeFileSync(file,JSON.stringify({OPENAI_API_KEY1_014:'synthetic',DEEPSEEK_API_KEY:'synthetic-official'}));
  const config={plugins:{entries:{'kurumi-papers':{config:{credentialsFile:file,liveTranslationEnabled:true}}}}};
  disablePaperRecovery(config,root);assert.equal(config.plugins.entries['kurumi-papers'].config.liveTranslationEnabled,false);
  assert.deepEqual(JSON.parse(fs.readFileSync(file)),{});
  const other=path.join(root,'other');fs.mkdirSync(other);
  assert.throws(()=>disablePaperRecovery(config,other),/inside/);
  const secret=path.join(root,'outside.json');fs.writeFileSync(secret,'private');
  config.plugins.entries['kurumi-papers'].config.credentialsFile=path.join(other,'..','outside.json');
  assert.throws(()=>disablePaperRecovery(config,other),/inside/);
  fs.symlinkSync(root,path.join(other,'escape'));
  config.plugins.entries['kurumi-papers'].config.credentialsFile=path.join(other,'escape/outside.json');
  assert.throws(()=>disablePaperRecovery(config,other),/inside/);
  assert.equal(fs.readFileSync(secret,'utf8'),'private');
});

test('The actual worker sandbox hides host credentials and only writes job/cache directories', t => {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-worker-boundary-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['work','cache'])fs.mkdirSync(path.join(root,name));
  fs.writeFileSync(path.join(root,'host-secret'),'must-not-be-visible');
  const config={python:'/home/afrangry/.openclaw-fusion/venvs/paper-translation/bin/python'};
  const {command,args}=workerCommand({config,work:path.join(root,'work'),cache:path.join(root,'cache')});
  const code=`import pathlib,os; p=pathlib.Path; assert not p(${JSON.stringify(root+'/host-secret')}).exists(); assert not p('/home/afrangry/.openclaw-fusion/runtime-env.json').exists(); assert not p('/home/afrangry/.openclaw-fusion/paper-credentials.json').exists(); assert 'OPENAI_API_KEY' not in os.environ; p('/work/check').write_text('ok'); p('/cache/check').write_text('ok'); assert p('/app/engine.py').exists()`;
  const result=spawnSync(command,[...args.slice(0,-1),'-c',code],{encoding:'utf8',env:{PATH:'/usr/bin:/bin',OPENAI_API_KEY:'synthetic-host-only'},timeout:10000});
  assert.equal(result.status,0,result.stderr);
  assert.equal(fs.readFileSync(path.join(root,'work/check'),'utf8'),'ok');
});

test('A real sandboxed worker stops writing when the parent wall deadline kills it', async t => {
  // The sandbox overlays /tmp; the fake interpreter must be mounted outside that overlay.
  const root=fs.mkdtempSync('/var/tmp/kurumi-worker-timeout-');
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  for(const name of ['work','cache','venv/bin'])fs.mkdirSync(path.join(root,name),{recursive:true});
  const python=path.join(root,'venv/bin/python'),credentialsFile=path.join(root,'keys.json');
  fs.writeFileSync(credentialsFile,JSON.stringify({OPENAI_API_KEY1_014:'synthetic'}),{mode:0o600});
  fs.writeFileSync(python,"#!/bin/sh\nexec /usr/bin/python3 -c 'import time; f=open(\"/work/pulse\",\"a\");\nwhile True: f.write(\".\"); f.flush(); time.sleep(0.01)'\n",{mode:0o700});
  await assert.rejects(runTranslation({config:{python,credentialsFile,timeoutSeconds:0.5},work:path.join(root,'work'),cache:path.join(root,'cache'),profile:{},pages:'1',sourceLang:'en',targetLang:'zh'}),/translation_timed_out/);
  const pulse=path.join(root,'work/pulse'),size=fs.statSync(pulse).size;
  assert(size>0);await new Promise(r=>setTimeout(r,120));assert.equal(fs.statSync(pulse).size,size);
});
