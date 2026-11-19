import {resolve, isAbsolute} from 'node:path';
import {existsSync} from 'node:fs';
import {createManagedCron} from '../../packages/host-scheduling/index.js';
import {createListApplication} from './application.js';

export const DECLARATION_PREFIX = 'kurumi.reminder-list.daily:';
export function buildJob(time, {root, ownerId, repo, storeAdapter = 'sqlite', dataSource = 'sqlite', bridgeBaseUrl, bridgeTokenFile, port = 18890}) {
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
      cwd: repo, env: {OPENCLAW_STATE_DIR: root, KURUMI_LIST_OWNER_ID: ownerId, OPENCLAW_GATEWAY_PORT:String(port),
        ...(storeAdapter !== 'sqlite' ? {KURUMI_LIST_STORE_ADAPTER: storeAdapter} : {}),
        ...(dataSource === 'knowledgemap' ? {KURUMI_LIST_DATA_SOURCE: dataSource, KURUMI_KM_BASE_URL: bridgeBaseUrl, KURUMI_KM_TOKEN_FILE: bridgeTokenFile} : {})},
      timeoutSeconds: 75, noOutputTimeoutSeconds: 70, outputMaxBytes: 524288},
    delivery: {mode: 'announce', channel: 'kurumi-qq', to: `user:${ownerId}`, accountId: 'default'},
    failureAlert: false,
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
    && (job.payload.env?.KURUMI_LIST_STORE_ADAPTER ?? 'sqlite') === (options.storeAdapter ?? 'sqlite')
    && ([options.dataSource ?? 'sqlite', ...(options.dataSource === 'knowledgemap' ? ['sqlite'] : [])].includes(job.payload.env?.KURUMI_LIST_DATA_SOURCE ?? 'sqlite'))
    && (job.payload.env?.KURUMI_LIST_DATA_SOURCE !== 'knowledgemap' ||
      (job.payload.env.KURUMI_KM_BASE_URL === options.bridgeBaseUrl && job.payload.env.KURUMI_KM_TOKEN_FILE === options.bridgeTokenFile))
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
  const openStore = options.openStore ?? createListApplication({storeAdapter: options.storeAdapter}).openStore;
  const cron = createManagedCron({port: options.port ?? 18890, request: options.request});
  let chain = Promise.resolve();
  let task, last = {ok: false, status: 'pending'};
  async function reconcile() {
    const store = openStore(options);
    try {
      store.expire();
      const settings = store.settings(), desired = settings.enabled ? settings.times : [], all = await cron.listJobs();
      const managed = all.filter(j => j.declarationKey?.startsWith(DECLARATION_PREFIX));
      if (managed.some(j => !isOwned(j, options))) throw Error('Reminder-list Cron ownership mismatch');
      for (const job of managed) {
        const time = job.declarationKey.slice(DECLARATION_PREFIX.length);
        store.observeDeliveries({id: job.id, time}, await cron.runs(job.id, 20));
      }
      store.markUnobserved();
      const seen = new Set();
      for (const job of managed) {
        const time = job.declarationKey.slice(DECLARATION_PREFIX.length);
        if (!desired.includes(time) || seen.has(time)) { await cron.remove(job.id); continue; }
        seen.add(time);
        const expected = buildJob(time, options);
        const fields = ['name', 'enabled', 'schedule', 'payload', 'delivery', 'failureAlert', 'sessionTarget', 'wakeMode', 'deleteAfterRun'];
        const patch = Object.fromEntries(fields.filter(k => !equal(job[k], expected[k])).map(k => [k, expected[k]]));
        if (Object.keys(patch).length) await cron.update(job.id, patch);
      }
      for (const time of desired) if (!seen.has(time)) await cron.add(buildJob(time, options));
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
    start(clock) {
      if (task) return;
      task = clock.schedule({id: 'reminder-list-reconcile', delayMs: 1000, everyMs: 30000, async run() {
        const result = await sync();
        if (!result.ok) options.logger?.warn?.('Reminder-list schedule pending; retrying');
      }});
    },
    async stop() { await task?.stop(); task = undefined; await chain; },
  };
}
