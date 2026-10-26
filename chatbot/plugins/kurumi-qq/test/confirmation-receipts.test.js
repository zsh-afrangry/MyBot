// Full physical-payload receipts gate confirmation; loopback HTTP and temporary state only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {createNaturalConfirmationBackend,registerConfirmationBackend,registerConfirmationProposal,scopeFromInboundEvent,prepareConfirmationPreview} from '@kurumi/confirmation-core';
import {withAccess} from '../../../tests/access-control/fixtures.mjs';
import {handleInbound} from '../src/inbound.js';

for(const mode of ['complete','partial-failure','capture-without-receipt'])test(`natural preview delivery proof: ${mode}`,async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-confirmation-receipts-')),owner='100001',bot='100002';
 fs.writeFileSync(path.join(dir,'token'),'synthetic',{mode:0o600});
 let count=0;const server=http.createServer((req,res)=>{const fail=mode==='partial-failure'&&++count===2;if(mode!=='partial-failure')count++;
  res.end(JSON.stringify({status:fail?'failed':'ok',retcode:fail?100:0,data:{message_id:500+count}}));});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const cfg=withAccess({channels:{'kurumi-qq':{enabled:true,ownerId:owner,httpUrl:`http://127.0.0.1:${server.address().port}`,wsUrl:'ws://127.0.0.1:1',httpTokenFile:path.join(dir,'token'),wsTokenFile:path.join(dir,'token'),stateDir:dir,mediaRoot:dir,chunkLimit:40,naturalSegments:false,sendLimit:20}}},owner);
 const event={channel:'kurumi-qq',accountId:'default',senderId:owner,conversationId:`user:${owner}`,sessionKey:`agent:main:kurumi-qq:direct:${owner}`,content:'生成预览',messageId:'79',timestamp:Date.now(),isGroup:false};
 const db=new DatabaseSync(':memory:'),backend=createNaturalConfirmationBackend(db,{subjectId:'owner',domains:['notes']});
 const off=registerConfirmationBackend({id:randomUUID(),open:()=>({natural:backend,listInboundConfirmationCandidates:()=>[],recordInboundConfirmation:()=>false,close(){}})});
 t.after(async()=>{off();db.close();server.closeAllConnections();await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});});
 const selected={proposalId:randomUUID(),payloadHash:'a'.repeat(64),domain:'notes'};
 const now=Math.floor(Date.now()/1000);registerConfirmationProposal(db,{...selected,subjectId:'owner',actionKind:'save',scope:scopeFromInboundEvent(event),createdAtUtc:now,expiresAtUtc:now+300});
 const text='冻结预览：'+'甲'.repeat(100);assert(prepareConfirmationPreview(event,selected,text));
 const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:event.sessionKey})},session:{resolveStorePath:()=>path.join(dir,'sessions'),recordInboundSession:async()=>{}},reply:{finalizeInboundContext:x=>x,dispatchReplyWithBufferedBlockDispatcher:async({dispatcherOptions})=>{await dispatcherOptions.deliver({text},{kind:'final'});}}}};
 const input={cfg,runtime,selfId:bot,event:{post_type:'message',message_type:'private',self_id:Number(bot),user_id:Number(owner),message_id:79,message:[{type:'text',data:{text:event.content}}]},...(mode==='capture-without-receipt'?{deliverOverride:async()=>{}}:{})};
 if(mode==='partial-failure')await assert.rejects(handleInbound(input),/rejected/);else assert((await handleInbound(input)).ok);
 const proof=db.prepare('SELECT presented_at_utc,presentation_message_id FROM confirmation_previews').get();
 if(mode==='complete'){assert(count>1);assert(proof.presented_at_utc);assert.equal(proof.presentation_message_id,String(500+count));}else assert.equal(proof.presented_at_utc,null);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM approval_grants').get().n,0);
});
