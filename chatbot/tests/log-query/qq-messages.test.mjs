import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {LogQueryService} from '../../plugins/kurumi-logs/service.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const base = Date.parse('2026-11-10T01:00:00.000Z');

test('a time search separates nearby private operations and returns an exact reference', async t => {
  const root = mkdtempSync(join(tmpdir(),'kurumi-qq-messages-'));
  t.after(() => rmSync(root,{recursive:true,force:true}));
  const file = join(root,'agents/main/agent/openclaw-agent.sqlite');
  mkdirSync(dirname(file),{recursive:true});
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at INTEGER,updated_at INTEGER,
    channel TEXT,account_id TEXT,chat_type TEXT,primary_conversation_id TEXT);
    CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,created_at INTEGER);`);
  const window = db.prepare('INSERT INTO session_windows VALUES(?,?,?,?,?,?,?,?)');
  window.run('owner','agent:main:kurumi-qq:direct:100001',base,base+60_000,'kurumi-qq','default','direct','user:100001');
  window.run('other','agent:main:kurumi-qq:direct:100009',base,base+60_000,'kurumi-qq','default','direct','user:100009');
  const insert = db.prepare('INSERT INTO transcript_events VALUES(?,?,?,NULL,?)');
  let seq = 0;
  function message(session, seconds, role, content, runId) {
    const at = base+1000*seconds;
    insert.run(session,++seq,JSON.stringify({type:'message',timestamp:new Date(at).toISOString(),
      __openclaw:{runId},message:{role,content}}),at);
  }
  for (const [i,text,action] of [[1,'查名单','list'],[2,'确认第一项','commit'],[3,'确认第二项','commit'],[4,'无关闲聊']]) {
    const runId = 'run-'+i;
    message('owner',i*10,'user',text,runId);
    if (action) message('owner',i*10+1,'assistant',[{type:'toolCall',id:'tool-'+i,name:'kurumi_access',arguments:{action}}],runId);
  }
  message('other',44,'user','其他会话', 'other');
  message('owner',45,'assistant',[{type:'text',text:'闲聊回复'}],'run-4');
  db.close();
  const service = new LogQueryService({backendRoot:repo,runtimeRoot:root,snowlumaRoot:root},{now:()=>base+60_000});
  const args = {view:'qq-messages',from:new Date(base).toISOString(),to:new Date(base+59_999).toISOString()};
  const result = await service.query({...args,direction:'inbound'},{ownerId:'100001'});
  assert.equal(result.total,4);
  assert.deepEqual(result.items.map(({preview,actions})=>[preview,actions]),[
    ['无关闲聊',[]],['确认第二项',['kurumi_access.commit']],['确认第一项',['kurumi_access.commit']],['查名单',['kurumi_access.list']],
  ]);
  const detail = await service.query({view:'events',sources:['openclaw-session'],from:result.from,to:result.to,eventRef:result.items[2].eventRef});
  assert.equal(detail.total,1);
  assert.equal(detail.events[0].data.text,'确认第一项');
  const replies = await service.query({...args,peer:'100001',direction:'reply'},{ownerId:'100001'});
  assert.deepEqual(replies.items.map(item=>item.preview),['闲聊回复']);
});
