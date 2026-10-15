// Offline native scheduler with fake RPC. Only temporary databases, no QQ/model.
import {manageList} from '../../plugins/personal-reminder-list/service.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, rmSync, existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createScheduler, buildJob} from '../../plugins/personal-reminder-list/scheduler.js';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
function setup(t, failures = new Set()) {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-list-schedule-')), calls = [], jobs = [], ownerId = '365999865';
  const request = async (method, args) => {
    calls.push({method, args}); if (failures.has(method)) throw Error('Fake failure');
    if (method === 'cron.list') return {jobs: structuredClone(jobs), hasMore: false};
    if (method === 'cron.runs') return {entries: []};
    if (method === 'cron.add') {const r = {id: 'job-' + jobs.length, ...structuredClone(args)}; jobs.push(r); return r;}
    if (method === 'cron.update') Object.assign(jobs.find(j => j.id === args.id), args.patch);
    if (method === 'cron.remove') jobs.splice(jobs.findIndex(j => j.id === args.id), 1);
  };
  const options = {root, ownerId, repo: fileURLToPath(new URL('../../', import.meta.url)), port: 18890, request};
  const store = new ListStore(options); t.after(() => {store.close(); rmSync(root, {recursive: true, force: true});});
  return {options, scheduler: createScheduler(options), store, jobs, calls, failures};
}
test('fixed command payload and owner route; defaults create four jobs once', async t => {
  const {scheduler, jobs, options, calls} = setup(t);
  assert.equal((await scheduler.sync()).ok, true); assert.equal(jobs.length, 4);
  assert.ok(existsSync(jobs[0].payload.argv[1]));
  assert.equal(jobs[0].payload.kind, 'command'); assert.equal(jobs[0].delivery.to, 'user:365999865'); assert.equal(jobs[0].schedule.staggerMs, 0);
  assert.equal(jobs[0].payload.env.OPENCLAW_STATE_DIR, options.root);
  jobs[0].schedule = {staggerMs: 0, tz: jobs[0].schedule.tz, expr: jobs[0].schedule.expr, kind: 'cron'};
  const count = calls.length;
  assert.equal((await scheduler.sync()).ok, true);
  assert.equal(calls.slice(count).filter(c => ['cron.add', 'cron.update', 'cron.remove'].includes(c.method)).length, 0);
});
test('persisted runner requires an explicit deployed backend root, never a capture fallback', t => {
  const {options} = setup(t);
  assert.throws(() => buildJob('08:00', {...options, repo: undefined}), /backendRoot/);
  assert.throws(() => buildJob('08:00', {...options, repo: '/tmp/missing-plugin-capture'}), /backendRoot/);
  assert.throws(() => buildJob('08:00', {...options, repo: 'chatbot'}), /backendRoot/);
  assert.equal(buildJob('08:00', options).payload.cwd, options.repo);
  assert.equal(buildJob('08:00', options).payload.argv[1], join(options.repo, 'scripts/reminder-list.mjs'));
});
test('changing times removes obsolete declarations; pause removes only owned jobs and resume recreates', async t => {
  const {scheduler, store, jobs, options} = setup(t); await scheduler.sync();
  jobs.push({id: 'unrelated', declarationKey: 'weather', payload: {kind: 'agentTurn'}});
  const p = action => ({raw: '修改提醒列表播报为09:30和20:45', actions: new Set([action]), at: Date.now(), messageId: action, sessionKey: 'owner'});
  manageList(store, {action: 'schedule', times: ['09:30', '20:45']}, p('schedule'));
  assert.equal((await scheduler.sync()).ok, true); assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.filter(j => j.id !== 'unrelated').map(j => j.schedule.expr).sort(), ['30 9 * * *', '45 20 * * *']);
  manageList(store, {action: 'pause'}, p('pause')); await scheduler.sync(); assert.equal(jobs.length, 1);
  manageList(store, {action: 'resume'}, p('resume')); await scheduler.sync(); assert.equal(jobs.length, 3);
  assert.deepEqual(jobs.find(j => j.id !== 'unrelated').delivery, buildJob('09:30', options).delivery);
});
test('RPC failure is pending, does not overwrite settings; retry repairs a partial reconciliation', async t => {
  const {scheduler, failures, store, jobs} = setup(t, new Set(['cron.add']));
  assert.equal((await scheduler.sync()).status, 'pending'); assert.equal(store.settings().enabled, true);
  failures.clear(); assert.equal((await scheduler.sync()).ok, true); assert.equal(jobs.length, 4);
});
test('prefix collision cannot adopt or remove an unowned command/recipient', async t => {
  const {scheduler, jobs, options, calls} = setup(t);
  jobs.push({...buildJob('08:00', options), id: 'wrong', delivery: {mode: 'announce', channel: 'kurumi-qq', to: 'user:99999', accountId: 'default'}});
  assert.equal((await scheduler.sync()).status, 'pending');
  assert.equal(calls.filter(c => c.method !== 'cron.list').length, 0);
});
test('concurrent syncs serialize and do not create duplicate declarations', async t => {
  const {scheduler, jobs} = setup(t);
  await Promise.all([scheduler.sync(), scheduler.sync(), scheduler.sync()]);
  assert.equal(jobs.length, 4); assert.equal(new Set(jobs.map(j => j.declarationKey)).size, 4);
});
