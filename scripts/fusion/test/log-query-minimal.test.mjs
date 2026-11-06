// Synthetic privacy, ledger and protocol regression. No live services or private fixtures.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {normalizeToolResult} from '../log-query-result.mjs';
import {collectEvents, readChannelDelivery, readSnowLumaLogs, renderQuery} from '../log-query.mjs';
import {normalizeTraceEvent} from '../../../chatbot/packages/observability/index.js';
const at = Date.parse('2026-11-07T05:50:00+08:00');
const ev = (kind, data, n=0) => normalizeTraceEvent({at:at+n,source:'openclaw-session',kind,correlation:{runId:'r1',sessionKey:'agent:main:fixture',toolCallId:'c1'},data});
test('nested business failure survives host success, arbitrary document fields do not become failures',()=>{
 const result=normalizeToolResult({ok:true,result:{content:[{type:'text',text:JSON.stringify({ok:false,code:'DENIED',requiresUserInput:true})}]}});
 assert.equal(normalizeToolResult({isError:true,content:[{type:'text',text:'opaque host failure'}]}).businessOutcome,'unknown');
 assert.equal(result.summary.ok,false);assert.equal(result.resultConflict,true);assert.equal(result.summary.requiresUserInput,true);
 assert.equal(normalizeToolResult({ok:true,document:{ok:false}}).summary.ok,true);
 for(const mode of [{},{errors:true},{audit:true}]) {
  const events=[ev('agent.inbound',{text:'PRIVATE-BODY'}),ev('agent.tool_call',{tool:'weather',arguments:{secret:'PRIVATE-BODY'}}),ev('agent.tool_result',{tool:'weather',isError:false,...result},1)];
  const output=renderQuery(events,{from:at,to:at+100,...mode,noText:true,expand:true});
  assert(!JSON.stringify(output).includes('PRIVATE-BODY'));assert(JSON.stringify(output.json).includes('DENIED'));
 }
 const query=renderQuery([ev('agent.tool_result',{tool:'weather',isError:false,...result})],{from:at,to:at+1});
 assert.equal(query.json.calls[0].executionOutcome,'ok');assert.equal(query.json.calls[0].businessOutcome,'error');
 assert.match(query.lines.join('\n'),/执行=ok 业务=error/);
 assert.equal(renderQuery([ev('agent.tool_result',{tool:'opaque',isError:false,summary:{}})],{from:at,to:at+1}).json.calls[0].businessOutcome,'unknown');
});
test('all views remove free text and paths after analysis; limits are explicit',()=>{
 const events=[ev('agent.inbound',{text:'PRIVATE-BODY'}),ev('agent.reply',{text:'PRIVATE-BODY'},1),ev('agent.reply',{text:'PRIVATE-BODY'},2)];
 for(const mode of [{},{turns:true},{audit:true},{errors:true}]) {
  const query=renderQuery(events,{from:at,to:at+100,noText:true,expand:true,raw:true,...mode,limit:1});
  assert(!JSON.stringify(query).includes('PRIVATE-BODY'));assert.equal(JSON.parse(query.lines.join('\n')).noText,true);
 }
 assert.equal(renderQuery(events,{from:at,to:at+100,limit:1}).json.truncated,true);
});
test('ledger uses exact receipt ID, range and source filter, reads without changing database',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'log-minimal-'));
 try {
  const file=path.join(root,'channel','channel.sqlite');fs.mkdirSync(path.dirname(file));
  const db=new DatabaseSync(file);db.exec('CREATE TABLE outbound(id TEXT PRIMARY KEY,status TEXT,message_id TEXT,at INTEGER)');
  db.prepare('INSERT INTO outbound VALUES(?,?,?,?)').run('delivery:test','sent','fixture-receipt',at);db.close();
  const before=fs.readFileSync(file);
  const rows=collectEvents({runtimeRoot:root,snowlumaRoot:root,from:at,to:at,sources:['channel-delivery']});
  assert.equal(rows.length,1);assert.equal(rows[0].correlation.qqMessageId,'fixture-receipt');assert.equal(rows[0].correlation.runId,undefined);
  assert.equal(rows[0].data.snapshotOfCurrentState,true);assert.equal(readChannelDelivery(file,at+1,at+2).length,0);
  assert.deepEqual(fs.readFileSync(file),before);
  assert.equal(readChannelDelivery(path.join(root,'missing.sqlite'),at,at).length,0);assert(!fs.existsSync(path.join(root,'missing.sqlite')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('nonempty multiline previews are retained and never advertised as full messages',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'log-preview-'));
 try{
  fs.mkdirSync(path.join(root,'runtime','logs'),{recursive:true});fs.writeFileSync(path.join(root,'runtime','logs','snowluma-2026-11-07.log'),'05:50:00 INFO [OneBot] 私聊 123 | 发送：line1\nline2\n05:50:01 INFO ordinary\nnot part of message');
  const rows=readSnowLumaLogs(root,at,at+1000);assert.equal(rows[0].data.text,'line1\nline2');assert.equal(rows[0].data.textCompleteness,'preview-unknown');
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
