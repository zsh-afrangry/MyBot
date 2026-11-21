// Owner-authorized read-only diagnostics. Contract: docs/18 and docs/24.
import path from 'node:path';
import fs from 'node:fs';
import {QQ_ID} from '../../packages/access-control/index.js';
import {dailyFeedbackQuery} from '../../packages/log-query/daily-feedback-query.js';
export {QQ_SOURCES as SOURCES} from '../../packages/log-query/sources.js';
import {QQ_SOURCES as SOURCES} from '../../packages/log-query/sources.js';
export const RESULT_BYTES = 24 * 1024;
export class LogQueryError extends Error { constructor(code, details) { super(code); this.code = code; if(details !== undefined)this.details=details; } }
export const logQueryRunner = backendRoot => path.join(backendRoot, 'chatbot', 'scripts', 'log-query.mjs');
const fail = code => { throw new LogQueryError(code); };
const object = x => x && typeof x === 'object' && !Array.isArray(x);
const INTERACTION_OPTIONS = ['view','from','to','since','peer','direction','limit','offset','expand','eventRef','contentOffset','contentHash'];
const MESSAGE_OPTIONS = INTERACTION_OPTIONS.filter(key => !['expand','eventRef'].includes(key));
const EVIDENCE_OPTIONS = [...MESSAGE_OPTIONS.filter(key => key !== 'direction'),'messageId','eventRef'];
export function settings(raw) {
  if (!object(raw) || Object.keys(raw).some(k => !['backendRoot','runtimeRoot','snowlumaRoot'].includes(k))
    || ['backendRoot','runtimeRoot','snowlumaRoot'].some(k => typeof raw[k] !== 'string' || !path.isAbsolute(raw[k]))) fail('invalid_config');
  try { if (!fs.statSync(logQueryRunner(raw.backendRoot)).isFile()) fail('invalid_config'); }
  catch { fail('invalid_config'); }
  return Object.freeze({...raw});
}
export function queryOptions(raw = {}, now = Date.now()) {
  if (!object(raw)) fail('invalid_query');
  const view = raw.view ?? 'events';
  if (view === 'daily-feedback') {
    if (Object.keys(raw).some(key => !['view', 'broadcast', 'scheduledAt', 'cronJobId'].includes(key))) fail('invalid_query');
    try { dailyFeedbackQuery(raw); } catch { fail('invalid_query'); }
    return raw;
  }
  const interactions = view === 'interactions';
  const messages = view === 'qq-messages';
  const evidence = view === 'qq-evidence';
  const allowed = interactions ? INTERACTION_OPTIONS : messages ? MESSAGE_OPTIONS : evidence ? EVIDENCE_OPTIONS : ['view','from','to','since','sources','runId','messageId','kind','limit','offset','contains','keywords','keywordMode','levels','noText','expand','raw','contextBefore','contextAfter','contentOffset','contentHash','eventRef','eventKey','cronJobId','code','nodeId','executionId','detail'];
  if (!['events','errors','stats','overview','tree','interactions','qq-messages','qq-evidence'].includes(view) || Object.keys(raw).some(k => !allowed.includes(k)) || (raw.since !== undefined && raw.from !== undefined)) fail('invalid_query');
  if ((interactions || messages || evidence) && (raw.peer !== undefined && (typeof raw.peer !== 'string' || !QQ_ID.test(raw.peer))
    || raw.direction !== undefined && !['inbound','reply'].includes(raw.direction))) fail('invalid_query');
  if (evidence && Number(raw.messageId !== undefined) + Number(raw.eventRef !== undefined) !== 1) fail('invalid_query');
  if (interactions && (raw.expand && !raw.peer || raw.eventRef !== undefined && raw.expand !== true)) fail('invalid_query');
  let duration = 2 * 3600000;
  if (raw.since !== undefined) {
    const m = /^([1-9]\d*)(m|h|d)$/.exec(raw.since);
    if (raw.since !== 'all') {
      if (!m) fail('invalid_query');
      duration = Number(m[1]) * ({m:60000,h:3600000,d:86400000}[m[2]]);
      if (!Number.isSafeInteger(duration)) fail('invalid_query');
    }
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
  const from = raw.from === undefined ? raw.since === 'all' ? 0 : to - duration : instant(raw.from);
  if (!Number.isFinite(new Date(from).getTime()) || from > to || to > now + 60000) fail('invalid_query');
  const sources = evidence ? ['openclaw-session','channel-delivery'] : interactions || messages ? ['openclaw-session'] : raw.sources ?? [...SOURCES];
  if (!Array.isArray(sources) || !sources.length || sources.length > SOURCES.length || new Set(sources).size !== sources.length || sources.some(s => !SOURCES.includes(s))) fail('invalid_query');
  for (const key of ['messageId','kind']) {
    if (raw[key] === undefined) continue;
    const pattern = key === 'messageId' ? /^[+-]?\d{1,20}$/ : /^[a-zA-Z][a-zA-Z0-9_.-]{0,99}\*?$/;
    if (typeof raw[key] !== 'string' || !pattern.test(raw[key])) fail('invalid_query');
  }
  const limit = raw.limit ?? (interactions || messages || evidence ? 10 : 50), offset = raw.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || view === 'stats' && (raw.limit !== undefined || raw.offset !== undefined)) fail('invalid_query');
  const text = value => typeof value === 'string' && value.length > 0 && !value.includes('\0');
  for(const key of ['nodeId','executionId','detail'])if(raw[key]!==undefined&&(!text(raw[key])||raw[key].length>200||view!=='tree'))fail('invalid_query');
  if(raw.detail!==undefined&&(!raw.nodeId||!/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(raw.detail)))fail('invalid_query');
  for(const key of ['code','eventKey','cronJobId'])if(raw[key]!==undefined&&!text(raw[key]))fail('invalid_query');
  if(raw.eventRef!==undefined&&(typeof raw.eventRef!=='string'||!/^event:[a-f0-9]{32}$/u.test(raw.eventRef)))fail('invalid_query');
  if(raw.runId!==undefined&&!text(raw.runId))fail('invalid_query');
  if (raw.contains !== undefined && !text(raw.contains)) fail('invalid_query');
  if (raw.contentHash !== undefined && !text(raw.contentHash)) fail('invalid_query');
  if (raw.keywords !== undefined && (!Array.isArray(raw.keywords) || !raw.keywords.length || raw.keywords.some(x=>!text(x)))) fail('invalid_query');
  if (raw.keywordMode !== undefined && !['any','all'].includes(raw.keywordMode)) fail('invalid_query');
  if (raw.levels !== undefined && (!Array.isArray(raw.levels) || !raw.levels.length || raw.levels.some(x=>!text(x)))) fail('invalid_query');
  for (const key of ['noText','expand','raw']) if (raw[key] !== undefined && typeof raw[key] !== 'boolean') fail('invalid_query');
  for (const key of ['contextBefore','contextAfter','contentOffset']) if (raw[key] !== undefined && (!Number.isSafeInteger(raw[key]) || raw[key] < 0 || key !== 'contentOffset' && raw[key] > 1000)) fail('invalid_query');
  if (['stats','overview'].includes(view) && (raw.contextBefore || raw.contextAfter)) fail('invalid_query');
  return {...raw, view, from:new Date(from).toISOString(), to:new Date(to).toISOString(), sources, limit, offset, noText:raw.noText ?? false, expand:raw.expand ?? false, raw:raw.raw ?? true};
}
