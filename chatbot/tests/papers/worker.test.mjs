// Offline real Bubblewrap filesystem test; no model/network or production state changes. docs/22.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {workerCommand,runTranslation} from '../../plugins/kurumi-papers/runner.js';
import {disablePaperRecovery} from '../../../scripts/fusion/lib/recovery-isolation.mjs';

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
