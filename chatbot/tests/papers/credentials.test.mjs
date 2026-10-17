// Offline provider/credential setup boundaries. Synthetic keys in temporary directories only.
// No network, model, QQ/mail or production writes. Development owner: docs/22_论文PDF翻译与文件投递.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadKeys} from '../../plugins/kurumi-papers/runner.js';
import {resolveProfile,credentialIdsForProfile} from '../../plugins/kurumi-papers/profiles.js';
const gpt=credentialIdsForProfile(), ds='DEEPSEEK_API_KEY';
const script=fileURLToPath(new URL('../../scripts/import-paper-credentials.mjs',import.meta.url));
function setup(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-credentials-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const write=(file,data,mode=0o600)=>fs.writeFileSync(file,typeof data==='string'?data:JSON.stringify(data),{mode});
const run=(source,destination,...args)=>spawnSync(process.execPath,[script,'--source',source,'--destination',destination,...args],{encoding:'utf8'});
test('Provider-specific defaults are inferred only from compatible registered selectors',()=>{
  const expected=resolveProfile({provider:'deepseek'});
  assert.equal(expected.model,'deepseek-flash');assert.equal(expected.effort,'low');assert.equal(expected.baseUrl,'https://api.deepseek.com');
  assert.deepEqual(resolveProfile({channel:'official'}),expected);
  assert.deepEqual(resolveProfile({model:'deepseek-flash'}),expected);
  assert.equal(resolveProfile({model:'deepseek-v4-pro',effort:'max'}).provider,'deepseek');
  assert.equal(resolveProfile({provider:' DEEPSEEK '}).provider,'deepseek');
  for(const args of [{provider:'openai',model:'deepseek-flash'},{provider:'deepseek',channel:'naiccc'},
    {channel:'official',model:'gpt-6.1-sol'},{provider:'deepseek',effort:'xhigh'},{provider:'deepseek',effort:'medium'},
    {effort:'none'},{model:'__proto__'},{provider:''}]) assert.throws(()=>resolveProfile(args),{code:'unsupported_translation_profile'});
  const altered=credentialIdsForProfile();altered.reverse();assert.equal(credentialIdsForProfile()[0],gpt[0]);
});
test('Credential selection excludes all other providers and rejects absent/private-invalid files',t=>{
  const root=setup(t),file=path.join(root,'keys.json');
  write(file,{...Object.fromEntries(gpt.map((id,i)=>[id,'synthetic-'+i])),[ds]:' synthetic-ds ',OTHER:'must-not-forward'});
  assert.deepEqual(Object.keys(loadKeys(file)),gpt);
  assert.deepEqual(loadKeys(file,{provider:'deepseek'}),{[ds]:'synthetic-ds'});
  write(file,{[gpt[0]]:'gpt-only'});assert.throws(()=>loadKeys(file,{provider:'deepseek'}),/No translation credentials/);
  write(file,{[ds]:'ds-only'});assert.throws(()=>loadKeys(file),/No translation credentials/);
  fs.chmodSync(file,0o644);assert.throws(()=>loadKeys(file,{provider:'deepseek'}),/owner-only/);
  fs.chmodSync(file,0o600);fs.symlinkSync(file,path.join(root,'link'));assert.throws(()=>loadKeys(path.join(root,'link')),/owner-only/);
  write(file,'malformed-synthetic-private-value');
  assert.throws(()=>loadKeys(file),error=>error.message==='Invalid translation credential file'&&!error.message.includes('synthetic-private-value'));
});
test('Operator import merges only selected keys atomically and preserves the other pool on rotation',t=>{
  const root=setup(t),gptSource=path.join(root,'gpt.txt'),dsSource=path.join(root,'runtime-env.json'),dest=path.join(root,'keys.json');
  write(gptSource,'#中转-GPT\n'+gpt.map((id,i)=>id+'=synthetic-gpt-'+i).join('\n')+'\n#Other\nUNRELATED=unrelated-secret\n');
  write(dsSource,{[ds]:'synthetic-official',MAIL_PASS:'unrelated-secret'});
  let result=run(gptSource,dest);assert.equal(result.status,0,result.stderr);assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(dest))),gpt);
  const before=fs.readFileSync(dest);result=run(dsSource,dest,'--provider','deepseek');assert.notEqual(result.status,0);assert.deepEqual(fs.readFileSync(dest),before);
  result=run(dsSource,dest,'--provider','deepseek','--replace');assert.equal(result.status,0,result.stderr);
  let stored=JSON.parse(fs.readFileSync(dest));assert.equal(stored[ds],'synthetic-official');assert.equal(stored[gpt[0]],'synthetic-gpt-0');
  write(gptSource,'#中转-GPT\n'+gpt.map((id,i)=>id+'=rotated-'+i).join('\n'));
  result=run(gptSource,dest,'--replace');assert.equal(result.status,0,result.stderr);
  stored=JSON.parse(fs.readFileSync(dest));assert.equal(stored[ds],'synthetic-official');assert.equal(stored[gpt[0]],'rotated-0');
  assert.equal(fs.statSync(dest).mode&0o777,0o600);
  assert(!/synthetic-|rotated-|unrelated-secret/.test(result.stdout+result.stderr));
  assert.deepEqual(fs.readdirSync(root).sort(),['gpt.txt','keys.json','runtime-env.json']);
});
test('Invalid import leaves existing bytes intact and refuses symlinks, public files or unknown fields',t=>{
  const root=setup(t),source=path.join(root,'env.json'),dest=path.join(root,'keys.json'),target=path.join(root,'target.json');
  write(dest,{[gpt[0]]:'synthetic-existing'});const before=fs.readFileSync(dest);
  for(const raw of [{OTHER:'no-ds-key'},'invalid-private-synthetic-text']){
    write(source,raw);const result=run(source,dest,'--provider','deepseek','--replace');assert.notEqual(result.status,0);assert.deepEqual(fs.readFileSync(dest),before);assert(!result.stderr.includes('invalid-private-synthetic-text'));
  }
  write(source,{[ds]:'synthetic-official'});fs.chmodSync(dest,0o644);assert.notEqual(run(source,dest,'--provider','deepseek','--replace').status,0);
  fs.chmodSync(dest,0o600);write(dest,{UNKNOWN:'preserve-or-refuse'});const unknown=fs.readFileSync(dest);
  assert.notEqual(run(source,dest,'--provider','deepseek','--replace').status,0);assert.deepEqual(fs.readFileSync(dest),unknown);
  write(target,{[gpt[0]]:'do-not-overwrite'});fs.unlinkSync(dest);fs.symlinkSync(target,dest);
  assert.notEqual(run(source,dest,'--provider','deepseek','--replace').status,0);assert.equal(JSON.parse(fs.readFileSync(target))[gpt[0]],'do-not-overwrite');
  fs.unlinkSync(dest);fs.symlinkSync(path.join(root,'missing'),dest);
  assert.notEqual(run(source,dest,'--provider','deepseek','--replace').status,0);assert(!fs.existsSync(path.join(root,'missing')));
});
