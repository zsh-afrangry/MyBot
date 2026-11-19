// Synthetic source reads, identities and temporary SQLite only; no live fetches, models or QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {sqliteSightings} from '../../plugins/kurumi-sightings/store.js';
import {createSightingsCollector, createSightingsService} from '../../plugins/kurumi-sightings/service.js';
import {createSightingsPlugin} from '../../plugins/kurumi-sightings/index.js';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {agentFor} from '../../packages/access-control/index.js';
import {ownerPolicy, memberRow, context} from '../access-control/fixtures.mjs';

const url = 'https://www.bilibili.com/video/BV1ab2cd3EF4/';
const page = {url, title:'合成视频', excerpt:'真实来源的公开可见文案（合成）', sender:'PRIVATE_SENDER', reason:'PRIVATE_REASON'};
const independent = (value = page) => ({origin:'independent-public', status:'read', page:value, privateContext:'PRIVATE_CONTEXT'});
const beforeMidnight = Date.parse('2026-11-20T15:59:59.000Z');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(),'kurumi-sightings-'));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const store = sqliteSightings(root);
  let now = beforeMidnight;
  const service = createSightingsService({store,now:()=>now});
  const collect = (result, options) => createSightingsCollector({store,now:()=>now,read:async()=>result})(options);
  return {root,store,service,collect,setClock(value){now=value;}};
}

test('private referrals, mixed sources, search snippets and aborted reads never become shared sightings', async t => {
  const f = fixture(t);
  assert.deepEqual(f.service.list({}),{status:'unavailable',reason:'source_not_connected',date:'2026-11-20',timeZone:'Asia/Shanghai'});
  assert.deepEqual(fs.readdirSync(f.root),[]);
  for (const origin of ['direct-private','mixed','current-lookup']) {
    assert.deepEqual(await f.collect({...independent(), origin}),{status:'ignored',reason:'not_independent'});
  }
  for (const status of ['search-hit','denied','failed']) {
    assert.deepEqual(await f.collect({...independent(),status}),{status:'ignored',reason:'not_read'});
  }
  for (const invalid of ['https://bilibili.com.example.test/video/BV1ab2cd3EF4/', 'https://www.bilibili.com/member/private', 'http://www.bilibili.com/video/BV1ab2cd3EF4/']) {
    await assert.rejects(f.collect(independent({...page,url:invalid})),{code:'invalid_source'});
  }
  await assert.rejects(f.collect(independent({...page,excerpt:'\t'})),{code:'invalid_source'});
  await assert.rejects(f.collect(independent(),{signal:AbortSignal.abort()}),{name:'AbortError'});
  assert.deepEqual(fs.readdirSync(f.root),[]);
  f.store.initialize();
  assert.deepEqual(f.service.list({}).items,[]);
  for (const args of [{action:'write'},{date:'2026-02-30'},{limit:5},{date:null},{offset:-1}]) {
    assert.throws(()=>f.service.list(args),{code:'invalid_query'});
  }
});

test('actual independent reads use public fields only, with Shanghai days and repeatable pages', async t => {
  const f=fixture(t), seed=await f.collect(independent({...page,url:url+'?share_from=PRIVATE_TRACK#PRIVATE_FRAGMENT'}));
  const first=f.service.list({}).items[0];
  assert.equal(seed.status,'recorded');
  assert.deepEqual(first,{id:seed.id,platform:'bilibili',url,title:page.title,excerpt:page.excerpt,seenAt:new Date(beforeMidnight).toISOString()});
  assert.equal((await f.collect(independent())).status,'already_recorded');
  const recordedAgain = await f.collect(independent({...page,url:'https://t.bilibili.com/1234567890?from=PRIVATE'}));
  const latest=f.service.list({limit:1});
  assert.equal(latest.nextOffset,1);
  const following=f.service.list({date:latest.date,limit:1,offset:latest.nextOffset});
  assert.deepEqual([...latest.items,...following.items].map(row=>row.id).sort(),[seed.id,recordedAgain.id].sort());
  assert.equal(following.nextOffset,null);
  assert([latest.items[0],following.items[0]].some(row=>row.url==='https://www.bilibili.com/opus/1234567890'));
  f.setClock(beforeMidnight+1000);
  assert.equal(f.service.list({}).date,'2026-11-21');
  assert.deepEqual(f.service.list({}).items,[]);
  assert.equal(f.service.list({date:'2026-11-20'}).items.length,2);
  assert.equal(f.service.list({date:'2026-11-20'}).items[0].id,latest.items[0].id);
});

test('operator withdrawal removes the URL across dates without restoring it on another read', async t => {
  const f=fixture(t), record=await f.collect(independent());
  f.setClock(beforeMidnight+1000);
  assert.equal((await f.collect(independent())).status,'recorded');
  const script=fileURLToPath(new URL('../../scripts/sightings.mjs',import.meta.url));
  const result=spawnSync(process.execPath,[script,'--withdraw',record.id],{env:{...process.env,OPENCLAW_STATE_DIR:f.root},encoding:'utf8'});
  assert.equal(result.status,0,result.stderr);
  assert.deepEqual(JSON.parse(result.stdout),{status:'withdrawn',affected:2});
  assert.deepEqual(f.service.list({}).items,[]);
  assert.deepEqual(f.service.list({date:'2026-11-20'}).items,[]);
  assert.deepEqual(await f.collect(independent({...page,url:url+'?from=new'})),{status:'ignored',reason:'withdrawn'});
  assert.deepEqual(f.service.withdraw(record.id),{status:'already_withdrawn',affected:0});
});

test('only explicitly allowed private identities can query, and no QQ caller can publish or withdraw', async t => {
  const f=fixture(t);await f.collect(independent());
  const policy=ownerPolicy('920001'), opted=memberRow('920002'), other=memberRow('920003');
  opted.permissions['sightings.read']=true;policy.subjects.push(opted,other);
  const base={channels:{'kurumi-qq':{}},agents:{entries:{main:{workspace:'/fake/workspace',model:{primary:'fixture/local'}}}},
    plugins:{allow:['kurumi-sightings'],entries:{'kurumi-sightings':{enabled:true}}}};
  const cfg=compileAccessConfig(base,policy);
  assert(cfg.agents.entries[agentFor(opted)].tools.allow.includes('kurumi_sightings'));
  assert(!cfg.agents.entries[agentFor(other)].tools.allow.includes('kurumi_sightings'));
  base.plugins.entries['kurumi-sightings'].enabled=false;
  assert(!compileAccessConfig(base,policy).agents.entries[agentFor(opted)].tools.allow.includes('kurumi_sightings'));
  let tool, reads=0;
  createSightingsPlugin({serviceFactory:()=>({list(args){reads++;return f.service.list(args);}})}).register({config:cfg,
    runtime:{state:{resolveStateDir:()=>f.root}},registerTool(value){tool=value;}});
  const execute = (ctx,args) => tool.create(ctx).execute('fixture',args);
  for (const denied of [context(other),{...context(other),senderIsOwner:true},{...context(opted),sessionKey:'agent:main:kurumi-qq:group:920009'}]) {
    const result = await execute(denied,{});
    assert(result.isError);assert.match(result.content[0].text,/access_denied/u);
  }
  assert.equal(reads,0);
  const result=await execute(context(opted),{});
  assert(!result.isError);assert.match(result.content[0].text,/EXTERNAL_UNTRUSTED_CONTENT/u);
  assert.match(result.content[0].text,/合成视频/u);assert.doesNotMatch(result.content[0].text,/PRIVATE_/u);
  for (const action of ['record','withdraw']) {
    const r=await execute(context(opted),{action,origin:'independent-public',page});
    assert(r.isError);assert.match(r.content[0].text,/invalid_query/u);
  }
  cfg.channels['kurumi-qq'].accessControl.subjects.find(row=>row.qq===opted.qq).permissions['sightings.read']=false;
  assert((await execute(context(opted),{})).isError);
  assert.equal(reads,3);
});
