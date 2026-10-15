// Authorized native Cron + one real owner QQ digest, across a Fusion restart.
// Domain rows live only under /tmp. Creates/removes one test Cron declaration;
// retains normal channel/Cron receipts, restores service readiness, sends no
// groups/other peers and never deletes production state. No model call.
// Evidence: docs/verification/reminder-list-2026-10-11/native.json
import {manageList} from '../../plugins/personal-reminder-list/service.js';
import fs from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {rpc, ready} from '../../../scripts/fusion/rpc.mjs';
import {buildJob} from '../../plugins/personal-reminder-list/scheduler.js';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {localTime} from '../../plugins/personal-reminder-list/time.js';
import {main} from '../../scripts/reminder-list.mjs';
import {account} from '../../plugins/kurumi-qq/src/config.js';
import {onebot} from '../../plugins/kurumi-qq/src/transport.js';
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const runtime = '/home/afrangry/.openclaw-fusion', cfg = JSON.parse(fs.readFileSync(join(runtime, 'openclaw.json')));
const owner = cfg.channels['kurumi-qq'].ownerId;
assert.equal(owner, '365999865'); assert.equal(cfg.channels['kurumi-qq'].testIngress, false);
const root = fs.mkdtempSync(join(tmpdir(), 'kurumi-list-native-'));
const scheduledAt = Math.ceil((Date.now() + 45000) / 60000) * 60000, time = localTime(scheduledAt).slice(11, 16);
let seedNow = scheduledAt - 120000;
const store = new ListStore({root, ownerId: owner, defaultTimes: [time], now: () => seedNow});
const report = {at: new Date().toISOString(), scheduledAt: new Date(scheduledAt).toISOString(), time,
  boundary: 'Native deterministic command through OpenClaw Cron and real owner kurumi-qq delivery across a service restart; synthetic domain rows in /tmp, no model; one owner digest only.', owner};
let sequence = 0, jobId;
function change(args) {
  return manageList(store, args, {raw: '提醒列表 架构验证 ' + (args.title ?? '') + ' ' + (args.note ?? '') + ' ' + (args.content ?? '') + ' ' + (args.id ?? '') + ' DDL ' + (args.ddl ?? ''),
    actions: new Set([args.action]), at: seedNow, messageId: 'native-' + ++sequence, sessionKey: 'native-acceptance'});
}
function productionSnapshot() {
  const file = join(runtime, 'state/personal-reminder-list/list.sqlite');
  if (!fs.existsSync(file)) return 'absent';
  const db = new DatabaseSync(file, {readOnly: true});
  try {return JSON.stringify({items: db.prepare('SELECT * FROM items ORDER BY id').all(), settings: db.prepare('SELECT * FROM settings').all(), requests: db.prepare('SELECT * FROM requests ORDER BY message_key').all()});}
  finally {db.close();}
}
const before = productionSnapshot(), started = Date.now();
try {
  await ready();
  change({action: 'add', title: '【架构验证】无DDL待办', note: '越快越好'});
  change({action: 'add', title: '【架构验证】下午汇报', content: '提前熟悉PPT', ddl: localTime(scheduledAt + 3600000).slice(0, 16)});
  for (const [title, action] of [['不应播报的完成项', 'complete'], ['不应播报的作废项', 'void']]) {
    const i = change({action: 'add', title}).item; change({action, id: i.id, expectedVersion: i.version});
  }
  change({action: 'add', title: '不应播报的过期项', ddl: localTime(scheduledAt - 60000).slice(0, 16)});
  const unique = Date.now().toString(36);
  const job = {...buildJob(time, {root, ownerId: owner, repo: join(repo, 'chatbot')}), name: 'kurumi.reminder-list.acceptance.' + unique,
    declarationKey: 'kurumi.reminder-list.acceptance:' + unique,
    schedule: {kind: 'at', at: new Date(scheduledAt).toISOString()}, deleteAfterRun: false};
  const created = await rpc('cron.add', job); jobId = created.id ?? created.job?.id;
  assert.ok(jobId); report.jobId = jobId;
  console.log(JSON.stringify({created: jobId, scheduledAt: report.scheduledAt}));
  const restart = spawnSync('systemctl', ['--user', 'restart', 'kurumi-fusion.service'], {encoding: 'utf8', timeout: 20000});
  assert.equal(restart.status, 0); await ready(); report.restarted = true;
  assert.ok((await rpc('cron.list', {includeDisabled: true, limit: 100})).jobs.some(j => j.id === jobId));
  let runs = [];
  for (let attempt = 0; attempt < 36; attempt++) {
    runs = (await rpc('cron.runs', {id: jobId, limit: 10})).entries;
    if (runs.length) break;
    await new Promise(r => setTimeout(r, 5000));
  }
  assert.ok(runs.length, 'Native Cron did not run within bounded wait');
  report.runs = runs.map(r => ({status: r.status, runAtMs: r.runAtMs, delivered: r.delivered, deliveryStatus: r.deliveryStatus}));
  assert.ok(runs.some(r => r.status === 'ok' && (r.delivered === true || r.deliveryStatus === 'delivered')), 'Native delivery not confirmed');
  store.now = Date.now;
  store.observeDeliveries({id: jobId, time}, runs);
  const row = store.db.prepare('SELECT * FROM deliveries').get();
  assert.equal(row?.status, 'delivered'); assert.match(row.text, /无DDL待办/); assert.match(row.text, /提前熟悉PPT/);
  assert.ok(!row.text.includes('不应播报'));
  report.domain = {status: row.status, slot: row.slot_key, count: JSON.parse(row.item_ids_json).length,
    states: store.db.prepare('SELECT status,COUNT(*) n FROM items GROUP BY status').all()};
  assert.equal(report.domain.count, 2);
  const duplicateOutput = [];
  main(['run', '--slot', time], {env: {OPENCLAW_STATE_DIR: root, KURUMI_LIST_OWNER_ID: owner}, write: x => duplicateOutput.push(x)});
  assert.equal(duplicateOutput.length, 0); report.duplicateSilent = true;
  const channelDb = new DatabaseSync(cfg.channels['kurumi-qq'].stateDir + '/channel.sqlite', {readOnly: true});
  let rows;
  try {rows = channelDb.prepare("SELECT message_id FROM outbound WHERE status='sent' AND at>=?").all(started);}
  finally {channelDb.close();}
  report.qqReceipts = [];
  for (const receipt of rows) {
    const msg = await onebot(account(cfg), 'get_msg', {message_id: Number(receipt.message_id)});
    const text = Array.isArray(msg.message) ? msg.message.filter(s => s.type === 'text').map(s => s.data.text).join('') : msg.raw_message ?? '';
    if (text.includes('【架构验证】') && text.includes('提醒列表')) report.qqReceipts.push({messageId: receipt.message_id, containsActive: text.includes('无DDL待办') && text.includes('下午汇报'), excludesTerminal: !text.includes('不应播报')});
  }
  assert.equal(report.qqReceipts.length, 1); assert.ok(report.qqReceipts[0].containsActive && report.qqReceipts[0].excludesTerminal);
  report.passed = true;
} catch (error) {report.passed = false; report.error = error.message; process.exitCode = 1;}
finally {
  if (jobId) {
    try {await rpc('cron.remove', {id: jobId}); report.testJobRemoved = !(await rpc('cron.list', {includeDisabled: true, limit: 100})).jobs.some(j => j.id === jobId);}
    catch {report.testJobRemoved = false; process.exitCode = 1;}
  }
  report.productionUnchanged = productionSnapshot() === before;
  if (!report.productionUnchanged || report.testJobRemoved === false) {report.passed = false; process.exitCode = 1;}
  fs.mkdirSync(join(repo, 'docs/verification/reminder-list-2026-10-11'), {recursive: true});
  fs.writeFileSync(join(repo, 'docs/verification/reminder-list-2026-10-11/native.json'), JSON.stringify(report, null, 2) + '\n');
  store.close(); fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({passed: report.passed, error: report.error, testJobRemoved: report.testJobRemoved, productionUnchanged: report.productionUnchanged, qqReceipts: report.qqReceipts?.length}));
}
