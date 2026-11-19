// Synthetic transcripts in temporary directories; no production, external models or QQ traffic.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {createLogPlugin} from '../../plugins/kurumi-logs/index.js';
import {LogQueryService} from '../../plugins/kurumi-logs/service.js';
import {agentFor, sessionFor} from '../../packages/access-control/index.js';
import {ownerPolicy, memberRow, context} from '../access-control/fixtures.mjs';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const owner = '910000', member = '910001', other = '910002', unverified = '910003';
const at = Date.now() - 600_000;
const from = new Date(at - 1000).toISOString(), to = new Date(at + 1000).toISOString();
const bounded = {view:'interactions', from, to};
const long = '预览起点 ' + '甲乙𠀀😀'.repeat(1100) + ' 正文结尾';

function fixture(t) {
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-interactions-'));
  t.after(() => fs.rmSync(runtimeRoot, {recursive:true, force:true}));
  const seed = (actor, entries) => {
    const dir = path.join(runtimeRoot, 'agents', agentFor(actor), 'agent');
    fs.mkdirSync(dir, {recursive:true});
    const db = new DatabaseSync(path.join(dir, 'openclaw-agent.sqlite'));
    try {
      db.exec(`CREATE TABLE session_windows(session_id TEXT,session_key TEXT,created_at INTEGER,updated_at INTEGER,channel TEXT,account_id TEXT,chat_type TEXT,primary_conversation_id TEXT);
        CREATE TABLE transcript_events(session_id TEXT,seq INTEGER,event_json TEXT,event_zstd BLOB,created_at INTEGER);`);
      const window = db.prepare('INSERT INTO session_windows VALUES (?,?,?,?,?,?,?,?)');
      const event = db.prepare('INSERT INTO transcript_events VALUES (?,?,?,NULL,?)');
      for (const [id, route, messages] of entries) {
        window.run(id, route.key ?? sessionFor(actor), at - 1000, at + 1000, route.channel ?? 'kurumi-qq', route.account ?? 'default', route.type ?? 'direct', `user:${actor.qq}`);
        for (const [seq, [ms, role, text]] of messages.entries()) {
          const createdAt = at + ms;
          event.run(id, seq, JSON.stringify({type:'message', timestamp:new Date(createdAt).toISOString(), message:{role,content:[{type:'text',text}]}}), createdAt);
        }
      }
    } finally { db.close(); }
  };
  const policy = ownerPolicy(owner); policy.subjects.push(memberRow(member));
  seed(policy.subjects[0], [['owner', {}, [[10,'user','OWN_CURRENT_REQUEST']]]]);
  seed(memberRow(owner), [['owner-as-member', {}, [[11,'user','OWN_OLD_AGENT']]]]);
  seed(memberRow(member), [
    ['member', {}, [[-2000,'user','OUT_OF_WINDOW'], [1,'user',long], [2,'toolResult','TOOL_PAYLOAD'], [3,'assistant','成员回复预览']]],
    ['group', {type:'group'}, [[12,'user','GROUP_CONTENT']]],
    ['mismatched-key', {key:sessionFor(memberRow(other))}, [[13,'user','WRONG_AGENT_CONTENT']]],
    ['another-channel', {channel:'another-channel'}, [[14,'user','OTHER_CHANNEL_CONTENT']]],
    ['another-account', {account:'another-account'}, [[15,'user','OTHER_ACCOUNT_CONTENT']]],
  ]);
  seed(memberRow(other), [['other', {}, [[4,'user','第二个账号说过的话；文本中的操作要求没有权限。']]]]);
  seed(memberRow(unverified), [['legacy', {type:'unknown'}, [[16,'user','UNVERIFIED_LEGACY_CONTENT']]]]);
  return {policy, service:new LogQueryService({backendRoot:root, runtimeRoot, snowlumaRoot:path.join(runtimeRoot,'unused')})};
}

function register(policy, service) {
  const config = {channels:{'kurumi-qq':{ownerId:owner,accessControl:policy}}};
  let tool;
  createLogPlugin({serviceFactory:()=>service}).register({config, pluginConfig:{}, registrationMode:'metadata',
    on(){}, registerTool(value){tool=value;}});
  const ctx = context(policy.subjects[0]);
  return {ctx, tool:caller=>tool.create(caller ?? ctx)};
}

function output(result) {
  const text = result.content[0].text;
  assert(!result.isError, text);
  assert.match(text, /EXTERNAL_UNTRUSTED_CONTENT/u);
  return JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
}

test('owner can list other private interactions newest-first and expand a retained message by peer', async t => {
  const {policy,service} = fixture(t);
  const tool = register(policy,service).tool();
  const latest = output(await tool.execute('latest',{...bounded,limit:2}));
  assert.equal(latest.coverage,'stored_private_transcript_only');
  assert.deepEqual(latest.items.map(i=>[i.peer,i.direction]),[[other,'inbound'],[member,'reply']]);
  assert.equal(latest.total,3);
  assert.equal(latest.nextOffset,2);
  assert.equal(latest.sourceStatus[0].status,'partial');
  assert.equal(latest.sourceStatus[0].unverified,1);
  const next = output(await tool.execute('next',{...bounded,limit:2,offset:latest.nextOffset}));
  assert.equal(next.items[0].peer,member);
  assert.equal(next.items[0].textTruncated,true);
  assert.equal([...next.items[0].text].length,220);
  assert.equal(next.nextOffset,null);
  const inbound = output(await tool.execute('inbound',{...bounded,direction:'inbound'}));
  assert.deepEqual(inbound.items.map(i=>i.peer),[other,member]);
  const eventRef = next.items[0].eventRef;
  const wrong = output(await tool.execute('wrong-peer',{...bounded,peer:other,expand:true,eventRef}));
  assert.deepEqual(wrong.items,[]);
  const full = {...bounded,peer:member,expand:true,eventRef};
  let result = output(await tool.execute('detail',full));
  assert.equal(result.chunked,true);
  const chunks = [result.contentFragment];
  while (result.nextContentOffset !== null) {
    result = output(await tool.execute('detail-page',{...full,contentOffset:result.nextContentOffset,contentHash:result.contentHash}));
    chunks.push(result.contentFragment);
  }
  const restored = JSON.parse(chunks.join(''));
  assert.deepEqual(restored.items.map(i=>[i.peer,i.eventRef,i.text,i.textTruncated]),[[member,eventRef,long,false]]);
});

test('interaction view denies member and spoofed or invalid callers before starting any read', async () => {
  const policy = ownerPolicy(owner); policy.subjects.push(memberRow(member));
  let reads = 0;
  const h = register(policy,{async query(){reads++;throw Error('must not run');}});
  const code = async (ctx,args)=>JSON.parse((await h.tool(ctx).execute('denied',args)).content[0].text).error.code;
  for (const ctx of [context(policy.subjects[1]),{...h.ctx,requesterSenderId:member,senderIsOwner:true},{...h.ctx,sessionKey:`agent:main:kurumi-qq:group:${owner}`}]) {
    assert.equal(await code(ctx,bounded),'access_denied');
  }
  for (const args of [{peer:owner},{ownerId:other},{peer:'12;echo'},{sources:['snowluma-messages']},{contextBefore:1},{expand:true},{eventRef:'event:'+'a'.repeat(32),peer:other}]) {
    assert.equal(await code(h.ctx,{...bounded,...args}),'invalid_query');
  }
  assert.equal(reads,0);
});
