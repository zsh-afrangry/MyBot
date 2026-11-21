import {withAccess} from '../access-control/fixtures.mjs';
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「账单维护」与「如何验证」。
// Plugin factories and host-shaped hooks. The receipt scenario uses loopback FastAPI and disposable SQLite.
// No real QQ, paid model or production state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createToolTrace} from '../../packages/knowledgemap-client/tool-trace.js';
import {createKnowledgeMapPlugin, billTools} from '../../plugins/kurumi-knowledgemap/index.js';
import {startIsolatedKnowledgeMap} from './isolated-api.mjs';

const owner = '365999865', sessionKey = `agent:main:kurumi-qq:direct:${owner}`;
const ctx = {sessionKey, sessionId: 'session1', senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', assertInvocationCurrent() {}};
const event = (text, id = '1') => ({ctx: {RawBody: text, MessageSid: id, Timestamp: Date.now(), ChatType: 'direct', CommandAuthorized: true,
  SenderId: owner, SessionKey: sessionKey, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${owner}`}});
function fixture({client,pluginConfig} = {}) {
  const hooks = {}, factories = {}, calls = [];
  const fire = (name, e, c = {}) => hooks[name]?.forEach(fn => fn(e, c));
  createKnowledgeMapPlugin({clientFactory: () => ({async request(path, options) {
    calls.push({path,options});
    return client ? client.request(path,options) : {ok:true,items:[{id:5,version:2}],item:{id:5,version:3}};
  }})}).register({
    pluginConfig,
    config: withAccess({channels: {'kurumi-qq': {ownerId: owner}}}), on: (name, fn) => (hooks[name] ??= []).push(fn),
    registerTool: (f, m) => factories[m.name] = f,
  });
  return {fire, calls, tool: (name, context=ctx) => factories[name].create(context)};
}
const execute = async (tool, args, callId = 'c1') => JSON.parse((await tool.execute(callId, args)).content[0].text);

test('manifest, model catalog and approved runtime expose the same three bill tools', () => {
  const manifest = JSON.parse(readFileSync(new URL('../../plugins/kurumi-knowledgemap/openclaw.plugin.json', import.meta.url)));
  const config = JSON.parse(readFileSync(new URL('../../../config/runtime.config.json', import.meta.url)));
  assert.deepEqual(manifest.contracts.tools, billTools.map(t => t.name));
  for (const {name} of billTools) {
    assert.equal(manifest.toolMetadata[name].optional, true);
    assert.ok(config.agents.entries.main.tools.alsoAllow.includes(name));
  }
});

test('host hook runId is isolated by session, call and concrete tool; factory fields are not required', () => {
  const hooks = {}; let clock = 1;
  const trace = createToolTrace(['knowledge_bill_manage'], () => clock);
  trace.attach({on: (name, fn) => hooks[name] = fn});
  hooks.before_tool_call({toolName: 'tool_call', toolCallId: 'c1', params: {id: 'openclaw:kurumi-knowledgemap:knowledge_bill_manage'}}, {...ctx, runId: 'actual-run'});
  assert.equal(trace.resolve(ctx, 'c1', 'knowledge_bill_manage'), 'actual-run');
  assert.equal(trace.resolve({...ctx, sessionId: 'other'}, 'c1', 'knowledge_bill_manage'), undefined);
  assert.equal(trace.resolve(ctx, 'other', 'knowledge_bill_manage'), undefined);
  assert.equal(trace.resolve(ctx, 'c1', 'knowledge_bill_add'), undefined);
  clock += 300000;
  assert.equal(trace.resolve(ctx, 'c1', 'knowledge_bill_manage'), undefined);
});
test('trace hooks clean up on completion and reset without clearing a new session', () => {
  const hooks = {}, trace = createToolTrace(['knowledge_bill_add']);
  trace.attach({on: (name, fn) => hooks[name] = fn});
  const call = {toolName: 'knowledge_bill_add', toolCallId: 'c1', params: {}, runId: 'real1'};
  hooks.before_tool_call(call, ctx);
  hooks.before_tool_call({...call, runId: 'real2'}, {...ctx, sessionId: 'session2'});
  hooks.before_reset({}, ctx);
  assert.equal(trace.resolve(ctx, 'c1', 'knowledge_bill_add'), undefined);
  const second = {...ctx, sessionId: 'session2'};
  assert.equal(trace.resolve(second, 'c1', 'knowledge_bill_add'), 'real2');
  hooks.after_tool_call(call, second);
  assert.equal(trace.resolve(second, 'c1', 'knowledge_bill_add'), undefined);
});
test('runId is not accepted from tool params, incomplete context or a fake factory field', () => {
  const hooks = {}, trace = createToolTrace(['knowledge_bill_add']); trace.attach({on: (name, fn) => hooks[name] = fn});
  hooks.before_tool_call({toolName: 'knowledge_bill_add', toolCallId: 'c1', params: {runId: 'fake'}}, ctx);
  assert.equal(trace.resolve({...ctx, runId: 'fake'}, 'c1', 'knowledge_bill_add'), undefined);
  hooks.before_tool_call({toolName: 'knowledge_bill_add', toolCallId: 'c1', runId: 'actual'}, {sessionKey});
  assert.equal(trace.resolve(ctx, 'c1', 'knowledge_bill_add'), undefined);
});
test('plugin forwards resolved host runId and the trusted message key for single-record writes', async () => {
  const f = fixture(); f.fire('reply_dispatch', event('那笔不用了'));
  f.fire('before_tool_call', {toolName: 'knowledge_bill_manage', toolCallId: 'c1', params: {}}, {...ctx, runId: 'actual-run'});
  const args = {action: 'delete', id: 5, expected_version: 2};
  assert.equal((await execute(f.tool('knowledge_bill_manage'), args)).ok, true);
  assert.equal(f.calls[0].path, '/api/assistant/bills/manage');
  assert.deepEqual(f.calls[0].options.body, args);
  assert.equal(f.calls[0].options.runId, 'actual-run');
  assert.match(f.calls[0].options.key, /^bills:[a-f0-9]{64}$/);
});
test('get requires actual id and emits one-row lookup without treating list position as id', async () => {
  const f = fixture(), tool = f.tool('knowledge_bills_get');
  assert.equal((await execute(tool, {action: 'get'})).ok, false);
  assert.equal(f.calls.length, 0);
  assert.deepEqual(await execute(tool, {action: 'get', id: 5}), {ok: true, item: {id: 5, version: 2}});
  assert.deepEqual(f.calls[0].options.query, {id: 5, limit: 1});
});
test('mutation without current or after superseded trusted message does not call API', async () => {
  const f = fixture();
  assert.equal((await execute(f.tool('knowledge_bill_manage'), {action: 'delete', id: 5, expected_version: 2})).ok, false);
  f.fire('reply_dispatch', event('修改这笔'));
  const old = f.tool('knowledge_bill_manage');
  f.fire('reply_dispatch', event('另一条消息', '2'));
  assert.equal((await execute(old, {action: 'update', id: 5, expected_version: 2, fields: {amount: '2.00'}})).ok, false);
  assert.equal(f.calls.length, 0);
});
test('create and manage share the same message idempotency domain', async () => {
  const f = fixture(); f.fire('reply_dispatch', event('当前明确请求'));
  await execute(f.tool('knowledge_bill_add'), {expense_date: '2026-10-17', amount: '14.00'});
  await execute(f.tool('knowledge_bill_manage'), {action: 'delete', id: 5, expected_version: 2});
  assert.equal(f.calls[0].options.key, f.calls[1].options.key);
});

test('bill feedback reads the original transaction after a lost response or later deletion', {timeout:30000}, async t => {
  const root = mkdtempSync(join(tmpdir(),'km-bill-feedback-'));
  let km;
  t.after(async () => {
    try { if (km) assert.equal(await km.close(),true); }
    finally { rmSync(root,{recursive:true,force:true}); }
  });
  km = await startIsolatedKnowledgeMap(root);
  const f = fixture({client:km.client}), get = f.tool('knowledge_bills_get');
  const realFetch = km.client.fetchImpl;
  let loseNextPost = true;
  km.client.fetchImpl = async (...args) => {
    const response = await realFetch(...args);
    if (loseNextPost && args[1].method === 'POST' && response.ok) {
      loseNextPost = false;
      await response.body?.cancel();
      throw Error('Lost response after transaction commit');
    }
    return response;
  };
  const receipt = messageId => execute(get,{action:'receipt',message_id:messageId});
  f.fire('reply_dispatch', event('记一笔合成测试账单','101'));
  const lost = await execute(f.tool('knowledge_bill_add'),{expense_date:'2026-11-21',amount:'25.50'});
  assert.equal(lost.error.code,'write_result_unknown');
  assert.equal(lost.feedback.status,'unknown');
  assert.equal(lost.feedback.evidence.sourceMessageId,'101');
  const read = await receipt('101');
  const {id,version} = read.item;
  assert.deepEqual(read.feedback,{action:'bill.create',status:'succeeded',evidence:{
    source:'request_receipt',sourceMessageId:'101',billId:id,version:1,
  }});
  assert.equal((await receipt('102')).feedback.status,'unknown');
  const denied = f.tool('knowledge_bills_get',{...ctx,senderIsOwner:false});
  assert.equal((await execute(denied,{action:'receipt',message_id:'101'})).error.code,'forbidden_context');
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,1);
  assert.equal((await km.web('bills/')).total,1);

  f.fire('reply_dispatch',event('更新合成账单','103'));
  const updated = await execute(f.tool('knowledge_bill_manage'),{action:'update',id,expected_version:version,fields:{amount:'30.00'}});
  assert.equal(updated.feedback.status,'succeeded');
  assert.equal((await receipt('103')).item.amount,'30.00');
  f.fire('reply_dispatch',event('删除合成账单','104'));
  const deletion = await execute(f.tool('knowledge_bill_manage'),{action:'delete',id,expected_version:updated.item.version});
  assert.equal(deletion.feedback.evidence.deleted,true);
  assert.deepEqual((await receipt('104')).item,{id,version:updated.item.version,expense_date:'2026-11-21',amount:'30.00',deleted:true});
  assert.equal((await receipt('101')).item.amount,'25.50');
  assert.equal((await km.web('bills/')).total,0);
  assert.equal(f.calls.filter(call=>call.options.method==='POST').length,3);

  const selected = fixture({client:km.client,pluginConfig:{feedbackActions:['bill.update']}});
  const selectedGet = selected.tool('knowledge_bills_get');
  assert.equal((await execute(selectedGet,{action:'receipt',message_id:'101'})).error.code,'feedback_disabled');
  assert.equal((await execute(selectedGet,{action:'receipt',message_id:'103'})).feedback.status,'succeeded');
});
