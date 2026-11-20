import assert from 'node:assert/strict';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {finalizeInboundContext} from 'openclaw/plugin-sdk/reply-dispatch-runtime';
import {WebSocketServer} from 'ws';
import {agentFor,sessionFor} from '../../../packages/access-control/index.js';
import {account,Ledger} from '../../../packages/qq-delivery/index.js';
import {memberRow,ownerPolicy} from '../../../tests/access-control/fixtures.mjs';
import {plugin} from '../index.js';
import {createOneBotInbound,handleInbound} from '../src/inbound.js';

const OWNER='700001',MEMBER='700002',BOT='700003';
const textSegment=text=>({type:'text',data:{text}});
const event=(id,text,user=OWNER,segments=[])=>({post_type:'message',message_type:'private',self_id:Number(BOT),
 user_id:Number(user),message_id:id,time:1795000000+id,message:[textSegment(text),...segments]});
const idle=()=>new Promise(resolve=>setImmediate(resolve));

function clock(t){
 let now=0;
 t.mock.method(performance,'now',()=>now);
 t.mock.timers.enable({apis:['setTimeout']});
 return async ms=>{now+=ms;t.mock.timers.tick(ms);await idle();};
}

function fixture(t,{settings={},dispatch}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-qq-debounce-'));
 const stateDir=path.join(dir,'channel'),workspace=path.join(dir,'users',MEMBER,'workspace');
 const errorLog=[],seen=[],activity=[],deliveries=[],records=[];
 const controller=new AbortController();
 fs.mkdirSync(workspace,{recursive:true});
 fs.writeFileSync(path.join(workspace,'AGENTS.md'),'kurumi-isolated-member-v1');
 const accessControl=ownerPolicy(OWNER);
 accessControl.subjects.push(memberRow(MEMBER));
 const channel={enabled:true,ownerId:OWNER,stateDir,mediaRoot:path.join(dir,'media'),accessControl,
  httpUrl:'http://127.0.0.1:1',wsUrl:'ws://127.0.0.1:1',inboundDebounceMs:3000,inboundDebounceMaxWaitMs:10000,...settings};
 const cfg={channels:{'kurumi-qq':channel},agents:{entries:{main:{workspace:path.join(dir,'workspace')},[`qq-user-${MEMBER}`]:{workspace}}}};
 const runtime={channel:{
  routing:{resolveAgentRoute:({peer})=>{
   const subject=accessControl.subjects.find(row=>row.qq===peer.id);
   return {agentId:agentFor(subject),sessionKey:sessionFor(subject)};
  }},
  session:{resolveStorePath:()=>'/test',recordInboundSession:async({ctx})=>records.push(ctx.MessageSid)},
  reply:{finalizeInboundContext,dispatchReplyWithBufferedBlockDispatcher:async params=>{
   seen.push(params.ctx);
   await params.replyOptions.turnAdoptionLifecycle?.onAdopted();
   await dispatch?.(params);
  }},
 }};
 const options={cfg,runtime,selfId:BOT,signal:controller.signal,log:{error:msg=>errorLog.push(msg)},
  onAcceptedInbound:meta=>activity.push(meta),deliverOverride:async payload=>deliveries.push(payload),
  stageMedia:async()=>({path:'/test/image.png',contentType:'image/png'}),stageFile:async()=>({id:'fixture-doc',pages:1})};
 let inbound;
 t.after(async()=>{try{await inbound?.close();}finally{fs.rmSync(dir,{recursive:true,force:true});}});
 const ledgerRows=()=>{
  const ledger=new Ledger(stateDir);
  try{return ledger.db.prepare('SELECT id,status,origin FROM inbound ORDER BY id').all().map(row=>({...row}));}
  finally{ledger.close();}
 };
 return {dir,cfg,channel,controller,options,seen,records,activity,deliveries,ledgerRows,errorLog,
  open:()=>inbound=createOneBotInbound(options)};
}

test('Three arrivals extend the quiet window; a replay does not. One turn retains all source IDs',async t=>{
 const advance=clock(t),f=fixture(t,{dispatch:({dispatcherOptions})=>dispatcherOptions.deliver({text:'明白了。'},{kind:'final'})}),inbound=f.open();
 const first=event(11,'今天的计划。'),second=event(12,'先核对时间。'),last=event(13,'再做安排。');
 await inbound.enqueue(first);
 await advance(1800);
 await inbound.enqueue(second);
 await advance(2100);
 await inbound.enqueue(last);
 await advance(2500);
 assert.deepEqual(await inbound.enqueue(first),{duplicate:true});
 await advance(499);
 assert.equal(f.seen.length,0);
 assert.deepEqual(f.activity.map(meta=>meta.messageId),['11','12','13']);
 assert(f.activity.every(meta=>meta.origin==='onebot'&&!('text' in meta)&&!('content' in meta)));
 await advance(1);
 await inbound.close();

 assert.equal(f.seen.length,1);
 assert.deepEqual(f.records,['13']);
 const [ctx]=f.seen;
 assert.equal(ctx.BodyForAgent,'今天的计划。\n先核对时间。\n再做安排。');
 assert.equal(ctx.RawBody,'再做安排。');
 assert.equal(ctx.BodyForCommands,'再做安排。');
 assert.equal(ctx.Timestamp,last.time*1000);
 assert.deepEqual(ctx.MessageSids,['11','12','13']);
 assert.equal(ctx.MessageSidFirst,'11');
 assert.equal(ctx.MessageSidLast,'13');
 assert.equal(ctx.MessageSid,'13');
 assert.equal(f.deliveries.length,1);
 assert.equal(f.deliveries[0].key,`in:${BOT}:${OWNER}:13:0`);
 assert.deepEqual(f.ledgerRows(),[11,12,13].map(id=>({id:`${BOT}:${OWNER}:${id}`,status:'completed',origin:'onebot'})));
});

test('A continuing stream flushes at the first arrival plus max wait',async t=>{
 const advance=clock(t),f=fixture(t),inbound=f.open();
 for(let i=0;i<4;i++){
  if(i)await advance(2500);
  await inbound.enqueue(event(20+i,`片段 ${i}`));
 }
 await advance(2499);
 assert.equal(f.seen.length,0);
 await advance(1);
 assert.equal(f.seen.length,1);
 assert.deepEqual(f.seen[0].MessageSids,['20','21','22','23']);
 await inbound.enqueue(event(24,'下一轮'));
 await advance(3000);
 assert.equal(f.seen.length,2);
 assert.equal(f.seen[1].BodyForAgent,'下一轮');
});

test('Owner and member accumulate independently; untrusted traffic cannot join or reset a batch',async t=>{
 const advance=clock(t),f=fixture(t),inbound=f.open();
 await inbound.enqueue(event(31,'本人第一条'));
 await advance(1000);
 await inbound.enqueue(event(32,'成员第一条',MEMBER));
 await inbound.enqueue(event(33,'本人第二条'));
 await advance(1000);
 await inbound.enqueue(event(34,'成员第二条',MEMBER));
 await advance(1500);
 assert.deepEqual(await inbound.enqueue({...event(35,'伪造群消息'),message_type:'group'}),{ignored:true});
 assert.deepEqual(await inbound.enqueue(event(36,'陌生人','700004')),{ignored:true});
 await advance(500);
 assert.deepEqual(f.seen.map(c=>[c.SenderId,c.OriginatingTo,c.BodyForAgent]),[[OWNER,`user:${OWNER}`,'本人第一条\n本人第二条']]);
 await advance(1000);
 assert.deepEqual(f.seen.map(c=>[c.SenderId,c.SessionKey,c.BodyForAgent]),[
  [OWNER,`agent:main:kurumi-qq:direct:${OWNER}`,'本人第一条\n本人第二条'],
  [MEMBER,`agent:qq-user-${MEMBER}:kurumi-qq:direct:${MEMBER}`,'成员第一条\n成员第二条'],
 ]);
 assert.deepEqual(f.activity.map(meta=>meta.messageId),['31','33']);
});

test('Commands, coded confirmations, media and quotes each flush preceding text and bypass the timer',async t=>{
 clock(t);
 const f=fixture(t),inbound=f.open();
 const boundaries=[
  event(41,'/new'),event(43,'暂停。'),event(45,'确认 aaaaaaaaaaaa'),
  event(47,'请看图片',OWNER,[{type:'image',data:{}}]),
  event(49,'请看引用',OWNER,[{type:'reply',data:{id:'invalid'}}]),
  event(51,'请看附件',OWNER,[{type:'file',data:{name:'fixture.pdf'}}]),
 ];
 for(const boundary of boundaries){
  const id=boundary.message_id;
  await inbound.enqueue(event(id-1,'一条普通消息'));
  await inbound.enqueue(boundary);
  assert.deepEqual(f.seen.slice(-2).map(ctx=>ctx.MessageSid),[String(id-1),String(id)]);
 }
 assert.equal(f.seen.length,2*boundaries.length);
 assert(f.seen.every(ctx=>!ctx.MessageSids));
 assert.equal(f.seen[7].SourceModality,'image');
 assert.match(f.seen[9].BodyForAgent,/引用正文未加载/u);
 assert.match(f.seen[11].BodyForAgent,/fixture-doc/u);
 assert.deepEqual(f.errorLog,[]);
});

test('The debounce lane releases at host admission, even while the previous reply is running',async t=>{
 clock(t);
 const held=Promise.withResolvers();
 const f=fixture(t,{dispatch:({ctx})=>ctx.MessageSid==='60'?held.promise:undefined}),inbound=f.open();
 try{
  await inbound.enqueue(event(60,'有个问题'));
  const stop=inbound.enqueue(event(61,'/stop'));
  await idle();
  assert.deepEqual(f.seen.map(ctx=>ctx.MessageSid),['60','61']);
  assert.deepEqual(f.ledgerRows().map(row=>row.status),['admitted','completed']);
  await stop;
 }finally{held.resolve();}
 await inbound.close();
 assert.deepEqual(f.ledgerRows().map(row=>row.status),['completed','completed']);
});

test('A failed dispatch settles every admitted fragment and is not retried',async t=>{
 const advance=clock(t),f=fixture(t,{dispatch:()=>{throw Error('fixture failure');}}),inbound=f.open();
 await inbound.enqueue(event(62,'第一条'));
 await inbound.enqueue(event(63,'第二条'));
 await advance(3000);
 await inbound.close();
 assert.deepEqual(f.ledgerRows().map(row=>row.status),['failed','failed']);
 assert.equal(f.errorLog.length,1);
 const reopened=f.open();
 assert.deepEqual(await reopened.enqueue(event(62,'重复事件')),{duplicate:true});
 assert.equal(f.seen.length,1);
});

test('Disabling debounce or using synthetic ingress leaves messages independent',async t=>{
 const advance=clock(t),f=fixture(t,{settings:{inboundDebounceMs:0}}),inbound=f.open();
 await inbound.enqueue(event(71,'立即处理'));
 await inbound.enqueue(event(72,'分别处理'));
 f.channel.inboundDebounceMs=3000;
 await handleInbound({...f.options,event:event(73,'合成测试'),ingressKind:'synthetic'});
 await advance(10000);
 assert.deepEqual(f.seen.map(ctx=>ctx.MessageSid),['71','72','73']);
 assert(f.seen.every(ctx=>!ctx.MessageSids));
 assert.deepEqual(f.ledgerRows().map(row=>row.origin),['onebot','onebot','synthetic']);
});

test('WebSocket ingress batches messages and account shutdown cancels the pending timer',{timeout:5000},async t=>{
 const advance=clock(t),f=fixture(t);
 const login=http.createServer((request,response)=>{
  assert.equal(request.url,'/get_login_info');
  response.end(JSON.stringify({status:'ok',retcode:0,data:{user_id:Number(BOT)}}));
 });
 const wss=new WebSocketServer({host:'127.0.0.1',port:0});
 login.listen(0,'127.0.0.1');
 let task;
 const shutdown=()=>{
  f.controller.abort();
  for(const client of wss.clients)client.terminate();
  return Promise.allSettled([task,new Promise(resolve=>wss.close(resolve)),new Promise(resolve=>login.close(resolve))]);
 };
 t.signal.addEventListener('abort',shutdown,{once:true});
 try{
  await Promise.all([once(login,'listening'),once(wss,'listening')]);
  const tokenFile=path.join(f.dir,'fixture-token');
  fs.writeFileSync(tokenFile,'fixture-only',{mode:0o600});
  Object.assign(f.channel,{httpTokenFile:tokenFile,wsTokenFile:tokenFile,
   httpUrl:`http://127.0.0.1:${login.address().port}`,wsUrl:`ws://127.0.0.1:${wss.address().port}`});
  const connected=once(wss,'connection'),batchReceived=Promise.withResolvers(),tailReceived=Promise.withResolvers();
  task=plugin.gateway.startAccount({cfg:f.cfg,account:account(f.cfg),abortSignal:f.controller.signal,setStatus(){},getStatus:()=>({})},
   {...f.options,onAcceptedInbound:({messageId})=>{
    if(messageId==='82')batchReceived.resolve();
    if(messageId==='83')tailReceived.resolve();
   }});
  const [socket]=await Promise.race([connected,task.then(()=>{throw Error('gateway stopped before connecting');})]);
  socket.send(JSON.stringify(event(81,'第一条')));
  socket.send(JSON.stringify(event(82,'第二条')));
  await batchReceived.promise;
  assert.equal(f.seen.length,0);
  await advance(3000);
  assert.deepEqual(f.seen.map(ctx=>ctx.BodyForAgent),['第一条\n第二条']);

  socket.send(JSON.stringify(event(83,'关停前的待收消息')));
  await tailReceived.promise;
  f.controller.abort();
  await task;
  await advance(10000);
  assert.equal(f.seen.length,1);
  assert.deepEqual(f.ledgerRows().map(row=>row.status),['completed','completed','failed']);
 }finally{
  t.signal.removeEventListener('abort',shutdown);
  await shutdown();
 }
});
