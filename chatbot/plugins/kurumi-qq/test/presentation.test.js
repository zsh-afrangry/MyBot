import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {presentForQQ} from '../src/presentation.js';
import {Ledger} from '../src/ledger.js';
import {sendPayload} from '../src/transport.js';
test('short paragraphs separate naturally while reports and code remain grouped',()=>{
 const chat='主人，辛苦啦。\n\n先歇一会儿吧🐋';const shown=presentForQQ(chat);assert(shown.paced);assert.equal(shown.pieces.join('\n\n'),chat);
 for(const report of ['结果如下\n\n- 测试通过\n- 状态正常','代码如下\n\n```js\nconst x=1\n```','来源\n\nhttps://example.org','内容'.repeat(400)])assert.equal(presentForQQ(report).paced,false);
 assert.equal(presentForQQ(chat,1200,false).pieces.length,1);
});
test('rolling quota preserves old attempts, failed/unknown reservations and idempotent receipts across reopen',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-quota-'));let ledger=new Ledger(dir);try{
  ledger.reserve('old',undefined,2);ledger.db.prepare('UPDATE outbound SET at=? WHERE id=?').run(Date.now()-86400001,'old');ledger.reserve('recent1',undefined,2);ledger.failed('recent1');ledger.reserve('recent2',undefined,2);ledger.sent('recent2','123');ledger.close();ledger=new Ledger(dir);
  assert.throws(()=>ledger.reserve('blocked',undefined,2),/daily/);assert.equal(ledger.reserve('recent2',undefined,2).message_id,'123');assert.equal(ledger.db.prepare('SELECT count(*) n FROM outbound').get().n,3);assert.throws(()=>ledger.reserve('lifetime',3,120),/authorized/);
 }finally{ledger.close();fs.rmSync(dir,{recursive:true,force:true});}
});
test('cancelling during natural pacing stops remaining physical sends',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-pacing-'));fs.writeFileSync(path.join(dir,'token'),'test',{mode:0o600});let count=0;const controller=new AbortController();
 const server=http.createServer((req,res)=>{count++;res.end(JSON.stringify({status:'ok',retcode:0,data:{message_id:count}}));});await new Promise(r=>server.listen(0,'127.0.0.1',r));
 const cfg={channels:{'kurumi-qq':{enabled:true,ownerId:'365999865',httpUrl:`http://127.0.0.1:${server.address().port}`,wsUrl:'ws://127.0.0.1:2',httpTokenFile:path.join(dir,'token'),stateDir:dir,mediaRoot:dir,sendLimit:10,segmentDelayMs:1000}}};
 try{await assert.rejects(sendPayload({cfg,to:'user:365999865',text:'第一段🐋\n\n第二段',signal:controller.signal,onDeliveryResult:()=>controller.abort()}));assert.equal(count,1);}finally{await new Promise(r=>server.close(r));fs.rmSync(dir,{recursive:true,force:true});}
});
