// Offline real Documents/paper-tool/QQ upload boundaries; synthetic PDFs and temporary roots only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Documents,atomicJson,displayPdfName} from '../../packages/documents/index.js';
import {createPaperPlugin} from '../../plugins/kurumi-papers/index.js';
import {sendDocument} from '../../plugins/kurumi-qq/src/files.js';
import {withAccess,memberRow,context,OWNER,MEMBER} from '../access-control/fixtures.mjs';
import {pdf} from './fixtures.mjs';
const inspect = async () => ({pages:1});
async function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-paper-rename-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg=withAccess({channels:{'kurumi-qq':{enabled:true,stateDir:path.join(root,'channel'),httpUrl:'http://127.0.0.1:1',wsUrl:'ws://127.0.0.1:2',dailySendLimit:20}},plugins:{entries:{'kurumi-papers':{config:{root:path.join(root,'documents')}}}}});
  cfg.channels['kurumi-qq'].accessControl.subjects.push(memberRow());
  const docs=new Documents(path.join(root,'documents'));
  const input=await docs.add(pdf('input'),{filename:'原稿.pdf',source:{type:'fixture'}},{inspect});
  const artifact=await docs.add(pdf('translation'),{filename:'原稿双语.pdf',kind:'artifact',jobId:'job-fixture',source:{documentId:input.id}},{inspect});
  return {root,cfg,docs,input,artifact};
}
test('Display rename preserves bytes, content ID and jobs; catalog and future QQ sends use new name',async t=>{
  const {cfg,docs,input,artifact}=await fixture(t),before=docs.get(input.id),uploads=[];
  const send=key=>sendDocument({cfg,to:'user:'+OWNER,documentId:input.id,key,apiCall:async(_a,action,args)=>{uploads.push({action,args});return null;}});
  await send('before');
  const result=docs.rename(input.id,{filename:'新 名称.PDF',expectedVersion:0,key:'rename-1'});
  assert.equal(result.changed,true);assert.equal(result.document.nameVersion,1);
  assert(!('_nameReceipt' in result.document));assert(!('path' in result.document));
  assert.equal(docs.get(input.id).path,before.path);assert.deepEqual(docs.get(input.id).content,before.content);
  assert.equal(result.document.sha256,input.sha256);assert.deepEqual(result.document.source,input.source);
  assert.equal(docs.describe(artifact.id).filename,artifact.filename);assert.equal(docs.describe(artifact.id).jobId,'job-fixture');
  assert.equal(docs.find('新 名称')[0].id,input.id);assert.equal(docs.find('原稿').some(d=>d.id===input.id),false);
  await send('before');assert.equal(uploads.length,1);
  await send('after');assert.deepEqual(uploads.map(u=>u.args.name),['原稿.pdf','新 名称.PDF']);
  assert.equal(uploads[0].args.file,uploads[1].args.file);
  assert.equal((await docs.add(pdf('input'),{filename:'stale-import.pdf'},{inspect})).filename,'新 名称.PDF');
  docs.rename(artifact.id,{filename:'单独译稿.pdf',expectedVersion:0,key:'artifact'});
  assert.equal(docs.describe(input.id).filename,'新 名称.PDF');
});
test('Name CAS, idempotent retries, same-name no-op, duplicate display names and legacy metadata',async t=>{
  const {docs,input,artifact}=await fixture(t),change={filename:'同名.pdf',expectedVersion:0,key:'first'};
  const file=docs.recordFile(input.id),legacy=JSON.parse(fs.readFileSync(file));delete legacy.nameVersion;atomicJson(file,legacy);
  assert.equal(docs.describe(input.id).nameVersion,0);
  docs.rename(input.id,change);assert.equal(docs.rename(input.id,change).duplicate,true);
  assert.throws(()=>docs.rename(input.id,{...change,filename:'另一个.pdf'}),{code:'document_name_request_conflict'});
  assert.throws(()=>docs.rename(input.id,{...change,key:'stale'}),{code:'document_name_version_conflict'});
  assert.equal(docs.rename(input.id,{...change,expectedVersion:1,key:'same-name'}).changed,false);
  assert.equal(docs.describe(input.id).nameVersion,1);
  docs.rename(artifact.id,{...change,key:'other-id'});assert.equal(docs.find('同名').length,2);
  docs.rename(input.id,{filename:'之后.pdf',expectedVersion:1,key:'next'});
  assert.throws(()=>docs.rename(input.id,change),{code:'document_name_version_conflict'});
});
test('Unsafe names, orphan locks, invalid IDs and tampered PDF bytes never change metadata',async t=>{
  const {docs,input}=await fixture(t),file=docs.recordFile(input.id),before=fs.readFileSync(file);
  for(const filename of ['', '.pdf','../a.pdf','a/b.pdf','a\\b.pdf','a\n.pdf',' a.pdf','a.pdf ', 'a.exe','x'.repeat(157)+'.pdf','a\u202eexe.pdf']) {
    assert.throws(()=>docs.rename(input.id,{filename,expectedVersion:0,key:'invalid'}),{code:'invalid_pdf_display_name'});
  }
  assert.equal(displayPdfName('e\u0301.pdf'),'é.pdf');
  fs.writeFileSync(file+'.rename.lock','orphan');
  assert.throws(()=>docs.rename(input.id,{filename:'a.pdf',expectedVersion:0,key:'lock'}),{code:'document_name_busy'});
  assert.equal(fs.readFileSync(file+'.rename.lock','utf8'),'orphan');fs.unlinkSync(file+'.rename.lock');
  assert.throws(()=>docs.rename('../../outside',{filename:'a.pdf',expectedVersion:0,key:'id'}));
  fs.writeFileSync(docs.get(input.id).path,pdf('tampered'));
  assert.throws(()=>docs.rename(input.id,{filename:'a.pdf',expectedVersion:0,key:'tamper'}),/integrity/);
  assert.deepEqual(fs.readFileSync(file),before);assert(!fs.existsSync(file+'.rename.lock'));
});
test('Paper tool checks new permission, real requester ownership and call-key conflicts',async t=>{
  const {cfg,docs,input}=await fixture(t),tools=[];
  createPaperPlugin({serviceFactory:()=>({start(){},stop(){}}),deliveryFactory:()=>({})}).register({config:cfg,pluginConfig:cfg.plugins.entries['kurumi-papers'].config,registerService(){},registerTool:tool=>tools.push(tool)});
  const registration=tools.find(t=>t.create({}).name==='kurumi_document');
  const owner=cfg.channels['kurumi-qq'].accessControl.subjects[0],ctx=context(owner),tool=registration.create(ctx);
  const args={action:'rename',documentId:input.id,filename:'工具改名.pdf',expectedVersion:0};
  delete owner.permissions['papers.rename'];
  await assert.rejects(tool.execute('same-call',args),{code:'capability_not_allowed'});
  owner.permissions['papers.rename']=true;
  const result=JSON.parse((await tool.execute('same-call',args)).content[0].text);assert(result.ok);assert.equal(result.document.nameVersion,1);
  assert.equal(JSON.parse((await tool.execute('same-call',args)).content[0].text).duplicate,true);
  assert.equal(JSON.parse((await tool.execute('same-call',{...args,filename:'换参数.pdf'})).content[0].text).code,'document_name_request_conflict');
  await assert.rejects(registration.create(context(memberRow(MEMBER))).execute('member',args),{code:'capability_not_allowed'});
  assert.equal(docs.describe(input.id).filename,'工具改名.pdf');
  const events=fs.readFileSync(path.join(docs.root,'events.jsonl'),'utf8');assert(!events.includes('工具改名'));assert(!events.includes('_nameReceipt'));
});
