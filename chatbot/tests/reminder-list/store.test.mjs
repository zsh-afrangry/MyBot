// Offline domain tests. Only /tmp fixtures; no model, QQ or production writes.
import {manageList} from '../../plugins/personal-reminder-list/application.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {stateRoot} from '../../plugins/personal-reminder-list/application.js';
import {parseDeadline, normalizeTimes, dueSlot} from '../../plugins/personal-reminder-list/time.js';
import {listIntent} from '../../plugins/personal-reminder-list/policy.js';
import {main} from '../../scripts/reminder-list.mjs';
const OWNER = '365999865';
function fixture(t, at = '2026-10-11T08:00:05+08:00') {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-list-'));
  let now = Date.parse(at), seq = 0;
  const store = new ListStore({root, ownerId: OWNER, now: () => now});
  t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  const permit = (raw, action) => ({raw, actions: new Set([action]), at: now, messageId: String(++seq), sessionKey: `agent:main:kurumi-qq:direct:${OWNER}`});
  const add = (title, args = {}) => manageList(store, {action: 'add', title, ...args}, permit(`在提醒列表添加 ${title} ${args.content ?? ''} ${args.note ?? ''} DDL ${args.ddl ?? ''}`, 'add')).item;
  return {root, store, permit, add, clock: value => now = typeof value === 'number' ? value : Date.parse(value), now: () => now};
}
test('DDL date-only, leap date, minute, empty, invalid calendar and timezone', () => {
  assert.deepEqual(parseDeadline(null), {ddl: null, deadlineMs: null});
  assert.equal(parseDeadline('2028-02-29').deadlineMs, Date.parse('2028-03-01T00:00:00+08:00'));
  assert.equal(parseDeadline('2026-10-12T19:30').deadlineMs, Date.parse('2026-10-12T19:30:00+08:00'));
  for (const ddl of ['2026-02-29', '2026-04-31', '2026-13-01', '2026-10-11T24:00', '下次课前', '2026-10-11T08:00Z']) assert.throws(() => parseDeadline(ddl));
});
test('times normalize 24:00 and reject duplicates, malformed, empty and excess', () => {
  assert.deepEqual(normalizeTimes(['18:00', '24:00', '08:00']), ['00:00', '08:00', '18:00']);
  for (const times of [[], ['8:00'], ['00:00', '24:00'], ['25:00'], Array(25).fill('08:00')]) assert.throws(() => normalizeTimes(times));
  assert.equal(dueSlot('08:00', Date.parse('2026-10-11T08:01:59+08:00')).key, '2026-10-11T08:00');
  assert.equal(dueSlot('08:00', Date.parse('2026-10-11T08:02:00+08:00')), undefined);
});
test('explicit state root is mandatory; no legacy fallback', () => {
  assert.throws(() => stateRoot({}));
  assert.equal(stateRoot({OPENCLAW_STATE_DIR: '/tmp/x'}), '/tmp/x');
});
test('add optional fields and source validation; do not invent facts or accept past DDL', t => {
  const {store, permit, add} = fixture(t);
  const r = add('查党员材料', {note: '越快越好'});
  assert.equal(r.content, null); assert.equal(r.ddl, null); assert.equal(r.status, 'active');
  assert.throws(() => manageList(store, {action: 'add', title: '编造的任务'}, permit('提醒列表添加 查党员材料', 'add')));
  assert.throws(() => add('过期作业', {ddl: '2026-10-10'}));
  assert.equal(store.get().items.length, 1);
});
test('explicit no DDL never becomes a timestamp; urgency and activity relation cannot be dropped', t => {
  const {store, permit} = fixture(t);
  const urgent = '提醒列表加一个：查党员材料，没有DDL，时间越快越好';
  for (const args of [{ddl: '2026-10-13', note: '越快越好'}, {ddl: null}]) {
    assert.throws(() => manageList(store, {action: 'add', title: '查党员材料', ...args}, permit(urgent, 'add')));
  }
  const a = manageList(store, {action: 'add', title: '查党员材料', note: '越快越好', ddl: null}, permit(urgent, 'add')).item;
  const condition = '提醒列表添加：10月13日的选举结束后整理党费缴纳情况';
  assert.throws(() => manageList(store, {action: 'add', title: '整理党费缴纳情况', ddl: '2026-10-13', note: '选举结束后'}, permit(condition, 'add')), /不能.*补造/);
  assert.throws(() => manageList(store, {action: 'add', title: '整理党费缴纳情况', ddl: null}, permit(condition, 'add')), /条件必须/);
  const b = manageList(store, {action: 'add', title: '整理党费缴纳情况', ddl: null, note: '选举结束后'}, permit(condition, 'add')).item;
  const c = manageList(store, {action: 'add', title: '材料归档', ddl: null, note: '只要知道有这回事'}, permit('提醒列表添加材料归档，无DDL，只要知道有这回事', 'add')).item;
  for (const i of [a,b,c]) {assert.equal(i.ddl, null); assert.equal(i.deadlineMs, null);}
  const digest = store.claimDigest('08:00');
  assert.match(digest.text, /越快越好/); assert.match(digest.text, /选举结束后/); assert.match(digest.text, /只要知道有这回事/);
});
test('event relation can have a separately stated deadline; item update cannot contradict an explicit clearing request', t => {
  const {store, permit} = fixture(t);
  const a = manageList(store, {action: 'add', title: '整理党费', ddl: '2026-10-16', note: '选举后'}, permit('提醒列表添加选举后整理党费，DDL为10月16日', 'add')).item;
  assert.throws(() => manageList(store, {action: 'update', id: a.id, expectedVersion: a.version, note: '越快越好'}, permit('提醒列表修改整理党费，无DDL，越快越好', 'update')), /必须留空/);
  const b = manageList(store, {action: 'update', id: a.id, expectedVersion: a.version, ddl: null, note: '越快越好'}, permit('提醒列表修改整理党费，无DDL，越快越好', 'update')).item;
  assert.equal(b.ddl, null); assert.equal(b.deadlineMs, null);
});
test('one trusted message is durable idempotent, changed arguments cannot run another write', t => {
  const {store, permit, root, now} = fixture(t), p = permit('提醒列表添加 带身份证', 'add');
  const args = {action: 'add', title: '带身份证'};
  const first = manageList(store, args, p), second = manageList(store, args, p);
  assert.equal(first.item.id, second.item.id); assert.equal(second.idempotent, true);
  const reopened = new ListStore({root, ownerId: OWNER, now});
  try {assert.equal(manageList(reopened, args, p).idempotent, true);} finally {reopened.close();}
  assert.throws(() => manageList(store, {...args, note: '不同'}, p));
  assert.equal(store.get().items.length, 1);
});
test('completion, void, modification and explicit reopening preserve history', t => {
  const {store, permit, add} = fixture(t);
  const a = add('写作业');
  const mutate = (action, prior, fields = {}) => manageList(store, {action, id: prior.id, expectedVersion: prior.version, ...fields}, permit(`提醒列表 ${prior.title} ${fields.title ?? ''} ${fields.note ?? ''}`, action)).item;
  const modified = mutate('update', a, {note: '越快越好'});
  const completed = mutate('complete', modified);
  assert.equal(store.get().items.length, 0); assert.equal(store.get({history: true}).items.length, 1);
  const editedCompleted = mutate('update', completed, {title: 'Web作业'});
  assert.equal(editedCompleted.status, 'completed');
  const reopened = mutate('reopen', editedCompleted);
  assert.equal(reopened.status, 'active');
  const voided = mutate('void', reopened);
  assert.equal(voided.status, 'void'); assert.equal(store.get().items.length, 0);
});
test('DDL exact boundary expires once; no DDL survives; midnight belongs to next day', t => {
  const {store, add, clock, permit} = fixture(t, '2026-10-11T23:59:59+08:00');
  const a = add('今天事项', {ddl: '2026-10-11'}); add('无截止事项');
  clock('2026-10-12T00:00:00+08:00');
  assert.deepEqual(store.get().items.map(r => r.title), ['无截止事项']);
  const expired = store.get({history: true}).items.find(r => r.id === a.id);
  assert.equal(expired.status, 'expired'); assert.equal(expired.version, 2);
  assert.equal(store.db.prepare("SELECT COUNT(*) n FROM audit WHERE action='expired'").get().n, 1);
  assert.throws(() => manageList(store, {action: 'reopen', id: a.id, expectedVersion: 2}, permit('提醒列表恢复今天事项', 'reopen')));
  assert.equal(manageList(store, {action: 'reopen', id: a.id, expectedVersion: 2, ddl: null}, permit('提醒列表恢复今天事项并清除DDL', 'reopen')).item.status, 'active');
});
test('ambiguous title, unknown target and missing/stale version never mutate', t => {
  const {store, permit, add} = fixture(t), a = add('论文初稿'), b = add('论文二稿');
  const args = {action: 'complete', query: '论文', expectedVersion: 1};
  const result = manageList(store, args, permit('提醒列表论文做完了', 'complete'));
  assert.equal(result.ok, false); assert.equal(result.error.code, 'ambiguous_target'); assert.equal(result.candidates.length, 2);
  assert.throws(() => manageList(store, {action: 'complete', id: a.id}, permit('提醒列表论文初稿做完了', 'complete')));
  assert.throws(() => manageList(store, {action: 'complete', id: a.id, expectedVersion: 2}, permit('提醒列表论文初稿做完了', 'complete')));
  assert.equal(manageList(store, {action: 'complete', id: '123456abcdef', expectedVersion: 1}, permit('那条做完了', 'complete')).error.code, 'not_found');
  assert.equal(store.get().items.length, 2);
});
test('duplicate active titles, invalid inputs and partial transactions are rejected', t => {
  const {store, permit, add} = fixture(t); add('测试');
  assert.throws(() => add('测试'));
  for (const args of [{action: 'add', title: '测试二', to: 'other'}, {action: 'add', title: ''}, {action: 'schedule', times: ['00:00', '24:00']}]) assert.throws(() => manageList(store, args, permit('提醒列表 测试二', args.action)));
  assert.equal(store.get().items.length, 1);
  assert.equal(store.settings().version, 1);
});
test('TTL, malformed target and different owner cannot write', t => {
  const {store, permit, clock, now, root} = fixture(t);
  const p = permit('提醒列表添加 看论文', 'add');
  assert.throws(() => manageList(store, {action: 'complete', id: '123'}, p));
  clock(now() + 300000);
  assert.throws(() => manageList(store, {action: 'add', title: '看论文'}, p));
  assert.throws(() => new ListStore({root, ownerId: '123456789'}));
});
test('frequency alone and unknown class deadline cannot be silently invented', t => {
  const {store, permit} = fixture(t);
  assert.throws(() => manageList(store, {action: 'schedule', times: ['08:00', '18:00']}, permit('把提醒列表改为每天播报两次', 'schedule')), /具体时间/);
  assert.throws(() => manageList(store, {action: 'add', title: '作业', ddl: '2026-10-12T08:00'}, permit('提醒列表添加作业，DDL下次课前', 'add')), /澄清/);
  assert.equal(store.settings().version, 1); assert.equal(store.get().items.length, 0);
});
test('settings complete replacement changes count; pause/resume and saved preference survives restart', t => {
  const {store, permit, root, now} = fixture(t);
  const settings = manageList(store, {action: 'schedule', times: ['09:30', '20:45']}, permit('提醒列表每日播报改为09:30和20:45', 'schedule')).settings;
  assert.deepEqual(settings.times, ['09:30', '20:45']);
  manageList(store, {action: 'pause'}, permit('暂停提醒列表播报', 'pause'));
  assert.equal(store.settings().enabled, false);
  manageList(store, {action: 'resume'}, permit('恢复提醒列表播报', 'resume'));
  const fresh = new ListStore({root, ownerId: OWNER, now, defaultTimes: ['06:45']});
  try {assert.deepEqual(fresh.settings().times, settings.times);} finally {fresh.close();}
});
test('digest sorts all active records, omits terminal, outputs fields without persona or command execution', t => {
  const {store, add, permit} = fixture(t);
  add('无时间待办', {note: '越快越好'});
  add('下午汇报', {ddl: '2026-10-11T14:25', content: '提前熟悉PPT'});
  add('明天组会', {ddl: '2026-10-12T19:30'});
  const terminal = add('完成事项');
  manageList(store, {action: 'complete', id: terminal.id, expectedVersion: 1}, permit('提醒列表完成事项做好了', 'complete'));
  const digest = store.claimDigest('08:00');
  assert.equal(digest.count, 3); assert.match(digest.text, /提前熟悉PPT/); assert.match(digest.text, /越快越好/);
  assert.ok(digest.text.indexOf('下午汇报') < digest.text.indexOf('明天组会')); assert.ok(digest.text.indexOf('明天组会') < digest.text.indexOf('无时间待办'));
  assert.ok(!digest.text.includes('完成事项')); assert.ok(!digest.text.includes('主人'));
});
test('digest claim survives restart, settings edits cannot redeliver same slot; missed slots skip', t => {
  const {store, add, root, now, clock, permit} = fixture(t); add('防重');
  assert.ok(store.claimDigest('08:00')); assert.equal(store.claimDigest('08:00'), undefined);
  manageList(store, {action: 'schedule', times: ['08:00', '12:00']}, permit('提醒列表播报改为08:00和12:00', 'schedule'));
  const fresh = new ListStore({root, ownerId: OWNER, now});
  try {assert.equal(fresh.claimDigest('08:00'), undefined);} finally {fresh.close();}
  clock('2026-10-11T12:02:00+08:00'); assert.equal(store.claimDigest('12:00'), undefined);
  clock('2026-10-12T08:00:10+08:00'); assert.ok(store.claimDigest('08:00'));
});
test('empty, paused and removed times are silent; arbitrary CLI args rejected', t => {
  const {root, store, now, permit} = fixture(t), outputs = [];
  const opts = {env: {OPENCLAW_STATE_DIR: root, KURUMI_LIST_OWNER_ID: OWNER}, now, write: x => outputs.push(x)};
  assert.equal(main(['run', '--slot', '08:00'], opts), 0); assert.equal(outputs.length, 0);
  manageList(store, {action: 'pause'}, permit('暂停提醒列表', 'pause'));
  assert.equal(store.claimDigest('12:00'), undefined);
  assert.throws(() => main(['run', '--slot', '08:00', '--to', 'other'], opts));
  assert.throws(() => main(['run', '--slot', '24:00'], opts));
});
test('delivery observation matches time/day; unknown or failed never automatically retry', t => {
  const {store, add, clock, now} = fixture(t); add('投递'); store.claimDigest('08:00');
  store.observeDeliveries({id: 'job-wrong-time', time: '12:00'}, [{runAtMs: now(), delivered: true}]);
  assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'prepared');
  store.observeDeliveries({id: 'job', time: '08:00'}, [{runAtMs: now() - 86400000, delivered: true}]);
  assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'prepared');
  store.observeDeliveries({id: 'job', time: '08:00'}, [{runAtMs: now() + 1000, status: 'ok', deliveryStatus: 'not-delivered'}, {runAtMs: now(), delivered: true}]);
  assert.equal(store.db.prepare('SELECT status FROM deliveries').get().status, 'delivered');
  clock('2026-10-11T12:00:05+08:00'); store.claimDigest('12:00');
  clock(now() + 360000); store.markUnobserved();
  assert.equal(store.db.prepare("SELECT status FROM deliveries WHERE slot_key LIKE '%12:00'").get().status, 'unknown');
  assert.equal(store.claimDigest('12:00'), undefined);
  store.observeDeliveries({id: 'late-receipt', time: '12:00'}, [{runAtMs: now() - 360000, delivered: true}]);
  assert.equal(store.db.prepare("SELECT status FROM deliveries WHERE slot_key LIKE '%12:00'").get().status, 'delivered');
});
test('trusted original text only: deny strangers/groups/cron/tails/stale/instruction samples', () => {
  const now = Date.now(), ctx = {RawBody: '帮我在提醒列表里加一条：查党员材料', Timestamp: now, MessageSid: '-123', CommandAuthorized: true, ChatType: 'direct', SenderId: OWNER, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${OWNER}`, SessionKey: `agent:main:kurumi-qq:direct:${OWNER}`};
  assert.ok(listIntent(ctx, OWNER, {}, now).actions.has('add'));
  for (const change of [{SenderId: '99999'}, {ChatType: 'group'}, {SessionKey: 'agent:main:cron:123'}, {CommandAuthorized: false}, {Timestamp: now - 300001}, {RawBody: '如果提醒列表添加查党员材料'}, {RawBody: '请不要添加查党员材料到提醒列表'}]) assert.equal(listIntent({...ctx, ...change}, OWNER, {}, now), undefined);
  assert.equal(listIntent(ctx, OWNER, {isTailDispatch: true}, now), undefined);
  assert.equal(listIntent(ctx, OWNER, {sendPolicy: 'deny'}, now), undefined);
  assert.ok(listIntent({...ctx, RawBody: '我在提醒列表中查党员材料事项做好了'}, OWNER, {}, now).actions.has('complete'));
});
