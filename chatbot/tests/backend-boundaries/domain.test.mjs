// Offline refactor regressions: temporary state and actual plugin factories.
// No model, QQ, external API, service restart or production state access.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, readFileSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {manageList} from '../../plugins/personal-reminder-list/service.js';
import {prepareAddedItem} from '../../plugins/personal-reminder-list/model.js';
import memoryPlugin from '../../plugins/kurumi-memory/index.js';
import {readMemory, writeMemory} from '../../plugins/kurumi-memory/store.js';

const owner = '100001', sessionKey = `agent:main:kurumi-qq:direct:${owner}`;
function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-boundaries-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  return root;
}
function listFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-list-boundaries-'));
  const store = new ListStore({root, ownerId: owner, now: () => Date.parse('2026-10-16T08:00:00+08:00')});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  let sequence = 0;
  const permit = (raw, action) => ({raw, actions: new Set([action]), at: store.now(), messageId: String(++sequence), sessionKey});
  const snapshot = () => JSON.stringify(['items', 'requests', 'audit', 'settings'].map(table => store.db.prepare(`SELECT * FROM ${table}`).all()));
  return {store, permit, snapshot};
}

test('internal storage takes structured facts; the tool service separately enforces source rules', t => {
  const {store, permit, snapshot} = listFixture(t);
  const fields = prepareAddedItem({action: 'add', title: '结构化资料'}, store.now());
  const saved = store.transaction(() => store.addItem(fields, {runId: 'internal-fixture'}));
  assert.equal(saved.item.title, fields.title);
  const before = snapshot();
  assert.throws(() => manageList(store, {action: 'add', title: '模型概括'}, permit('提醒列表添加 原始资料', 'add')), /本次原文/);
  assert.equal(snapshot(), before);
});

test('correct item ID still requires the existing target policy; denial cannot leave writes', t => {
  const {store, permit, snapshot} = listFixture(t);
  const created = manageList(store, {action: 'add', title: '材料归档'}, permit('提醒列表添加材料归档', 'add')).item;
  const args = {action: 'void', id: created.id, expectedVersion: created.version};
  const request = permit('提醒列表第1条作废', 'void'), before = snapshot();
  assert.throws(() => manageList(store, args, request), /没有指出/);
  assert.equal(snapshot(), before);
  request.raw = '提醒列表材料归档作废';
  assert.equal(manageList(store, args, request).item.status, 'void');
  assert.equal(store.get({history: true}).items[0].version, 2);
});

test('item, audit and replay ledger roll back together if recording the request fails', t => {
  const {store, permit, snapshot} = listFixture(t), before = snapshot();
  const recordRequest = store.recordRequest;
  store.recordRequest = () => { throw Error('injected ledger failure'); };
  const args = {action: 'add', title: '原子写入'}, request = permit('提醒列表添加原子写入', 'add');
  assert.throws(() => manageList(store, args, request), /injected ledger failure/);
  assert.equal(snapshot(), before);
  store.recordRequest = recordRequest;
  assert.equal(manageList(store, args, request).ok, true);
  assert.equal(manageList(store, args, request).idempotent, true);
  assert.equal(store.db.prepare('SELECT COUNT(*) n FROM audit').get().n, 1);
});

test('schedule version, audit and replay ledger share the same transaction', t => {
  const {store, permit, snapshot} = listFixture(t), before = snapshot();
  store.recordRequest = () => { throw Error('injected settings failure'); };
  assert.throws(() => manageList(store, {action: 'schedule', times: ['09:00']}, permit('提醒列表每天09:00播报', 'schedule')), /settings failure/);
  assert.equal(snapshot(), before);
});

function memoryFixture(t) {
  const workspace = directory(t), hooks = {}, factories = {};
  const config = {channels: {'kurumi-qq': {ownerId: owner}}, agents: {entries: {main: {workspace}}}};
  memoryPlugin.register({config, on: (name, handler) => hooks[name] = handler,
    registerTool: (factory, metadata) => factories[metadata.name] = factory});
  const ctx = {senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', sessionKey,
    getRuntimeConfig: () => config, assertInvocationCurrent() {}};
  let sequence = 0;
  const dispatch = (raw, patch = {}) => hooks.reply_dispatch({ctx: {CommandAuthorized: true, ChatType: 'direct',
    SenderId: owner, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${owner}`, SessionKey: sessionKey,
    RawBody: raw, Timestamp: Date.now(), MessageSid: String(++sequence), ...patch}});
  const create = (context = ctx) => factories.kurumi_memory.create(context);
  const run = async (tool, args) => JSON.parse((await tool.execute('call', args)).content[0].text);
  return {workspace, ctx, dispatch, create, run};
}

test('memory storage remains reusable without chat text; revision guards remain enforced', t => {
  const workspace = directory(t);
  writeMemory(workspace, {entries: [{id: '123456abcdef', text: '离线结构化事实'}]}, 0);
  assert.equal(readMemory(workspace).revision, 1);
  const before = readFileSync(join(workspace, 'MEMORY.md'));
  assert.throws(() => writeMemory(workspace, {entries: []}, 0), /已改变/);
  assert.deepEqual(readFileSync(join(workspace, 'MEMORY.md')), before);
});

test('actual memory tool rejects inferred/quoted facts and preserves a captured current request through reads', async t => {
  const f = memoryFixture(t);
  f.dispatch('看看这段引用', {BodyForAgent: '记住：参考偏好'});
  await assert.rejects(f.run(f.create(), {action: 'upsert', text: '参考偏好'}), /本次主人原文/);
  assert.equal(existsSync(join(f.workspace, 'MEMORY.md')), false);
  f.dispatch('请记住：参考偏好');
  const tool = f.create();
  assert.equal((await f.run(f.create(), {action: 'list'})).entries.length, 0);
  const args = {action: 'upsert', text: '参考偏好'};
  assert.equal((await f.run(tool, args)).ok, true);
  assert.equal((await f.run(tool, args)).revision, 1);
  f.dispatch('现在聊别的');
  await assert.rejects(f.run(tool, args), /已经过期/);
  assert.equal(readMemory(f.workspace).revision, 1);
});

test('memory owner authorization still precedes any storage access', async t => {
  const f = memoryFixture(t);
  await assert.rejects(f.run(f.create({...f.ctx, senderIsOwner: false}), {action: 'list'}), /owner private/);
  assert.equal(existsSync(join(f.workspace, 'MEMORY.md')), false);
});
