// Bounded, technical-only diagnostics. Contract: docs/18 and docs/24.
import path from 'node:path';
import fs from 'node:fs';
export const SOURCES = Object.freeze(['openclaw-runtime','openclaw-session','openclaw-receipt','snowluma','cron-runs','channel-delivery','access-control','trace-events','personal-reminders','personal-reminder-list','kurumi-memory','e7','papers','web-deepseek','knowledgemap']);
export const RESULT_BYTES = 24 * 1024;
export class LogQueryError extends Error { constructor(code) { super(code); this.code = code; } }
const fail = code => { throw new LogQueryError(code); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
export function settings(raw) {
  if (!object(raw) || Object.keys(raw).some(k => !['backendRoot','runtimeRoot','snowlumaRoot'].includes(k))
    || ['backendRoot','runtimeRoot','snowlumaRoot'].some(k => typeof raw[k] !== 'string' || !path.isAbsolute(raw[k]))) fail('invalid_config');
  try { if (!fs.statSync(path.join(raw.backendRoot,'scripts/fusion/log-query.mjs')).isFile()) fail('invalid_config'); }
  catch { fail('invalid_config'); }
  return Object.freeze({...raw});
}
export function queryOptions(raw = {}, now = Date.now()) {
  if (!object(raw) || Object.keys(raw).some(k => !['view','from','to','since','sources','runId','messageId','kind','limit','offset'].includes(k))) fail('invalid_query');
  const view = raw.view ?? 'events';
  if (!['events','errors','stats'].includes(view) || (raw.since !== undefined && raw.from !== undefined)) fail('invalid_query');
  let duration = 2 * 3600000;
  if (raw.since !== undefined) {
    const m = /^([1-9]\d{0,3})(m|h|d)$/.exec(raw.since);
    if (!m) fail('invalid_query');
    duration = Number(m[1]) * ({m:60000,h:3600000,d:86400000}[m[2]]);
  }
  const instant = value => {
    if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)?$/.test(value)) fail('invalid_query');
    const parts=value.slice(0,10).split('-').map(Number);
    if (new Date(Date.UTC(parts[0],parts[1]-1,parts[2])).toISOString().slice(0,10) !== value.slice(0,10)) fail('invalid_query');
    const v = value.replace(' ','T'), timestamp = Date.parse(/[Zz]$|[+-]\d\d:\d\d$/.test(v) ? v : v + '+08:00');
    if (!Number.isFinite(timestamp)) fail('invalid_query');
    return timestamp;
  };
  const to = raw.to === undefined ? now : instant(raw.to);
  const from = raw.from === undefined ? to - duration : instant(raw.from);
  if (from > to || to - from > 7 * 86400000 || to > now + 60000 || duration > 7 * 86400000) fail('invalid_query');
  const sources = raw.sources ?? [...SOURCES];
  if (!Array.isArray(sources) || !sources.length || sources.length > SOURCES.length || new Set(sources).size !== sources.length || sources.some(s => !SOURCES.includes(s))) fail('invalid_query');
  for (const key of ['runId','messageId','kind']) {
    if (raw[key] === undefined) continue;
    const pattern = key === 'messageId' ? /^[+-]?\d{1,20}$/ : key === 'kind' ? /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}\*?$/ : /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
    if (typeof raw[key] !== 'string' || !pattern.test(raw[key])) fail('invalid_query');
  }
  const limit = raw.limit ?? 50, offset = raw.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000 || view === 'stats' && (raw.limit !== undefined || raw.offset !== undefined)) fail('invalid_query');
  return {...raw, view, from:new Date(from).toISOString(), to:new Date(to).toISOString(), sources, limit, offset};
}
