// Fault injection around the physical send, admitted OneBot events and the read-only query.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {readChannelDelivery} from '../../../packages/log-query/index.js';
import {Ledger,sendPayload} from '../../../packages/qq-delivery/index.js';
import {privateTextFeedback} from '../../../packages/qq-delivery/private-text-feedback.js';
import {memberRow,withAccess} from '../../../tests/access-control/fixtures.mjs';
import {handleInbound} from '../src/inbound.js';

const owner='700101',bot='700102',member='700103',key='fixture-reply';
const text=value=>({type:'text',data:{text:value}});
const reply=id=>({type:'reply',data:{id}});
async function fixture(t) {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'qq-feedback-')),stateDir=path.join(dir,'channel');
  const tokenFile=path.join(dir,'token');fs.writeFileSync(tokenFile,'fixture',{mode:0o600});
  const f={sends:0,mode:'ok',quote:{message_type:'private',target_id:owner,sender:{user_id:bot},message:[text('test reply')]}};
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const part of req)body+=part;
    const args=JSON.parse(body);
    if(req.url==='/get_msg')return res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:args.message_id,...f.quote}}));
    f.sends++;
    if(f.sends===2){
      if(f.mode==='lost')return req.socket.destroy();
      if(f.mode==='invalid')return res.end('{}');
      if(f.mode==='rejected')return res.end('{"status":"failed","retcode":100}');
    }
    res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:-f.sends}}));
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  const cfg=withAccess({channels:{'kurumi-qq':{enabled:true,ownerId:owner,stateDir,mediaRoot:dir,httpTokenFile:tokenFile,
    wsUrl:'ws://127.0.0.1:1',httpUrl:'http://127.0.0.1:'+server.address().port,segmentDelayMs:0}}});
  const channel=cfg.channels['kurumi-qq'];
  const workspace=path.join(dir,'users',member,'workspace');
  fs.mkdirSync(workspace,{recursive:true});fs.writeFileSync(path.join(workspace,'AGENTS.md'),'kurumi-isolated-member-v1');
  cfg.agents={entries:{main:{workspace:path.join(dir,'workspace')},['qq-user-'+member]:{workspace}}};
  channel.accessControl.subjects.push(memberRow(member));
  const runtime={channel:{routing:{resolveAgentRoute:({peer})=>{
    const agentId=peer.id===owner?'main':'qq-user-'+peer.id;
    return {agentId,sessionKey:'agent:'+agentId+':kurumi-qq:direct:'+peer.id};
  }},session:{resolveStorePath:()=>dir,recordInboundSession:async()=>{}},reply:{finalizeInboundContext:x=>x,
    dispatchReplyWithBufferedBlockDispatcher:async({dispatcherOptions})=>{
      if(f.answer)await dispatcherOptions.deliver({text:f.answer},{kind:'final'});
    }}}};
  const ledger=new Ledger(stateDir);
  const observe=sourceMessage=>privateTextFeedback(ledger.db,{selfId:bot,peer:owner,sourceMessage});
  let nextId=90;
  const receive=(segments,patch={},ingressKind='onebot')=>handleInbound({cfg,runtime,selfId:bot,ingressKind,
    event:{message_id:++nextId,user_id:Number(owner),self_id:Number(bot),post_type:'message',message_type:'private',message:segments,...patch}});
  const rows=()=>readChannelDelivery(path.join(stateDir,'channel.sqlite'),0,Date.now()+1000).map(row=>row.data);
  const send=()=>sendPayload({cfg,to:'user:'+owner,text:'一段。\n\n二段。\n\n三段。',key,onTextPlan:observe('40').plan});
  t.after(async()=>{ledger.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));fs.rmSync(dir,{recursive:true,force:true});});
  return Object.assign(f,{observe,receive,rows,send,ledger,channel});
}

for(const [mode,expected] of [['lost','unknown'],['invalid','unknown'],['rejected','rejected']]){
  test('Partial reply and replay after '+mode,async t=>{
    const f=await fixture(t);f.mode=mode;
    await assert.rejects(f.send());
    assert.deepEqual(f.rows().map(r=>r.platformStatus),['accepted',expected,'not_attempted']);
    assert(f.rows().every(r=>r.parts===3&&r.recipientStatus==='unverified'));
    await assert.rejects(f.send(),{code:'qq_receipt_unresolved'});
    assert.equal(f.sends,2);
    await f.receive([reply('-1'),text('收到了。')]);
    assert.deepEqual(f.rows().map(r=>r.recipientStatus),['acknowledged','unverified','unverified']);
  });
}

test('Only the intended peer quoting one verified outbound message can acknowledge it',async t=>{
  const f=await fixture(t);await f.send();
  for(const segments of [[text('收到')],[text('[CQ:reply,id=-1]收到')],[reply('-1'),text('我还没收到')],
    [reply('-1'),text('收到？')],[reply('-1'),text('收到后我再说')],[reply('-1'),reply('-2'),text('收到')],
    [reply('-1'),text('收到'),{type:'face',data:{id:1}}],[reply('-99'),text('收到')]]) await f.receive(segments);
  const ack=[reply('-1'),text('我已经收到了！')];
  for(const patch of [{user_id:member},{sender:{user_id:member}},{message_type:'group'},{self_id:'700104'},{post_type:'message_sent'}])await f.receive(ack,patch);
  await f.receive(ack,{},'synthetic');
  for(const changed of [{target_id:member},{message_id:-2},{target_id:bot,sender:{user_id:owner}}]){
    const original=f.quote;f.quote={...original,...changed};await f.receive(ack);f.quote=original;
  }
  assert(f.rows().every(r=>r.recipientStatus==='unverified'));
  await f.receive(ack,{message_id:400});
  assert.deepEqual(await f.receive(ack,{message_id:400}),{duplicate:true});
  await f.receive(ack);
  assert.deepEqual(f.rows().map(r=>r.receiptId),['400',undefined,undefined]);
  assert(f.rows().every(r=>r.clientDelivery==='unknown'&&r.readStatus==='unknown'));
  assert.equal(f.sends,3);
});

test('Early acknowledgement waits for a unique platform receipt; ambiguous ids stay unverified',async t=>{
  const f=await fixture(t),ledger=f.ledger;
  f.observe('40').plan(key,2);
  ledger.reserve(key+':0');await f.receive([reply('123'),text('收到')]);
  assert.equal(f.rows()[0].recipientStatus,'unverified');
  ledger.sent(key+':0','123');assert.equal(f.rows()[0].recipientStatus,'acknowledged');
  ledger.reserve(key+':1');ledger.sent(key+':1','123');
  assert(f.rows().every(r=>r.recipientStatus==='unverified'));
});

test('Disabled, synthetic and legacy replies retain their native receipts; observer fault leaves delivery intact',async t=>{
  const f=await fixture(t);f.answer='行动结束。';
  f.channel.privateTextFeedback=false;
  await f.receive([text('普通消息')]);assert.equal(f.rows()[0].action,undefined);
  f.channel.privateTextFeedback=true;
  await f.receive([text('模拟消息')],{},'synthetic');assert(f.rows().every(row=>row.action===undefined));
  const legacy=f.ledger.db.prepare('SELECT id FROM outbound ORDER BY at LIMIT 1').get();
  f.observe('unknown').plan(legacy.id.slice(0,-2),1);
  assert(f.rows().every(row=>row.action===undefined));
  f.ledger.db.exec("CREATE TRIGGER fixture_fault BEFORE INSERT ON qq_reply_parts BEGIN SELECT RAISE(ABORT,'feedback fixture'); END");
  await f.receive([text('继续发送')]);assert.equal(f.sends,3);
  assert(f.rows().every(row=>row.status==='sent'&&row.action===undefined));
});

test('Member text reply is bound to its recipient across a gateway restart',async t=>{
  const f=await fixture(t);
  f.answer='成员回复';
  await f.receive([text('私聊')],{user_id:Number(member)});
  f.answer=null;
  const segments=[reply('-1'),text('收到')];
  await f.receive(segments);
  assert.equal(f.rows()[0].recipientStatus,'unverified');
  f.quote={...f.quote,target_id:member};
  await f.receive(segments,{user_id:Number(member)});
  const reopened=new Ledger(f.channel.stateDir);
  try {
    const proof=reopened.db.prepare('SELECT bot,peer,message_id FROM qq_reply_ack').all();
    assert.deepEqual(proof.map(r=>[r.bot,r.peer]),[[bot,member]]);
    const [row]=f.rows();
    assert.deepEqual([row.recipientStatus,row.receiptId,row.part],['acknowledged',proof[0].message_id,1]);
    assert(row.ledgerId.startsWith('subject:'+member+':'));
    assert.equal(f.sends,1);
  } finally {reopened.close();}
});
