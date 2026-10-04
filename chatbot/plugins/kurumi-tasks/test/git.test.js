import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';import plugin from '../index.js';
test('scoped Git commit excludes unrelated staged and untracked files',async()=>{
 const base=fs.mkdtempSync(path.join(os.tmpdir(),'project-git-')),root=path.join(base,'repo'),channel=path.join(base,'channel');fs.mkdirSync(root);fs.mkdirSync(channel);
 const git=(...args)=>{const r=spawnSync('/usr/bin/git',args,{cwd:root,encoding:'utf8'});assert.equal(r.status,0,r.stderr);return r.stdout.trim();};
 try{
  git('init');fs.writeFileSync(root+'/base','initial');git('add','base');git('-c','user.name=Test','-c','user.email=test@localhost','commit','-m','baseline');
  fs.writeFileSync(root+'/selected','change');fs.writeFileSync(root+'/unrelated-staged','preserve');fs.writeFileSync(root+'/untracked-note','do not stage');git('add','unrelated-staged');
  fs.writeFileSync(base+'/projects.json',JSON.stringify({version:1,projects:[{id:'test',agentId:'project-test',root,checks:[{name:'noop',argv:['/bin/true']}]}]}));
  const cfg={channels:{'kurumi-qq':{stateDir:channel}}};let factory;plugin.register({config:cfg,registerTool:(f,o)=>{if(o.name==='kurumi_project_git')factory=f;}});const tool=factory.create({agentId:'project-test',workspaceDir:root,assertInvocationCurrent:()=>{}});
  for(const paths of [undefined,['../escape'],['.git/config'],['/etc/hostname']])await assert.rejects(tool.execute('bad',{action:'commit',message:'bad',paths}));
  const result=JSON.parse((await tool.execute('ok',{action:'commit',message:'selected only',paths:['selected']})).content[0].text);assert.equal(result.code,0,result.output);
  assert.equal(git('diff-tree','--no-commit-id','--name-only','-r','HEAD'),'selected');assert.match(git('status','--porcelain'),/A  unrelated-staged/);assert.match(git('status','--porcelain'),/\?\? untracked-note/);
 }finally{fs.rmSync(base,{recursive:true,force:true});}
});
