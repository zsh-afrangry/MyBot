// Offline managed-attachment/confirmation integration, local TLS SMTP only. See docs/22 and docs/20.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {Documents} from '../../packages/documents/index.js';
import {createMailApplication} from '../../plugins/kurumi-mail/application.js';
import {MockSmtpServer,TEST_USER,TEST_PASS} from '../../plugins/kurumi-mail/test/helpers/mock-smtp.js';
import {defaultConnector} from '../../plugins/kurumi-mail/smtp.js';
import {buildMessage} from '../../plugins/kurumi-mail/mime.js';
import {ownerScope,inboundEvent,RECIPIENT} from '../../plugins/kurumi-mail/test/helpers/owner-context.js';
import {pdf} from './fixtures.mjs';
const CA=fs.readFileSync(new URL('../../plugins/kurumi-mail/test/fixtures/cert.pem',import.meta.url));
const connector=opts=>defaultConnector({...opts,tlsOptions:{ca:CA,servername:'localhost'}});
function parseMime(raw){
 const result=spawnSync('python3',[fileURLToPath(new URL('./mime-parse.py',import.meta.url))],{input:raw,encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);return JSON.parse(result.stdout);
}
async function setup(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-attachment-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const docs=new Documents(path.join(root,'documents')),doc=await docs.add(pdf(),{filename:'论文双语.pdf'},{inspect:async()=>({pages:1})});
 const app=createMailApplication({resolveAttachment:id=>docs.get(id)}),storeOptions={stateDirectory:path.join(root,'mail'),allowedRecipients:[RECIPIENT]};
 let store=app.openStore(storeOptions);t.after(()=>store.close());
 return {root,docs,doc,app,store,storeOptions,scope:ownerScope()};
}
test('Draft freezes exact PDF bytes, survives reopen; previews contain only metadata',async t=>{
 const {app,store,doc,storeOptions,scope}=await setup(t);
 const draft=app.directives.createDraft(store,{to:RECIPIENT,subject:'PDF',text:'附件',attachments:[{documentId:doc.id}]},scope,[RECIPIENT]);
 assert(draft.ok);assert.equal(draft.attachments[0].sha256,doc.sha256);
 assert(!JSON.stringify(store.listDrafts()).includes('contentBase64'));
 store.close();const reopened=app.openStore(storeOptions);t.after(()=>reopened.close());
 assert.deepEqual(reopened.readAttachments(draft.draftId)[0].content,pdf());
});
test('The store Uint8Array contract preserves the selected bytes and approval hash',async t=>{
 const {store,scope}=await setup(t),buffer=new Uint8Array([255,37,80,68,70,0]);
 const input=buffer.subarray(1,5);
 const draft=store.createDraft({to:[RECIPIENT],subject:'typed array',text:'bytes',attachments:[{filename:'bytes.pdf',content:input}]},scope);
 assert.deepEqual(store.readAttachments(draft.draftId)[0].content,Buffer.from([37,80,68,70]));
 assert(store.recordInboundConfirmation(inboundEvent({content:draft.instruction}),draft.draftId));
 assert(store.consumeApproval({draftId:draft.draftId,scope}).ok);
});
test('Attachment delivery needs approval, sends captured bytes once even if source later changes',async t=>{
 const {app,store,docs,doc,scope}=await setup(t),server=new MockSmtpServer();const address=await server.start();t.after(()=>server.stop());
 const subject='[论文翻译验收] 2609.32536v1.pdf（仅页码 1）';
 const draft=app.directives.createDraft(store,{to:RECIPIENT,subject,text:'见附件',attachments:[{documentId:doc.id}]},scope,[RECIPIENT]);
 const context={scope,allowedRecipients:[RECIPIENT],config:{...address,user:TEST_USER,authCode:TEST_PASS,configured:true},connector};
 assert.equal((await app.directives.sendDraft(store,{draftId:draft.draftId},context)).code,'approval_required');
 assert.equal(server.receivedCount,0);
 assert(store.recordInboundConfirmation(inboundEvent({content:draft.confirmationInstruction}),draft.draftId));
 fs.writeFileSync(path.join(docs.root,'files',doc.id+'.pdf'),pdf('changed after preview'));
 assert((await app.directives.sendDraft(store,{draftId:draft.draftId},context)).ok);
 assert.equal(server.receivedCount,1);
 const decoded=parseMime(server.messages[0].data);
 assert.equal(decoded.subject,subject);assert.equal(decoded.type,'multipart/mixed');assert.equal(decoded.body,'见附件');
 assert.deepEqual(decoded.defects,[]);assert.equal(decoded.attachments.length,1);
 assert.equal(decoded.attachments[0].disposition,'attachment');assert.equal(decoded.attachments[0].type,'application/pdf');
 assert.equal(decoded.attachments[0].sha256,doc.sha256);assert.equal(decoded.attachments[0].bytes,doc.bytes);
 assert(!((await app.directives.sendDraft(store,{draftId:draft.draftId},context)).ok));assert.equal(server.receivedCount,1);
});
test('MIME round trip preserves Unicode boundaries and binary files as attachments',()=>{
 const bytes=new Uint8Array([99,0,255,128,10,13,42,99]).subarray(1,7);
 for(const subject of ['[论文翻译验收] 2609.32536v1.pdf（仅页码 1）', 'a'+'论文🐳'.repeat(40)]){
  const decoded=parseMime(buildMessage({from:{address:'bot@example.test'},to:'owner@example.test',subject,text:'中文正文\n第二行',messageId:'unicode-boundary@test',attachments:[{filename:'报告.pdf',contentType:'application/pdf',content:bytes},{filename:'notes.txt',contentType:'text/plain',content:'文本附件'}]}).raw);
  assert.equal(decoded.subject,subject);assert.equal(decoded.body,'中文正文\r\n第二行');
  assert.deepEqual(decoded.defects,[]);assert.equal(decoded.attachments.length,2);
  assert.equal(decoded.attachments[0].sha256,createHash('sha256').update(bytes).digest('hex'));
  assert.equal(decoded.attachments[0].filename,'报告.pdf');
  assert.equal(decoded.attachments[1].sha256,createHash('sha256').update('文本附件').digest('hex'));
  assert(decoded.attachments.every(a=>a.disposition==='attachment'));
 }
});
test('Unknown refs/raw paths/oversized attachments/recipient bypass cannot create a draft',async t=>{
 const {app,store,doc,scope}=await setup(t);
 const base={to:RECIPIENT,subject:'PDF',text:'body'};
 for(const attachments of [[{documentId:'/etc/passwd'}],[{documentId:doc.id,path:'/etc/hosts'}],[{filename:'x.pdf',content:'raw'}]])assert(!app.directives.createDraft(store,{...base,attachments},scope,[RECIPIENT]).ok);
 const missing=app.directives.createDraft(store,{...base,attachments:[{documentId:'doc_'+'0'.repeat(32)}]},scope,[RECIPIENT]);
 assert.equal(missing.ok,false);assert(!JSON.stringify(missing).includes(store.file));assert(!JSON.stringify(missing).includes('/tmp/'));
 assert(!app.directives.createDraft(store,{...base,to:'stranger@example.test',attachments:[{documentId:doc.id}]},scope,[RECIPIENT]).ok);
 assert.throws(()=>store.createDraft({...base,to:[RECIPIENT],attachments:[{filename:'large.pdf',content:Buffer.alloc(11*1024*1024)}]},scope),/size limit/);
 const eightMiB=Buffer.alloc(8*1024*1024);
 assert.throws(()=>store.createDraft({...base,to:[RECIPIENT],attachments:[1,2,3].map(n=>({filename:n+'.pdf',content:eightMiB}))},scope),/total 20 MiB/);
 assert.equal(store.listDrafts().length,0);
});
test('Tampering with a persisted attachment after confirmation prevents network delivery',async t=>{
 const {app,store,doc,scope}=await setup(t);
 const draft=app.directives.createDraft(store,{to:RECIPIENT,subject:'PDF',text:'body',attachments:[{documentId:doc.id}]},scope,[RECIPIENT]);
 assert(store.recordInboundConfirmation(inboundEvent({content:draft.confirmationInstruction}),draft.draftId));
 const db=new DatabaseSync(store.file);
 const entries=JSON.parse(db.prepare('SELECT attachments_json FROM mail_drafts WHERE draft_id=?').get(draft.draftId).attachments_json);
 entries[0].contentBase64=pdf('tampered').toString('base64');
 db.prepare('UPDATE mail_drafts SET attachments_json=? WHERE draft_id=?').run(JSON.stringify(entries),draft.draftId);db.close();
 let connections=0;
 const result=await app.directives.sendDraft(store,{draftId:draft.draftId},{scope,allowedRecipients:[RECIPIENT],config:{configured:true},connector:()=>{connections++;throw Error('must not connect');}});
 assert.equal(result.code,'draft_attachment_integrity_failed');assert.equal(connections,0);
});
