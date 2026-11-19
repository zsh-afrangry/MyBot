import {withAccess} from '../../../tests/access-control/fixtures.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {account, ownerTarget, Ledger, sendPayload, sendImage, localImage, splitForQQ} from '../../../packages/qq-delivery/index.js';
import {parseInbound,handleInbound} from '../src/inbound.js';
function fixture(){const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-channel-'));fs.writeFileSync(path.join(dir,'token'),'test',{mode:0o600});const cfg=withAccess({channels:{'kurumi-qq':{enabled:true,ownerId:'365999865',httpUrl:'http://127.0.0.1:1',wsUrl:'ws://127.0.0.1:2',httpTokenFile:path.join(dir,'token'),wsTokenFile:path.join(dir,'token'),stateDir:dir,mediaRoot:dir,sendLimit:10}}});return {dir,cfg,a:account(cfg)};}
const valid={post_type:'message',message_type:'private',self_id:123456789,user_id:365999865,message_id:789,message:[{type:'text',data:{text:'你好'}}]};
test('binary image delivery shares the private OneBot transport, durable deduplication and quota', async t => {
 const {cfg,dir}=fixture(), calls=[];
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const server=http.createServer(async(req,res)=>{
  let body='';for await(const chunk of req)body+=chunk;
  calls.push({path:req.url,...JSON.parse(body)});
  res.setHeader('content-type','application/json');
  res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:901}}));
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 try{
  cfg.channels['kurumi-qq'].httpUrl='http://127.0.0.1:'+server.address().port;
  const bytes=Buffer.from('RIFF0000WEBP'),opts={cfg,to:'user:365999865',bytes,contentType:'image/webp',key:'requested',text:'Source',dailyLimit:1};
  await assert.rejects(sendImage({...opts,to:'group:365999865'}));
  await assert.rejects(sendImage({...opts,contentType:'image/png'}),/Invalid QQ image/);
  assert.equal((await sendImage(opts)).messageId,'901');
  assert.equal((await sendImage(opts)).messageId,'901');
  await assert.rejects(sendImage({...opts,key:'second'}),{code:'qq_category_daily_limit'});
  assert.deepEqual(calls,[{path:'/send_private_msg',user_id:365999865,message:[
   {type:'text',data:{text:'Source'}},{type:'image',data:{file:'base64://'+bytes.toString('base64')}},
  ]}]);
 }finally{await new Promise(r=>server.close(r));}
});
test('Owner and endpoint validation fail closed',()=>{const {a,cfg}=fixture();assert.equal(ownerTarget('user:365999865',a),'365999865');for(const to of ['group:365999865','123456','365999865x','user:365999865:thread'])assert.throws(()=>ownerTarget(to,a));cfg.channels['kurumi-qq'].httpUrl='http://example.com';assert.throws(()=>account(cfg));});
test('Reject group, stranger, self, wrong bot, malformed event',()=>{const {a}=fixture();assert.equal(parseInbound(valid,a,'123456789').text,'你好');for(const patch of [{message_type:'group'},{user_id:777777},{self_id:999999},{message_id:0},{message:'[CQ:at,qq=all]'}])assert.equal(parseInbound({...valid,...patch},a,'123456789'),null);});
test('CQ text is literal, not metadata',()=>{const {a}=fixture();const r=parseInbound({...valid,message:[{type:'text',data:{text:'[CQ:reply,id=1]'}}]},a,'123456789');assert.equal(r.replyId,undefined);});
test('Platform nicknames are bounded display data; missing or mismatched sender metadata uses a neutral name',async t=>{
 const {cfg,dir}=fixture();t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const cases=[
  {sender:{user_id:valid.user_id,nickname:'  阿晴\n\u202e 🐈  '},expected:'阿晴 🐈'},
  {sender:{user_id:valid.user_id,nickname:'🐈'.repeat(100)},expected:'🐈'.repeat(80)},
  {sender:undefined,expected:'用户'},
  {sender:{user_id:valid.user_id,nickname:'\u0000\n\u200b '},expected:'用户'},
  {sender:{user_id:777777,nickname:'假冒昵称'},expected:'用户'},
  {sender:{user_id:valid.user_id,nickname:42},expected:'用户'},
 ];
 const seen=[];
 const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'agent:main:kurumi-qq:direct:365999865'})},session:{resolveStorePath:()=>'/test',recordInboundSession:async()=>{}},reply:{finalizeInboundContext:x=>x,dispatchReplyWithBufferedBlockDispatcher:async({ctx})=>seen.push(ctx)}}};
 for(const [i,item] of cases.entries()){
  await handleInbound({cfg,runtime,event:{...valid,message_id:900+i,sender:item.sender},selfId:'123456789'});
  const ctx=seen.at(-1);
  assert.equal(ctx.SenderName,item.expected);assert(ctx.SenderName.isWellFormed());
  assert.equal(ctx.SenderId,'365999865');assert.equal(ctx.OriginatingTo,'user:365999865');
  assert.equal(ctx.SessionKey,'agent:main:kurumi-qq:direct:365999865');assert.equal(ctx.CommandAuthorized,true);
 }
});
test('Durable ingress and egress survive restart, unknown cannot be reserved again',()=>{const {dir}=fixture();let l=new Ledger(dir);assert(l.admit('m'));assert(!l.admit('m'));assert.equal(l.reserve('send',1),null);l.close();l=new Ledger(dir);assert(!l.admit('m'));assert.equal(l.reserve('send',1).status,'unknown');assert.throws(()=>l.reserve('second',1),/budget/);l.close();});
test('Unicode chunking never breaks surrogate pairs',()=>{const s='🐋'.repeat(20)+'\n结束';for(const limit of [1,2,7,12]){const xs=splitForQQ(s,limit);assert.equal(xs.join(''),s);assert(xs.every(x=>x.isWellFormed()));}});
test('Media rejects arbitrary files and symlink escapes',()=>{const {dir,a}=fixture();fs.writeFileSync(path.join(dir,'text'),'not an image');assert.throws(()=>localImage(path.join(dir,'text'),a));fs.symlinkSync('/etc/hosts',path.join(dir,'escape'));assert.throws(()=>localImage(path.join(dir,'escape'),a));});
test('Real HTTP adapter validates private target, sends literal segments, deduplicates',async()=>{const {cfg}=fixture();const calls=[];const server=http.createServer(async(req,res)=>{let b='';for await(const c of req)b+=c;calls.push(JSON.parse(b));res.setHeader('content-type','application/json');res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:500+calls.length}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));cfg.channels['kurumi-qq'].httpUrl=`http://127.0.0.1:${server.address().port}`;try{const args={cfg,to:'user:365999865',text:'[CQ:at,qq=all] **你好**',replyToId:'-12',key:'same'};await sendPayload(args);await sendPayload(args);assert.equal(calls.length,1);assert.equal(calls[0].user_id,365999865);assert.equal(calls[0].message[0].type,'reply');assert.equal(calls[0].message[1].type,'text');await assert.rejects(sendPayload({...args,to:'group:123'}));assert.equal(calls.length,1);}finally{await new Promise(r=>server.close(r));}});
test('Inbound dispatch uses trusted sender, core route and only final delivery',async()=>{const {cfg}=fixture();let seen;const deliveries=[];const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'agent:main:kurumi-qq:direct:365999865'})},session:{resolveStorePath:()=>'/test',recordInboundSession:async()=>{}},reply:{finalizeInboundContext:x=>x,dispatchReplyWithBufferedBlockDispatcher:async({ctx,dispatcherOptions})=>{seen=ctx;await dispatcherOptions.deliver({text:'private reasoning',isReasoning:true},{kind:'final'});await dispatcherOptions.deliver({text:'tool log'},{kind:'tool'});await dispatcherOptions.deliver({text:'你好'},{kind:'final'});}}}};const args={cfg,runtime,event:valid,selfId:'123456789',deliverOverride:async x=>deliveries.push(x)};assert((await handleInbound(args)).ok);assert((await handleInbound(args)).duplicate);assert.equal(seen.SenderId,'365999865');assert.equal(deliveries.length,1);assert.equal(deliveries[0].text,'你好');});
test('Host durable delivery ID deduplicates and cancellation fences physical I/O',async()=>{const {cfg}=fixture();let count=0;const server=http.createServer((req,res)=>{count++;res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:900+count}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));cfg.channels['kurumi-qq'].httpUrl=`http://127.0.0.1:${server.address().port}`;try{const args={cfg,to:'user:365999865',text:'durable',deliveryQueueId:'host-intent',deliveryPartIndex:2,replyToId:null};await sendPayload(args);await sendPayload(args);assert.equal(count,1);const c=new AbortController();c.abort();await assert.rejects(sendPayload({...args,deliveryQueueId:'canceled',signal:c.signal}));assert.equal(count,1);await assert.rejects(sendPayload({...args,deliveryQueueId:'revoked',assertDirectAdapterHandoff:()=>{throw Error('revoked');}}));assert.equal(count,1);}finally{await new Promise(r=>server.close(r));}});
test('Accepted request with lost receipt stays unknown and never automatically resends',async()=>{const {cfg,a}=fixture();let count=0;const server=http.createServer(async(req,res)=>{for await(const c of req){}count++;req.socket.destroy();});await new Promise(r=>server.listen(0,'127.0.0.1',r));cfg.channels['kurumi-qq'].httpUrl=`http://127.0.0.1:${server.address().port}`;try{const args={cfg,to:'user:365999865',text:'unknown',deliveryQueueId:'lost-receipt'};await assert.rejects(sendPayload(args));const reopened=new Ledger(a.stateDir);assert.equal(reopened.db.prepare('SELECT status FROM outbound').get().status,'unknown');reopened.close();await assert.rejects(sendPayload(args),/manual reconciliation/);assert.equal(count,1);}finally{await new Promise(r=>server.close(r));}});
test('Receipt observer failure does not repeat physical delivery',async()=>{const {cfg}=fixture();let count=0;const server=http.createServer((req,res)=>{count++;res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:77}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));cfg.channels['kurumi-qq'].httpUrl=`http://127.0.0.1:${server.address().port}`;try{const args={cfg,to:'user:365999865',text:'receipt',deliveryQueueId:'observer'};await assert.rejects(sendPayload({...args,onDeliveryResult:()=>{throw Error('observer failed');}}));assert.equal((await sendPayload(args)).messageId,'77');assert.equal(count,1);}finally{await new Promise(r=>server.close(r));}});
test('Inbound dispatcher delivery failure is persisted rather than reported completed',async()=>{const {cfg,a}=fixture();const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'agent:main:kurumi-qq:direct:365999865'})},session:{resolveStorePath:()=>'/test',recordInboundSession:async()=>{}},reply:{finalizeInboundContext:x=>x,dispatchReplyWithBufferedBlockDispatcher:async({dispatcherOptions})=>{dispatcherOptions.onError(Error('delivery rejected'));}}}};await assert.rejects(handleInbound({cfg,runtime,event:valid,selfId:'123456789'}),/delivery rejected/);const l=new Ledger(a.stateDir);assert.equal(l.db.prepare('SELECT status FROM inbound').get().status,'failed');l.close();});
test('Quoted confirmation remains outside original RawBody',async()=>{const {cfg}=fixture();const server=http.createServer((req,res)=>res.end(JSON.stringify({status:'ok',retcode:0,data:{message_type:'private',sender:{user_id:365999865},target_id:123456789,message:[{type:'text',data:{text:'确认 quoted-proposal'}}]}})));await new Promise(r=>server.listen(0,'127.0.0.1',r));cfg.channels['kurumi-qq'].httpUrl=`http://127.0.0.1:${server.address().port}`;let seen;const runtime={channel:{routing:{resolveAgentRoute:()=>({agentId:'main',sessionKey:'agent:main:kurumi-qq:direct:365999865'})},session:{resolveStorePath:()=>'/test',recordInboundSession:async()=>{}},reply:{finalizeInboundContext:x=>x,dispatchReplyWithBufferedBlockDispatcher:async({ctx})=>{seen=ctx;}}}};try{await handleInbound({cfg,runtime,selfId:'123456789',event:{...valid,time:1791150000,message:[{type:'text',data:{text:'只是看看'}},{type:'reply',data:{id:'123'}}]}});assert.equal(seen.RawBody,'只是看看');assert.match(seen.BodyForAgent,/确认 quoted-proposal/);assert.equal(seen.Timestamp,1791150000000);}finally{await new Promise(r=>server.close(r));}});
test('Ingress provenance is explicit; negative QQ IDs are still real messages',()=>{const {dir}=fixture();const l=new Ledger(dir);l.admit('-123','onebot');l.admit('-124','synthetic');const rows=l.db.prepare('SELECT origin FROM inbound ORDER BY id').all();assert.deepEqual(rows.map(x=>x.origin),['onebot','synthetic']);l.close();});

import {qqImageUrl,qqMediaFetchPolicy} from '../src/media.js';
test('real NT QQ image domain is accepted without widening arbitrary media access',()=>{assert.equal(new URL(qqImageUrl('https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=test&rkey=test')).hostname,'multimedia.nt.qq.com.cn');for(const url of ['http://multimedia.nt.qq.com.cn/download','https://multimedia.nt.qq.com.cn.evil.test/x','https://user:pass@multimedia.nt.qq.com.cn/x','https://multimedia.nt.qq.com.cn:8443/x','https://127.0.0.1/x'])assert.throws(()=>qqImageUrl(url),/Unsupported/);});
test('fake-IP media allowance is scoped to the exact QQ CDN host only',()=>{for(const host of ['multimedia.nt.qq.com.cn','p.qpic.cn']){const p=qqMediaFetchPolicy(`https://${host}/x`);assert.deepEqual(p.hostnameAllowlist,[host]);assert.equal(p.allowRfc2544BenchmarkRange,true);assert.equal(p.allowPrivateNetwork,undefined);assert.equal(p.dangerouslyAllowPrivateNetwork,undefined);}for(const url of ['http://p.qpic.cn/x','https://p.qpic.cn.evil.test/x','https://198.18.0.39/x','https://example.com/x'])assert.throws(()=>qqMediaFetchPolicy(url),/Unsupported/);});
