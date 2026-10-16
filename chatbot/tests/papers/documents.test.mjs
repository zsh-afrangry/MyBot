// Offline document and QQ file boundaries. Temporary directories and mocked HTTP only. docs/22.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {Documents} from '../../packages/documents/index.js';
import {parseInbound} from '../../plugins/kurumi-qq/src/inbound.js';
import {qqFileUrl, stagePdf, sendDocument} from '../../plugins/kurumi-qq/src/files.js';
import {pdf} from './fixtures.mjs';
const inspect = async () => ({pages: 1});
function setup(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-pdf-test-')); t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const cfg = {channels:{'kurumi-qq':{enabled:true,ownerId:'365999865',httpUrl:'http://127.0.0.1:1',wsUrl:'ws://127.0.0.1:2',stateDir:path.join(root,'channel'),dailySendLimit:20}},plugins:{entries:{'kurumi-papers':{config:{root:path.join(root,'documents')}}}}};
  return {root, cfg, docs: new Documents(path.join(root,'documents'))};
}
test('Real PDF inspection, portable catalog and byte integrity survive reopen', async t => {
  const {root, docs} = setup(t), doc = await docs.add(pdf(),{filename:'paper.pdf'});
  assert.equal(doc.pages,1); assert.equal(new Documents(docs.root).describe(doc.id).sha256,doc.sha256);
  assert(!('path' in doc)); assert(!('content' in doc));
  fs.writeFileSync(path.join(root,'documents/files',doc.id+'.pdf'),pdf('tampered'));
  assert.throws(()=>docs.get(doc.id),/integrity/);
});
test('PDF ID dedup, path/symlink/size/encryption rejection', async t => {
  const {docs,root} = setup(t), a = await docs.add(pdf(),{filename:'../danger.pdf'},{inspect});
  assert.equal((await docs.add(pdf(),{}, {inspect})).id,a.id);
  assert(!a.filename.includes('/'));
  assert.throws(()=>docs.get('../../etc/passwd'));
  await assert.rejects(docs.add(Buffer.from('not pdf'),{}, {inspect}));
  await assert.rejects(docs.add(pdf('secret'),{}, {inspect:async()=>({pages:1,encrypted:true})}));
  await assert.rejects(docs.add(pdf('huge'),{}, {inspect:async()=>({pages:501})}));
  assert.equal(fs.readdirSync(path.join(docs.root,'files')).length,1);
  assert.deepEqual(fs.readdirSync(path.join(docs.root,'work')),[]);
  fs.symlinkSync('/etc/hosts',path.join(root,'documents/records','doc_'+'a'.repeat(32)+'.json'));
  assert.throws(()=>docs.get('doc_'+'a'.repeat(32)));
});
test('File-only messages and offline-file notices require actual owner and bot metadata', t => {
  const {cfg} = setup(t), a = cfg.channels['kurumi-qq'];
  const msg={post_type:'message',message_type:'private',self_id:1794511189,user_id:365999865,message_id:12,message:[{type:'file',data:{file_id:'x',name:'x.pdf'}}]};
  assert.equal(parseInbound(msg,a,'1794511189').files.length,1);
  for (const patch of [{user_id:1},{self_id:1},{message_type:'group'}]) assert.equal(parseInbound({...msg,...patch},a,'1794511189'),null);
  const notice={post_type:'notice',notice_type:'offline_file',self_id:1794511189,user_id:365999865,file:{id:'x',name:'x.pdf'}};
  assert.equal(parseInbound(notice,a,'1794511189').messageId,'file:x');
  assert.equal(parseInbound({...notice,user_id:2},a,'1794511189'),null);
});
test('QQ URL is read from the authenticated API, not the uploaded text/URL', async t => {
  const {cfg} = setup(t), calls=[];
  const doc = await stagePdf({data:{id:'qq-id',name:'paper.pdf',url:'https://evil.test'}},cfg,{inspect,
    apiCall:async(a,action,args)=>{calls.push({action,args});return {url:'https://multimedia.nt.qq.com/download?token=synthetic'};},
    fetcher:async(url,options)=>{assert(url.startsWith('https://multimedia.nt.qq.com/'));assert.equal(options.redirect,'manual');return new Response(pdf());}});
  assert.equal(doc.source.fileId,'qq-id'); assert.equal(calls[0].args.user_id,365999865);
  assert.equal(qqFileUrl('http://180.109.156.103/asn.com/file?token=synthetic'),'https://180.109.156.103/asn.com/file?token=synthetic');
  for (const url of ['file:///etc/hosts','http://127.0.0.1/a','http://127.0.0.1/asn.com/file','http://10.0.0.1/asn.com/file','http://169.254.169.254/asn.com/file','http://100.64.0.1/asn.com/file','http://192.168.1.1/asn.com/file','https://180.109.156.103/other','https://evil.test/a','https://multimedia.nt.qq.com.evil/a','https://multimedia.nt.qq.com:8080/a']) assert.throws(()=>qqFileUrl(url));
  await assert.rejects(stagePdf({data:{id:'x',name:'run.exe'}},cfg,{inspect}));
});
test('Private file upload is durable, owner-only; null success has no invented message ID', async t => {
  const {cfg,docs} = setup(t), doc=await docs.add(pdf(),{filename:'paper.pdf'},{inspect}); let count=0;
  const apiCall=async(a,action,args)=>{count++; assert.equal(action,'upload_private_file'); assert.equal(args.user_id,365999865); assert(args.file.endsWith('.pdf')); return null;};
  const input={cfg,to:'user:365999865',documentId:doc.id,key:'file-one',apiCall};
  assert.equal((await sendDocument(input)).status,'platform_accepted');
  assert.equal((await sendDocument(input)).duplicate,true); assert.equal(count,1);
  await assert.rejects(sendDocument({...input,to:'user:123456'}));
  await assert.rejects(sendDocument({...input,key:'unknown',apiCall:async()=>{count++;throw Error('lost receipt');}}));
  await assert.rejects(sendDocument({...input,key:'unknown'}),/manual reconciliation/); assert.equal(count,2);
});
