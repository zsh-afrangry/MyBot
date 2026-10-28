// E7 defaults and fixed vocabulary. Contract: docs/27; no runtime identity or chat parsing here.
import path from 'node:path';
import OpenCC from 'opencc-js';

export const ACTIONS = Object.freeze(['search', 'hero', 'artifact', 'dictionary', 'codes', 'news', 'builds', 'reviews']);
export const HERO_VIEWS = Object.freeze(['skills', 'stats', 'multipliers', 'devotion', 'exclusive', 'profile', 'overview']);
export const CATALOGS = Object.freeze(['cards', 'summary', 'artifacts', 'effects', 'items']);
export const RESULT_BYTES = 16 * 1024;
export class E7Error extends Error {
  constructor(code, status = 0) { super(code); this.code = code; this.status = status; }
}
export const fail = code => { throw new E7Error(code); };
export const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const codePattern = /^[a-z0-9][a-z0-9-]{0,79}$/;
const simplify = OpenCC.Converter({from: 'tw', to: 'cn'});
export const normalize = value => simplify(String(value ?? '').normalize('NFKC')).toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');

export function settings(raw = {}) {
  if (!object(raw) || Object.keys(raw).some(k => !['cacheRoot', 'refreshTime', 'detailTtlHours', 'liveTtlMinutes', 'timeoutMs', 'maxResponseBytes', 'refreshEnabled'].includes(k))) fail('invalid_config');
  const c = {refreshTime: '05:30', detailTtlHours: 24, liveTtlMinutes: 30, timeoutMs: 15000, maxResponseBytes: 2 * 1024 * 1024, refreshEnabled: true, ...raw};
  if (typeof c.cacheRoot !== 'string' || !path.isAbsolute(c.cacheRoot) || !/^([01]\d|2[0-3]):[0-5]\d$/.test(c.refreshTime) || typeof c.refreshEnabled !== 'boolean') fail('invalid_config');
  for (const [key, min, max] of [['detailTtlHours', 1, 168], ['liveTtlMinutes', 1, 60], ['timeoutMs', 100, 30000], ['maxResponseBytes', 1024, 4 * 1024 * 1024]])
    if (!Number.isInteger(c[key]) || c[key] < min || c[key] > max) fail('invalid_config');
  return c;
}

export function nextRefresh(now, time) {
  const date = new Date(now), [h, m] = time.split(':').map(Number);
  date.setHours(h, m, 0, 0);
  if (date.getTime() <= now) date.setDate(date.getDate() + 1);
  return date.getTime();
}

export const ttlFor = (kind, config) => ['codes', 'gameNews', 'wikiUpdates'].includes(kind)
  ? config.liveTtlMinutes * 60000 : config.detailTtlHours * 3600000;
