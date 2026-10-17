// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「测试计划」。
// Offline: real factories/current-request guard, temporary SQLite, controlled HTTP.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, writeFileSync, chmodSync, rmSync, mkdirSync, readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {KnowledgeMapClient, requestKey} from '../../packages/knowledgemap-client/client.js';
import {createBridgeInbound} from '../../packages/knowledgemap-client/inbound.js';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {ListControlStore, manageRemoteList, taskItem, runRemoteDigest, registerRemoteList} from '../../plugins/personal-reminder-list/remote.js';
import {manageParameters, getParameters} from '../../plugins/personal-reminder-list/index.js';
import {createKnowledgeMapPlugin} from '../../plugins/kurumi-knowledgemap/index.js';
import {collectEvents} from '../../../scripts/fusion/log-query.mjs';
import {sourceFile} from '../../plugins/personal-reminder-list/data-source.js';
import {main as runnerMain} from '../../scripts/reminder-list.mjs';
import {disableKnowledgeMapRecovery} from '../../../scripts/fusion/lib/recovery-isolation.mjs';
const owner = '365999865', sessionKey = `agent:main:kurumi-qq:direct:${owner}`;
const request = {sessionKey, messageId: '123'};
const row = (id = 1, fields = {}) => ({id, version: 1, title: '查党员材料', detail: null, note: '越快越好', event_date: null,
  event_time: null, completed_at: null, archived_at: null, tone: 'todo', created_at: '2026-10-17T01:00:00', updated_at: '2026-10-17T01:00:00', ...fields});
function temp(t) {const root = mkdtempSync(join(tmpdir(), 'km-bridge-unit-')); t.after(() => rmSync(root, {recursive: true, force: true})); return root;}
function client(t, fetchImpl, extra = {}) {
  const root = temp(t), tokenFile = join(root, 'token'); writeFileSync(tokenFile, 'a'.repeat(64), {mode: 0o600});
  return new KnowledgeMapClient({tokenFile, fetchImpl, trace() {}, ...extra});
}
const response = (value, status = 200) => new Response(JSON.stringify(value), {status, headers: {'content-type': 'application/json'}});
const event = (text, id = '123') => ({ctx: {RawBody: text, MessageSid: id, Timestamp: Date.now(), ChatType: 'direct', CommandAuthorized: true,
  SenderId: owner, SessionKey: sessionKey, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${owner}`}});
const config = {channels: {'kurumi-qq': {ownerId: owner}}, gateway: {port: 18890}};
const ctx = () => ({senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', sessionKey,
  sessionId: 'test-session', runId: 'test-run', getRuntimeConfig: () => config, assertInvocationCurrent() {}});
const run = async (tool, args) => JSON.parse((await tool.execute('call', args)).content[0].text);

test('restored config and persisted old runners cannot reach shared production API', t => {
  const root=temp(t), config={plugins:{entries:{
    'kurumi-knowledgemap':{enabled:true,config:{baseUrl:'http://127.0.0.1:3086',tokenFile:'/home/afrangry/.config/knowledgemap/assistant-token'}},
    'personal-reminder-list':{enabled:true,config:{dataSource:'knowledgemap',bridgeBaseUrl:'http://127.0.0.1:3086'}},
    'personal-weather':{enabled:true,config:{weatherBackend:'knowledgemap',bridgeBaseUrl:'http://127.0.0.1:3086'}},
  }}};
  mkdirSync(join(root,'state/personal-reminder-list'),{recursive:true});
  writeFileSync(sourceFile(root),JSON.stringify({dataSource:'knowledgemap',baseUrl:'http://127.0.0.1:3086',tokenFile:'/private/real'}));
  disableKnowledgeMapRecovery(config,root);
  assert.ok(Object.values(config.plugins.entries).every(e=>!e.enabled));
  assert.doesNotMatch(JSON.stringify(config),/3086|\/home\/afrangry/);
  const source=JSON.parse(readFileSync(sourceFile(root),'utf8'));
  assert.equal(source.baseUrl,'http://127.0.0.1:9');
  assert.equal(readFileSync(source.tokenFile,'utf8'),'recovery-disabled');
  assert.throws(()=>disableKnowledgeMapRecovery(config,'/home/afrangry'));
});

test('client restricts origin, auth file, HTTP operations and paths', async t => {
  for (const baseUrl of ['https://127.0.0.1:3086', 'http://evil.test', 'http://127.0.0.1/a', 'http://x:y@127.0.0.1']) assert.throws(() => client(t, fetch, {baseUrl}));
  const c = client(t, () => {throw Error('must not be called');});
  await assert.rejects(c.request('/api/assistant/../../bills'), {code: 'invalid_path'});
  await assert.rejects(c.request('/api/assistant/bills', {method: 'DELETE'}), {code: 'invalid_method'});
  chmodSync(c.tokenFile, 0o644);
  await assert.rejects(c.request('/api/assistant/status'), {code: 'credential_unavailable'});
});
test('request keys are stable per owner message and separated per domain', () => {
  assert.equal(requestKey('tasks', request), requestKey('tasks', {...request}));
  assert.notEqual(requestKey('tasks', request), requestKey('bills', request));
  assert.notEqual(requestKey('tasks', request), requestKey('tasks', {...request, messageId: '124'}));
});
test('client sends bearer and request key but redacts bodies from traces', async t => {
  const traces = [];
  const c = client(t, (url, init) => {
    assert.equal(url.pathname, '/api/assistant/bills'); assert.equal(init.redirect, 'error');
    assert.equal(init.headers.Authorization, 'Bearer ' + 'a'.repeat(64)); assert.equal(init.headers['Idempotency-Key'], 'request-1');
    return response({ok: true, item: {id: 31}});
  }, {trace: x => traces.push(x)});
  await c.request('/api/assistant/bills', {method: 'POST', body: {note: 'private detail'}, key: 'request-1', runId: 'run1'});
  assert.equal(traces[0].itemId, 31); assert.equal(traces[0].runId, 'run1');
  assert.doesNotMatch(JSON.stringify(traces), /private detail|aaaaaaa/);
});
for (const [name, fetchImpl] of [
  ['connection loss', () => {throw Error('secret');}],
  ['invalid JSON', () => new Response('{', {headers: {'content-type': 'application/json'}})],
  ['HTML', () => new Response('<html>')],
  ['server failure', () => response({detail: {code: 'failed', message: 'failed'}}, 503)],
]) test(`POST ${name} yields unknown result without automatic retries`, async t => {
  let calls = 0; const c = client(t, (...args) => {calls++; return fetchImpl(...args);});
  await assert.rejects(c.request('/api/assistant/bills', {method: 'POST', body: {}, key: 'test-request'}), {code: 'write_result_unknown'});
  assert.equal(calls, 1);
});
test('definite API version rejection remains actionable', async t => {
  const c = client(t, () => response({detail: {code: 'version_conflict', message: '请刷新'}}, 409));
  await assert.rejects(c.request('/api/assistant/tasks', {method: 'POST'}), {code: 'version_conflict', status: 409});
});
test('response size is bounded', async t => {
  const c = client(t, () => response({text: 'x'.repeat(2 * 1024 * 1024)}));
  await assert.rejects(c.request('/api/assistant/tasks'), {code: 'invalid_response'});
});
test('pagination checks snapshots, unique IDs and total', async t => {
  let calls = 0; const c = client(t, (url, init) => {
    assert.equal(init.headers['X-Kurumi-Run-Id'], 'read-run');
    calls++; if (calls === 2) assert.equal(url.searchParams.get('snapshot'), 'a'.repeat(64));
    return response({ok: true, snapshot: 'a'.repeat(64), items: [row(calls)], total: 2, truncated: calls === 1});
  });
  assert.equal((await c.allTasks({runId: 'read-run'})).length, 2);
  c.fetchImpl = () => response({ok: true, snapshot: 'a'.repeat(64), items: [row()], total: 2, truncated: true});
  await assert.rejects(c.allTasks(), {code: 'invalid_response'});
  calls = 0; c.fetchImpl = () => response({ok: true, snapshot: (++calls === 1 ? 'a' : 'b').repeat(64), items: [row(calls)], total: 2, truncated: calls === 1});
  await assert.rejects(c.allTasks(), {code: 'list_changed'});
});
test('trusted request rejects foreign, superseded, reset and expired contexts', () => {
  let clock = Date.now(); const inbound = createBridgeInbound(owner, () => clock), context = ctx();
  inbound.receive(event('我午饭吃了14元')); const old = inbound.current();
  assert.equal(inbound.require(old, context, config), old);
  assert.throws(() => inbound.require(old, {...context, sessionId: 'other'}, config));
  inbound.end({}, {sessionKey, sessionId: 'unrelated'}); assert.equal(inbound.current(), old);
  inbound.end({}, context); assert.throws(() => inbound.require(old, context, config));
  inbound.receive(event('下一条', '124')); const next = inbound.current();
  assert.throws(() => inbound.require(old, context, config));
  clock += 300000; assert.throws(() => inbound.require(next, context, config));
  assert.throws(() => inbound.require(next, {...context, requesterSenderId: 'other'}, config));
});
for (const text of ['大肥鱼，第六条可以删了', '我衣服晾好了，列表里可以去掉', '把那个作废']) test(`structured action independent of user verb: ${text}`, async () => {
  let sent; const fake = {request: async (_path, options) => {sent = options; return {ok: true, item: row(6, {archived_at: '2026-10-17T01:01:00'})};}};
  const result = await manageRemoteList(fake, {action: 'void', id: 'km:6', expectedVersion: 1}, {...request, raw: text});
  assert.deepEqual(sent.body, {action: 'void', id: 6, expected_version: 1, fields: {}});
  assert.equal(result.item.id, 'km:6'); assert.equal(result.item.status, 'void');
});
test('noDDL conditions, past/date-only deadline and real ID mappings survive', async () => {
  let body; const fake = {request: async (_p, o) => {body = o.body; return {ok: true, item: row()};}};
  await manageRemoteList(fake, {action: 'add', title: '查材料', ddl: null, note: '活动结束后，越快越好'}, request);
  assert.deepEqual(body.fields, {title: '查材料', note: '活动结束后，越快越好', event_date: null, event_time: null});
  await manageRemoteList(fake, {action: 'add', title: '逾期仍待做', ddl: '2020-01-01'}, request);
  assert.equal(body.fields.event_time, null); assert.equal(body.fields.event_date, '2020-01-01');
  await assert.rejects(manageRemoteList(fake, {action: 'void', id: 'aabbccddeeff', expectedVersion: 1}, request));
  await assert.rejects(manageRemoteList(fake, {action: 'void', id: 'km:6'}, request));
  assert.equal(taskItem(row(1, {event_date: '2020-01-01'})).status, 'active');
});
test('remote control store refuses business writes and never expires legacy rows', t => {
  const root = temp(t), legacy = new ListStore({root, ownerId: owner});
  legacy.addItem({title: '旧项', content: null, note: null, ddl: '2020-01-01', deadlineMs: 1});
  const before = legacy.db.prepare('SELECT * FROM items').all(); legacy.close();
  const controls = new ListControlStore({root, ownerId: owner});
  assert.equal(controls.expire(), 0); assert.throws(() => controls.get()); assert.throws(() => controls.addItem({}));
  assert.deepEqual(controls.db.prepare('SELECT * FROM items').all(), before); controls.close();
});
test('digest queries API, preserves overdue/noDDL, and deduplicates slot', async t => {
  const root = temp(t), now = () => Date.parse('2026-10-17T08:00:05+08:00'), options = {root, ownerId: owner, now};
  let output = ''; const api = {allTasks: async () => [row(1), row(2, {title: '逾期未完成', event_date: '2020-01-01'})]};
  await runRemoteDigest(options, api, '08:00', x => output += x);
  assert.match(output, /越快越好/); assert.match(output, /2020-01-01/); assert.match(output, /未设 DDL/);
  const first = output; await runRemoteDigest(options, api, '08:00', x => output += x); assert.equal(output, first);
});
test('digest outage neither claims slot nor announces stale list; schedule race drops result', async t => {
  const root = temp(t), options = {root, ownerId: owner, now: () => Date.parse('2026-10-17T08:00:05+08:00')};
  await assert.rejects(runRemoteDigest(options, {allTasks: async () => {throw Error('offline');}}, '08:00'));
  let store = new ListControlStore(options); assert.equal(store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 0); store.close();
  let output = '';
  await runRemoteDigest(options, {allTasks: async () => {store = new ListControlStore(options); store.changeSchedule({action: 'pause'}, {}); store.close(); return [row()];}}, '08:00', x => output += x);
  assert.equal(output, ''); store = new ListControlStore(options); assert.equal(store.db.prepare('SELECT count(*) n FROM deliveries').get().n, 0); store.close();
});
test('bill plugin enforces current owner request and exposes only approved bill operations', async () => {
  const hooks = {}, factories = {}; let sent;
  createKnowledgeMapPlugin({clientFactory: () => ({request: async (path, options) => {sent = {path, ...options}; return {ok: true};}})}).register({
    config, pluginConfig: {}, on: (n, f) => hooks[n] = f, registerTool: (f, m) => factories[m.name] = f,
  });
  assert.deepEqual(Object.keys(factories).sort(), ['knowledge_bill_add', 'knowledge_bill_manage', 'knowledge_bills_get']);
  const context = ctx(), create = name => factories[name].create(context);
  assert.equal((await run(create('knowledge_bill_add'), {amount: '14.00', expense_date: '2026-10-17'})).ok, false);
  hooks.reply_dispatch(event('我午饭吃了14元'));
  assert.equal((await run(create('knowledge_bill_add'), {amount: '14.00', expense_date: '2026-10-17'})).ok, true);
  assert.equal(sent.key, requestKey('bills', request)); assert.equal(sent.path, '/api/assistant/bills');
  const denied = factories.knowledge_bills_get.create({...context, senderIsOwner: false});
  assert.equal((await run(denied, {})).ok, false);
});
test('list failure locks route without blocking read-only automations or unrelated sessions', async t => {
  const root = temp(t), before = process.env.OPENCLAW_STATE_DIR; process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => {if (before === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = before;});
  const hooks = {}, factories = {};
  registerRemoteList({config, pluginConfig: {backendRoot: fileURLToPath(new URL('../../', import.meta.url))}, on: (n, f) => hooks[n] = f, registerService() {}, registerTool: (f, m) => factories[m.name] = f},
    [{name: 'personal_reminder_list_manage', parameters: manageParameters}, {name: 'personal_reminder_list_get', parameters: getParameters}],
    {clientFactory: () => ({request: async () => {throw Error('offline');}})});
  hooks.reply_dispatch(event('第六条删了')); const context = ctx();
  await run(factories.personal_reminder_list_manage.create(context), {action: 'void', id: 'km:6', expectedVersion: 1});
  assert.equal(hooks.before_tool_call({toolName: 'personal_reminder_propose'}, context).block, true);
  assert.equal(hooks.before_tool_call({toolName: 'automations', params: {action: 'list'}}, context), undefined);
  assert.equal(hooks.before_tool_call({toolName: 'personal_reminder_propose'}, {...context, sessionId: 'other'}), undefined);
});
test('default trace is queryable through unified adapter and contains no body/token', async t => {
  const root = temp(t), tokenFile = join(root, 'token'), before = process.env.OPENCLAW_STATE_DIR;
  writeFileSync(tokenFile, 'a'.repeat(64), {mode: 0o600}); process.env.OPENCLAW_STATE_DIR = root;
  try {
    await new KnowledgeMapClient({tokenFile, fetchImpl: () => response({ok: true, item: {id: 7}})}).request('/api/assistant/bills', {method: 'POST', body: {note: 'private'}, key: 'request-x', runId: 'run-x'});
    const events = collectEvents({from: 0, to: Date.now() + 1000, runtimeRoot: root, sources: ['knowledgemap']});
    assert.equal(events.length, 1); assert.equal(events[0].correlation.runId, 'run-x'); assert.equal(events[0].correlation.businessId, 7);
    assert.doesNotMatch(JSON.stringify(events), /private|aaaaaaa/);
  } finally {if (before === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = before;}
});
test('persisted cutover prevents old fixed jobs and local tools from using legacy rows', async t => {
  const root = temp(t), now = () => Date.parse('2026-10-17T08:00:05+08:00');
  const legacy = new ListStore({root, ownerId: owner, now});
  legacy.addItem({title: '不应读写的旧项', content: null, note: null, ddl: '2020-01-01', deadlineMs: 1});
  const before = legacy.db.prepare('SELECT * FROM items').all();
  const tokenFile = join(root, 'token'); writeFileSync(tokenFile, 'c'.repeat(64), {mode: 0o600});
  writeFileSync(sourceFile(root), JSON.stringify({dataSource: 'knowledgemap', baseUrl: 'http://127.0.0.1:3086', tokenFile}));
  assert.throws(() => legacy.get()); assert.throws(() => legacy.addItem({title: '拒绝'}));
  t.mock.method(globalThis, 'fetch', async () => response({ok: true, total: 1, snapshot: 'a'.repeat(64), truncated: false, items: [row(2, {title: 'API共享项'})]}));
  let output = '';
  await runnerMain(['run', '--slot', '08:00'], {env: {OPENCLAW_STATE_DIR: root, KURUMI_LIST_OWNER_ID: owner}, now, write: x => output += x});
  assert.match(output, /API共享项/); assert.doesNotMatch(output, /不应读写的旧项/);
  assert.deepEqual(legacy.db.prepare('SELECT * FROM items').all(), before); legacy.close();
});
