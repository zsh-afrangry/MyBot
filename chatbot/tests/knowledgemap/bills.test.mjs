import {withAccess} from '../access-control/fixtures.mjs';
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「第二轮开发与验收」。
// Offline: real plugin factories and host-shaped hooks, no model/API/QQ or private state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createToolTrace} from '../../packages/knowledgemap-client/tool-trace.js';
import {createKnowledgeMapPlugin, billTools} from '../../plugins/kurumi-knowledgemap/index.js';

const owner = '365999865', sessionKey = `agent:main:kurumi-qq:direct:${owner}`;
const ctx = {sessionKey, sessionId: 'session1', senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', assertInvocationCurrent() {}};
const event = (text, id = '1') => ({ctx: {RawBody: text, MessageSid: id, Timestamp: Date.now(), ChatType: 'direct', CommandAuthorized: true,
  SenderId: owner, SessionKey: sessionKey, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${owner}`}});
function fixture() {
  const hooks = {}, factories = {}, calls = [];
  const fire = (name, e, c = {}) => hooks[name]?.forEach(fn => fn(e, c));
  createKnowledgeMapPlugin({clientFactory: () => ({async request(path, options) {calls.push({path, options}); return {ok: true, items: [{id: 5, version: 2}], item: {id: 5, version: 3}};}})}).register({
    config: withAccess({channels: {'kurumi-qq': {ownerId: owner}}}), on: (name, fn) => (hooks[name] ??= []).push(fn),
    registerTool: (f, m) => factories[m.name] = f,
  });
  return {fire, calls, tool: name => factories[name].create(ctx)};
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
