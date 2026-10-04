// Register an independent fusion checkout. Existing checkouts and fixture state are never silently replaced.
import fs from 'node:fs';
import {spawnSync} from 'node:child_process';
const source='/home/afrangry/kurumi-fusion',state='/home/afrangry/.openclaw-fusion',root=state+'/projects/fusion',checks=state+'/project-checks';
function git(args,cwd){const r=spawnSync('/usr/bin/git',args,{cwd,encoding:'utf8'});if(r.status!==0)throw Error(r.stderr);}
fs.mkdirSync(state+'/projects',{recursive:true,mode:0o700});fs.mkdirSync(checks,{recursive:true,mode:0o700});
if(!fs.existsSync(root)){
 git(['clone','--no-hardlinks',source,root],source);git(['remote','remove','origin'],root);git(['switch','-c','kurumi/project-base'],root);
 const instructions='# 独立融合开发副本\n\n此处是授权的项目开发副本，只在本仓库内工作。原助手与QQ bridge原件不能访问或修改。可以维护源码、添加测试、使用受限Git工具创建分支和本地提交；不推送。\n\n任务先检查Git状态，再复现问题和修复，调用kurumi_project_check得到真实结果，审阅diff后提交。检查在隔离命名空间运行，固定外部验收只读；不得删除/改弱现有测试以伪造通过。无通用shell/外网，禁止创建子会话。简洁报告修改、实际检查、提交号和限制。\n';
  fs.writeFileSync(root+'/AGENTS.md',instructions);fs.writeFileSync(root+'/chatbot/AGENTS.md',instructions+'\n原部署助手人格与工具规则留在主融合源码及原件；此副本是代码开发目录。\n');
 fs.appendFileSync(root+'/.gitignore','\n# Host context stays outside project source.\n/IDENTITY.md\n/SOUL.md\n/USER.md\n/MEMORY.md\n');
 git(['add','AGENTS.md','chatbot/AGENTS.md','.gitignore'],root);git(['-c','user.name=Kurumi Setup','-c','user.email=kurumi@localhost','commit','-m','Prepare isolated development workspace instructions'],root);
}
fs.mkdirSync(root+'/node_modules',{recursive:true});for(const [name,target] of Object.entries({openclaw:'/home/afrangry/.npm-global/lib/node_modules/openclaw',ws:'/home/afrangry/.npm-global/lib/node_modules/openclaw/node_modules/ws'}))if(!fs.existsSync(root+'/node_modules/'+name))fs.symlinkSync(target,root+'/node_modules/'+name);
const fixture=checks+'/fusion-memory-revision.mjs';if(!fs.existsSync(fixture))fs.writeFileSync(fixture,`// Operator-owned regression, mounted read-only in the project's test namespace.\nimport test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {readMemory,writeMemory} from '/workspace/chatbot/plugins/kurumi-memory/store.js';\ntest('memory rejects corrupt negative revisions while valid state remains readable',()=>{const dir=fs.mkdtempSync(path.join(os.tmpdir(),'revision-'));try{writeMemory(dir,{entries:[]},0);assert.equal(readMemory(dir).revision,1);fs.writeFileSync(path.join(dir,'MEMORY.md'),'<!-- KURUMI_MEMORY_JSON -->\\n'+JSON.stringify({version:1,revision:-1,entries:[]}));assert.throws(()=>readMemory(dir),/memory format/i);}finally{fs.rmSync(dir,{recursive:true,force:true});}});\n`,{mode:0o600});
const registryFile=state+'/projects.json';let registry=fs.existsSync(registryFile)?JSON.parse(fs.readFileSync(registryFile)):{version:1,projects:[]};
if(!registry.projects.some(p=>p.id==='fusion'))registry.projects.push({id:'fusion',name:'融合项目独立副本',agentId:'project-fusion',root,readOnlyDependencies:['/home/afrangry/.npm-global/lib/node_modules/openclaw'],fixtures:[{source:fixture,target:'/checks/fusion-memory-revision.mjs'}],checks:[{name:'memory-regression',argv:['/usr/bin/node','--test','/checks/fusion-memory-revision.mjs','chatbot/plugins/kurumi-memory/test/memory.test.js'],timeoutMs:60000}]});
fs.writeFileSync(registryFile,JSON.stringify(registry,null,2),{mode:0o600});
const cfg=JSON.parse(fs.readFileSync(state+'/openclaw.json'));
cfg.agents.entries['project-fusion']={workspace:root,tools:{profile:'full',allow:['ls','read','write','edit','apply_patch','kurumi_project_check','kurumi_project_git'],fs:{workspaceOnly:true},deny:['exec','process','message','sessions_spawn','web_search','web_fetch']}};
fs.writeFileSync(state+'/openclaw.json',JSON.stringify(cfg,null,2),{mode:0o600});console.log({registered:'fusion',root,network:'isolated',fixtureReadOnly:true});
