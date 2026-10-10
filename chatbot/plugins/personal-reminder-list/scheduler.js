import {resolve, isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {ListStore} from './store.js';

export const DECLARATION_PREFIX = 'kurumi.reminder-list.daily:';
export function buildJob(time, {root, ownerId, repo}) {
  // OpenClaw can import this module from a disposable plugin capture. Never
  // derive a persisted Cron executable from import.meta.url: deployment config
  // owns the backend root and the executable suffix is fixed by this domain.
  if (typeof repo !== 'string' || !isAbsolute(repo) || !existsSync(resolve(repo, 'scripts/reminder-list.mjs'))) throw Error('Reminder-list backendRoot must contain the deployed fixed runner');
  const [hour, minute] = time.split(':').map(Number);
  return {
    name: `kurumi.reminder-list.${time}`, declarationKey: DECLARATION_PREFIX + time,
    enabled: true, schedule: {kind: 'cron', expr: `${minute} ${hour} * * *`, tz: 'Asia/Shanghai', staggerMs: 0},
    sessionTarget: 'isolated', wakeMode: 'now',
    payload: {kind: 'command', argv: [process.execPath, resolve(repo, 'scripts/reminder-list.mjs'), 'run', '--slot', time],
      cwd: repo, env: {OPENCLAW_STATE_DIR: root, KURUMI_LIST_OWNER_ID: ownerId},
      timeoutSeconds: 20, noOutputTimeoutSeconds: 10, outputMaxBytes: 524288},
    delivery: {mode: 'announce', channel: 'kurumi-qq', to: `user:${ownerId}`, accountId: 'default'},
    deleteAfterRun: false,
  };
}
function isOwned(job, options) {
  const time = job.declarationKey?.slice(DECLARATION_PREFIX.length);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time ?? '')) return false;
  const expected = buildJob(time, options);
  return job.declarationKey.startsWith(DECLARATION_PREFIX) && job.payload?.kind === 'command'
    && JSON.stringify(job.payload.argv) === JSON.stringify(expected.payload.argv)
    && job.payload.cwd === expected.payload.cwd
    && job.payload.env?.OPENCLAW_STATE_DIR === options.root && job.payload.env?.KURUMI_LIST_OWNER_ID === options.ownerId
    && job.delivery?.channel === 'kurumi-qq' && job.delivery?.to === `user:${options.ownerId}`
    && job.delivery?.accountId === 'default';
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(k => [k, canonical(value[k])]));
  return value;
}
const equal = (a, b) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
export function createScheduler(options) {
  buildJob('00:00', options); // Fail registration instead of persisting a missing runner.
  const request = options.request ?? ((method, params) => {
    if (!process.env.OPENCLAW_GATEWAY_TOKEN) throw Error('Native scheduler credentials unavailable');
    return callGatewayFromCli(method, {url: `ws://127.0.0.1:${options.port}`, token: process.env.OPENCLAW_GATEWAY_TOKEN, timeout: '15000', json: true}, params);
  });
  let chain = Promise.resolve();
  let timer, stopped = true, last = {ok: false, status: 'pending'};
  async function reconcile() {
    const store = new ListStore(options);
    try {
      store.expire();
      const settings = store.settings(), desired = settings.enabled ? settings.times : [], all = [];
      let offset = 0;
      for (let page = 0; page < 100; page++) {
        const response = await request('cron.list', {includeDisabled: true, offset, limit: 100});
        if (!Array.isArray(response?.jobs)) throw Error('Invalid Cron snapshot');
        all.push(...response.jobs);
        if (!response.hasMore) break;
        if (!Number.isInteger(response.nextOffset) || response.nextOffset <= offset || page === 99) throw Error('Invalid Cron pagination');
        offset = response.nextOffset;
      }
      const managed = all.filter(j => j.declarationKey?.startsWith(DECLARATION_PREFIX));
      if (managed.some(j => !isOwned(j, options))) throw Error('Reminder-list Cron ownership mismatch');
      for (const job of managed) {
        const time = job.declarationKey.slice(DECLARATION_PREFIX.length);
        const runs = await request('cron.runs', {id: job.id, limit: 20});
        if (!Array.isArray(runs?.entries)) throw Error('Invalid Cron observations');
        store.observeDeliveries({id: job.id, time}, runs.entries);
      }
      store.markUnobserved();
      const seen = new Set();
      for (const job of managed) {
        const time = job.declarationKey.slice(DECLARATION_PREFIX.length);
        if (!desired.includes(time) || seen.has(time)) { await request('cron.remove', {id: job.id}); continue; }
        seen.add(time);
        const expected = buildJob(time, options);
        const fields = ['name', 'enabled', 'schedule', 'payload', 'delivery', 'sessionTarget', 'wakeMode', 'deleteAfterRun'];
        const patch = Object.fromEntries(fields.filter(k => !equal(job[k], expected[k])).map(k => [k, expected[k]]));
        if (Object.keys(patch).length) await request('cron.update', {id: job.id, patch});
      }
      for (const time of desired) if (!seen.has(time)) {
        const added = await request('cron.add', buildJob(time, options));
        if (!(added?.id ?? added?.jobId ?? added?.job?.id)) throw Error('Missing managed Cron identity');
      }
      // The runner always reads current settings; an in-flight old snapshot cannot
      // send at a disabled time. The next pass repairs any concurrent setting edit.
      const current = store.settings();
      last = {ok: current.version === settings.version, status: current.version === settings.version ? 'synced' : 'pending', settingsVersion: settings.version, times: desired};
      return last;
    } finally { store.close(); }
  }
  const sync = () => {
    const result = chain.then(reconcile).catch(() => {
      last = {ok: false, status: 'pending', error: '原生调度尚未对齐，会自动重试；当前设置已经保存'};
      return last;
    });
    chain = result;
    return result;
  };
  return {
    sync, status: () => last,
    start() {
      stopped = false;
      const tick = async () => {
        if (stopped) return;
        const result = await sync();
        if (!result.ok) options.logger?.warn?.('Reminder-list schedule pending; retrying');
        if (!stopped) { timer = setTimeout(tick, 30000); timer.unref?.(); }
      };
      timer = setTimeout(tick, 1000); timer.unref?.();
    },
    async stop() { stopped = true; clearTimeout(timer); await chain; },
  };
}
