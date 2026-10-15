// Offline query integration: audit adapter reads only a temporary list DB.
import {manageList} from '../../plugins/personal-reminder-list/application.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {readReminderListDatabase, filterEvents, collectEvents} from '../../../scripts/fusion/log-query.mjs';
test('list audit joins exact message/item/slot and does not copy task text or invent scheduled turn', t => {
  const root = fs.mkdtempSync(join(tmpdir(), 'kurumi-list-query-')), now = Date.parse('2026-10-11T08:00:10+08:00');
  const store = new ListStore({root, ownerId: '365999865', now: () => now});
  t.after(() => {store.close(); fs.rmSync(root, {recursive: true, force: true});});
  const created = manageList(store, {action: 'add', title: '私有测试标题'}, {raw: '提醒列表添加 私有测试标题', actions: new Set(['add']), at: now, messageId: 'm1', sessionKey: 'agent:main:kurumi-qq:direct:365999865'}, {runId: 'run1'});
  store.claimDigest('08:00');
  store.observeDeliveries({id: 'cron1', time: '08:00'}, [{runAtMs: now, delivered: true}]);
  const events = readReminderListDatabase(store.file, now - 1, now + 1);
  const mutation = events.find(e => e.kind === 'reminder-list.add');
  assert.equal(mutation.correlation.qqMessageId, 'm1'); assert.equal(mutation.correlation.reminderId, created.item.id);
  assert.ok(!JSON.stringify(events).includes('私有测试标题'));
  const digest = events.find(e => e.kind === 'reminder-list.digest.delivered');
  assert.equal(digest.correlation.cronJobId, 'cron1'); assert.equal(digest.correlation.eventKey, '2026-10-11T08:00');
  assert.equal(digest.correlation.qqMessageId, undefined); assert.equal(digest.correlation.sessionKey, undefined);
  assert.deepEqual(filterEvents(events, {messageId: 'm1'}), [mutation]);
  assert.equal(collectEvents({from: now - 1, to: now + 1, runtimeRoot: root, sources: ['personal-reminder-list']}).length, 3);
});
test('missing DB is absent, corrupt DB is an explicit failure', () => {
  assert.deepEqual(readReminderListDatabase('/tmp/no-such-reminder-list-db', 0, Date.now()), []);
  const dir = fs.mkdtempSync(join(tmpdir(), 'kurumi-list-corrupt-')), file = join(dir, 'broken.sqlite');
  try {fs.writeFileSync(file, 'broken'); assert.throws(() => readReminderListDatabase(file, 0, Date.now()));}
  finally {fs.rmSync(dir, {recursive: true, force: true});}
});
