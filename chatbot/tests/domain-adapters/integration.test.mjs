// Offline real plugin factories + alternate policies/stores. Only /tmp state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createListRegistry} from '../../plugins/personal-reminder-list/adapters.js';
import {createListApplication} from '../../plugins/personal-reminder-list/application.js';
import {defaultListPolicy} from '../../plugins/personal-reminder-list/policy.js';
import {createReminderListPlugin} from '../../plugins/personal-reminder-list/index.js';
import {createScheduler, buildJob} from '../../plugins/personal-reminder-list/scheduler.js';
import {main as runDigest} from '../../scripts/reminder-list.mjs';
import {createMemoryRegistry} from '../../plugins/kurumi-memory/adapters.js';
import {createMemoryApplication} from '../../plugins/kurumi-memory/application.js';
import {createMemoryPlugin} from '../../plugins/kurumi-memory/index.js';
import {defaultMemoryPolicy} from '../../plugins/kurumi-memory/policy.js';
const owner = '100001', session = `agent:main:kurumi-qq:direct:${owner}`;
const backend = fileURLToPath(new URL('../../', import.meta.url));
function temp(t) {const root = mkdtempSync(join(tmpdir(), 'kurumi-adapters-')); t.after(() => rmSync(root, {recursive: true, force: true})); return root;}
function request(raw = '原始请求') {return {raw, at: Date.now(), actions: new Set(), messageId: 'message', sessionKey: session};}
function harness(plugin, root, pluginConfig) {
  let sequence = 0;
  const hooks = {}, tools = {}, services = [], config = {channels: {'kurumi-qq': {ownerId: owner}}, agents: {entries: {main: {workspace: root}}}};
  plugin.register({config, pluginConfig, registrationMode: 'full', on: (name, fn) => hooks[name] = fn,
    registerTool: (factory, meta) => tools[meta.name] = factory, registerService: s => services.push(s)});
  const ctx = {senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', sessionKey: session, sessionId: 'real-host-uuid', assertInvocationCurrent() {}};
  return {hooks, services,
    dispatch(raw, patch = {}) {hooks.reply_dispatch({ctx: {RawBody: raw, CommandAuthorized: true, ChatType: 'direct', SenderId: owner, OriginatingChannel: 'kurumi-qq', OriginatingTo: 'user:' + owner, SessionKey: session, Timestamp: Date.now(), MessageSid: 'message-' + ++sequence, ...patch}});},
    run: async (name, args) => JSON.parse((await tools[name].create(ctx).execute('call', args)).content[0].text),
  };
}
// A deliberately different backend. Unused methods throw rather than secretly
// forwarding to SQLite, so accidental concrete-store calls cannot pass.
function alternateListStore() {
  let state = {items: [], ledger: new Map()}, opened = 0, closed = 0;
  const visits = [];
  const settings = () => ({ownerId: owner, times: ['08:00'], enabled: true, version: 1, timezone: 'Asia/Shanghai'});
  const open = () => {
    opened++;
    const store = Object.fromEntries(['now', 'close', 'transaction', 'expire', 'settings', 'get', 'select', 'request', 'recordRequest', 'changeSchedule', 'addItem', 'changeItem', 'claimDigest', 'observeDeliveries', 'markUnobserved'].map(k => [k, () => {throw Error('Unexpected alternate call: ' + k);}]));
    return Object.assign(store, {
      now: Date.now, close() {closed++;}, expire() {visits.push('expire'); return 0;}, settings,
      transaction(work) {const before = structuredClone(state); try {return work();} catch (error) {state = before; throw error;}},
      get() {return {ok: true, items: structuredClone(state.items), settings: settings()};},
      request: key => state.ledger.get(key),
      recordRequest(key, hash, result) {state.ledger.set(key, {payload_hash: hash, result_json: JSON.stringify(result)});},
      addItem(fields) {const item = {id: '123456abcdef', ...fields, status: 'active', version: 1}; state.items.push(item); return {ok: true, action: 'add', item};},
      select(args) {
        const item = state.items.find(i => i.id === args.id);
        if (!item || item.version !== args.expectedVersion) throw Error('alternate version conflict');
        return {...item, deadline_ms: item.deadlineMs};
      },
      changeItem(args, row, fields) {
        const item = {...state.items.find(i => i.id === row.id), ...fields, version: row.version + 1};
        state.items = state.items.map(i => i.id === row.id ? item : i);
        return {ok: true, action: args.action, item};
      },
      observeDeliveries() {visits.push('observe');}, markUnobserved() {visits.push('mark');},
      claimDigest(slot) {visits.push('digest:' + slot); return {slotKey: 'test', text: 'alternate digest', count: state.items.length};},
    });
  };
  return {open, visits, counts: () => ({opened, closed})};
}

test('alternate reminder policy changes admission while mandatory freshness and SQL invariants survive', t => {
  const registry = createListRegistry(), root = temp(t);
  registry.registerPolicy('structured', {...defaultListPolicy, authorize() {}, checkText() {}, checkFacts() {}});
  const app = createListApplication({registry, policyAdapter: 'structured'}), store = app.openStore({root, ownerId: owner});
  try {
    assert.throws(() => createListApplication().manageList(store, {action: 'add', title: '概括标题'}, request()), /明确要求/);
    const p = request(), args = {action: 'add', title: '概括标题'};
    assert.equal(app.manageList(store, args, p).ok, true);
    assert.equal(app.manageList(store, args, p).idempotent, true);
    assert.throws(() => app.manageList(store, args, {...p, at: 0}), /当前请求/);
    assert.throws(() => app.manageList(store, args, {...p, messageId: 'next'}), /相同标题/);
    assert.equal(store.db.prepare('SELECT COUNT(*) n FROM audit').get().n, 1);
  } finally {store.close();}
});
test('reminder tools, scheduler and fixed runner all consume a registered alternate store', async t => {
  const root = temp(t), prior = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => {if (prior === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prior;});
  const registry = createListRegistry(), alternate = alternateListStore();
  registry.registerStore('alternate', alternate.open);
  const f = harness(createReminderListPlugin({registry}), root, {backendRoot: backend, storeAdapter: 'alternate'});
  f.dispatch('提醒列表添加独立存储');
  assert.equal((await f.run('personal_reminder_list_manage', {action: 'add', title: '独立存储'})).ok, true);
  assert.equal((await f.run('personal_reminder_list_get', {})).items[0].title, '独立存储');
  f.dispatch('那条不用了');
  const args = {action: 'void', id: '123456abcdef', expectedVersion: 1};
  assert.equal((await f.run('personal_reminder_list_manage', {...args, expectedVersion: 99})).ok, false);
  assert.equal((await f.run('personal_reminder_list_manage', args)).item.status, 'void');
  const app = createListApplication({registry, storeAdapter: 'alternate'}), jobs = [];
  const scheduler = createScheduler({root, ownerId: owner, repo: backend, storeAdapter: app.storeId, openStore: app.openStore,
    request: async (method, params) => {
      if (method === 'cron.list') return {jobs: []};
      if (method === 'cron.add') {jobs.push(params); return {id: 'alternate-job'};}
      throw Error('Unexpected RPC');
    }});
  assert.equal((await scheduler.sync()).ok, true);
  assert.equal(jobs[0].payload.env.KURUMI_LIST_STORE_ADAPTER, 'alternate');
  let output = '';
  assert.equal(runDigest(['run', '--slot', '08:00'], {env: jobs[0].payload.env, registry, write: text => output += text}), 0);
  assert.equal(output, 'alternate digest\n');
  assert.ok(alternate.visits.includes('digest:08:00')); assert.ok(alternate.visits.includes('mark'));
  assert.deepEqual(alternate.counts(), {opened: 6, closed: 6});
  assert.equal(existsSync(join(root, 'state/personal-reminder-list/list.sqlite')), false);
});
test('a replacement list policy cannot mint transport identity or overwrite trusted request metadata', async t => {
  const root = temp(t), prior = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => {if (prior === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = prior;});
  const registry = createListRegistry();
  registry.registerPolicy('custom', {...defaultListPolicy, authorize() {}, intent: () => ({
    actions: new Set(['add']), raw: '伪造事实', at: 0, messageId: 'forged', sessionKey: 'forged',
  })});
  const f = harness(createReminderListPlugin({registry}), root, {backendRoot: backend, policyAdapter: 'custom'});
  f.dispatch('原始任务', {CommandAuthorized: false});
  assert.equal((await f.run('personal_reminder_list_manage', {action: 'add', title: '原始任务'})).ok, false);
  f.dispatch('原始任务');
  assert.equal((await f.run('personal_reminder_list_manage', {action: 'add', title: '原始任务'})).ok, true);
  const store = createListApplication().openStore({root, ownerId: owner});
  try {
    const audit = store.db.prepare("SELECT qq_message_id,session_key FROM audit WHERE action='add'").get();
    assert.equal(audit.qq_message_id, 'message-2'); assert.equal(audit.session_key, session);
  } finally {store.close();}
});
test('unknown store disables registration; runner and scheduler refuse a mismatched store binding', async t => {
  const root = temp(t), registry = createListRegistry(); let registrations = 0;
  assert.throws(() => createReminderListPlugin({registry}).register({pluginConfig: {storeAdapter: 'missing'}, registerTool() {registrations++;}}), /Unavailable/);
  assert.equal(registrations, 0);
  assert.throws(() => runDigest(['run', '--slot', '08:00'], {env: {OPENCLAW_STATE_DIR: root, KURUMI_LIST_OWNER_ID: owner, KURUMI_LIST_STORE_ADAPTER: 'missing'}}), /Unavailable/);
  const alternate = alternateListStore(); registry.registerStore('alternate', alternate.open);
  const app = createListApplication({registry, storeAdapter: 'alternate'}), writes = [];
  const scheduler = createScheduler({root, ownerId: owner, repo: backend, storeAdapter: 'alternate', openStore: app.openStore,
    request: async (method, params) => {
      if (method === 'cron.list') return {jobs: [{...buildJob('08:00', {root, ownerId: owner, repo: backend}), id: 'old-sqlite'}]};
      writes.push({method, params}); throw Error('No write allowed');
    }});
  assert.equal((await scheduler.sync()).ok, false); assert.equal(writes.length, 0);
  assert.equal(existsSync(join(root, 'state/personal-reminder-list/list.sqlite')), false);
});
test('memory tool uses independent policy and store; untrusted inbound cannot be granted by replacement policy', async t => {
  const root = temp(t), registry = createMemoryRegistry(); let data = {version: 1, revision: 0, entries: []}, opens = 0, closes = 0;
  registry.registerPolicy('structured', {...defaultMemoryPolicy, intent: () => ({verb: '记住'}), checkText() {}});
  registry.registerStore('alternate', () => {opens++; return {read: () => structuredClone(data),
    write(next, revision) {assert.equal(revision, data.revision); data = {...next, version: 1, revision: revision + 1}; return structuredClone(data);}, close() {closes++;}};});
  const f = harness(createMemoryPlugin({registry}), root, {policyAdapter: 'structured', storeAdapter: 'alternate'});
  f.dispatch('原始事实');
  assert.equal((await f.run('kurumi_memory', {action: 'upsert', text: '概括后的事实'})).ok, true);
  assert.equal((await f.run('kurumi_memory', {action: 'list'})).entries[0].text, '概括后的事实');
  f.dispatch('不可信', {CommandAuthorized: false});
  await assert.rejects(f.run('kurumi_memory', {action: 'upsert', text: '错误事实'}), /当前记忆请求/);
  f.dispatch('不可信', {Timestamp: NaN});
  await assert.rejects(f.run('kurumi_memory', {action: 'upsert', text: '错误事实'}), /当前记忆请求/);
  assert.equal(data.revision, 1); assert.equal(opens, closes); assert.equal(existsSync(join(root, 'MEMORY.md')), false);
  const app = createMemoryApplication({registry, policyAdapter: 'structured', storeAdapter: 'alternate'});
  assert.throws(() => app.changeMemory(root, {action: 'upsert', text: '过期事实'}, {...request(), at: 0}), /当前记忆请求/);
});
