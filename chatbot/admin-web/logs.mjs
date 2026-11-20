import {Worker, isMainThread, parentPort, workerData} from 'node:worker_threads';
import {bad, loadModule, Problem} from './common.mjs';
import {runningConfig} from './inventory.mjs';

export const logSources = [
  ['openclaw-runtime', '宿主'], ['openclaw-receipt', '宿主回执'],
  ['cron-runs', 'Cron'], ['channel-delivery', 'QQ 投递'],
  ['access-control', '访问控制'], ['trace-events', '业务链路'],
  ['personal-reminders', '个人提醒'], ['personal-reminder-list', '待办播报'],
  ['kurumi-memory', '记忆'], ['e7', '第七史诗'], ['papers', '论文'],
  ['web-deepseek', 'DeepSeek 检索'], ['knowledgemap', 'KnowledgeMap'], ['proactive', '主动唤醒'],
];
const names = logSources.map(([key]) => key);
const PAGE = 45;
const HOUR = 3600000;
const visible = x => typeof x === 'string' && /^[\w.:-]{1,125}$/u.test(x) ? x : null;
const correlation = ({runId, taskId, cronJobId, toolCallId, qqMessageId} = {}) =>
  Object.fromEntries(Object.entries({runId, taskId, cronJobId, toolCallId, qqMessageId})
    .map(([key, value]) => [key, visible(value)]).filter(([, value]) => value !== null));

function project(event, problem = false) {
  const data = event.data ?? {};
  return {
    at: typeof event.at === 'string' && Number.isFinite(Date.parse(event.at)) ? new Date(event.at).toISOString() : null,
    source: visible(event.source) ?? 'trace-events',
    kind: visible(event.kind ?? event.type) ?? 'event',
    tool: visible(data.tool ?? event.tool),
    code: visible(data.code ?? data.failureCode ?? event.code),
    level: visible(data.level),
    status: visible(data.status ?? data.outcome ?? data.decision) ?? (problem ? 'error' : null),
    duration: Number.isFinite(data.durationMs) && data.durationMs >= 0 ? data.durationMs : null,
    ref: visible(event.eventRef),
    correlation: correlation(event.correlation),
  };
}

async function query({sourceRoot, runtimeRoot, params}) {
  const {collectEvents, filterEvents, renderQuery} = await loadModule(sourceRoot, 'chatbot/packages/log-query/index.js');
  const {eventReference} = await loadModule(sourceRoot, 'chatbot/packages/log-query/log-query-privacy.mjs');
  const [from, to] = [params.to - params.hours * HOUR, params.to];
  const config = runningConfig(runtimeRoot);
  if (!config) throw Error('Runtime not readable');
  const events = collectEvents({from, to, runtimeRoot, sources: params.source ? [params.source] : names});
  const filters = {};
  if (params.runId) filters.runId = params.runId;
  if (params.cronJobId) filters.cronJobId = params.cronJobId;
  const matchMetadata = e => !params.find || [e.source, e.kind, e.tool, e.code, e.status, e.level, e.ref,
    ...Object.values(e.correlation)].some(value => value?.toLowerCase().includes(params.find));
  const view = {from, to, noText: true, raw: true};
  const base = filterEvents(events, filters).filter(event => !params.taskId || event.correlation?.taskId === params.taskId);
  let all;
  if (params.errors) {
    // Use the existing error classification and pairing. Its per-page API
    // returns oldest first; select stable pages from the newest end below.
    const {json: summary} = renderQuery(base, {...view, errors: true, limit: 1});
    const count = summary.total;
    if (!params.find) {
      const upper = Math.max(0, count - params.offset);
      const lower = Math.max(0, upper - PAGE);
      const {json: page} = upper > lower
        ? renderQuery(base, {...view, errors: true, offset: lower, limit: upper - lower}) : {json: {items: []}};
      return {
        ok: true, count, entries: (page.items ?? []).map(row => project(row, true)).reverse(),
        to, next: lower > 0 ? params.offset + PAGE : null, sourceStatus: summarizeSources(events.sourceStatus),
      };
    }
    // Filter error records by accepting only matches from their public metadata.
    // Work in bounded batches and report the window cap explicitly.
    all = [];
    const cap = 1500;
    const start = Math.max(0, count - cap);
    for (let i = start; i < count; i += 500) {
      const {json: page} = renderQuery(base, {...view, errors: true, offset: i, limit: 500});
      all.push(...(page.items ?? []).map(row => project(row, true)).filter(matchMetadata));
    }
    all.reverse();
    return finish(all, params, events.sourceStatus, count > cap);
  }
  // Only serialize the explicitly mapped metadata; the source event may
  // carry text, payloads, filesystem paths and tool parameters.
  all = base.map(row => project({...row, eventRef: eventReference(row)})).filter(matchMetadata).reverse();
  return finish(all, params, events.sourceStatus, false);
}

function summarizeSources(list) {
  const groups = new Map();
  for (const row of list ?? []) {
    if (!names.includes(row.source)) continue;
    const counts = groups.get(row.source) ?? {source: row.source, available: 0, unavailable: 0, partial: 0};
    if (row.status === 'available') counts.available++;
    else if (row.status === 'partial') counts.partial++;
    else counts.unavailable++;
    groups.set(row.source, counts);
  }
  return [...groups.values()];
}

function finish(items, params, status, scanLimited) {
  const entries = items.slice(params.offset, params.offset + PAGE);
  return {ok: true, entries, count: items.length, next: params.offset + PAGE < items.length ? params.offset + PAGE : null,
    to: params.to, sourceStatus: summarizeSources(status), scanLimited};
}

export function parseLogQuery(query, now = Date.now()) {
  const hours = Number(query.get('hours') ?? 2), offset = Number(query.get('offset') ?? 0);
  const to = Number(query.get('to') ?? now);
  const source = query.get('source'), view = query.get('view') ?? 'events';
  const runId = query.get('runId'), cronJobId = query.get('cronJobId'), taskId = query.get('taskId');
  const find = (query.get('q') ?? '').trim().toLowerCase();
  if (![1, 2, 6, 24, 72, 168].includes(hours) || !Number.isInteger(offset) || offset < 0 || offset > 20000 ||
      !Number.isInteger(to) || to > now + 1000 || to < now - 7 * 24 * HOUR ||
      (source && !names.includes(source)) || !['events', 'errors'].includes(view) ||
      [runId, cronJobId, taskId].some(value => value && !visible(value)) || find.length > 125) throw bad('日志筛选条件无效。');
  return {hours, offset, to, source, errors: view === 'errors', runId, cronJobId, taskId, find};
}

let inFlight = 0;
export function queryLogs({sourceRoot, runtimeRoot}, params) {
  if (inFlight >= 2) throw new Problem(429, '已有日志查询正在执行，请稍后重试。');
  inFlight++;
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL(import.meta.url), {
      workerData: {sourceRoot, runtimeRoot, params}, resourceLimits: {maxOldGenerationSizeMb: 180},
    });
    let completed = false;
    const complete = value => {
      if (completed) return;
      completed = true;
      clearTimeout(timer);
      void worker.terminate().catch(() => {});
      inFlight--;
      if (value) resolve(value);
      else reject(new Problem(503, '日志源不可用或查询超时，请缩短时间范围后重试。'));
    };
    const timer = setTimeout(complete, 10000);
    worker.once('message', complete);
    worker.once('error', () => complete());
    worker.once('exit', () => complete());
  });
}

if (!isMainThread) {
  try { parentPort.postMessage(await query(workerData)); }
  catch { parentPort.postMessage(null); }
}
