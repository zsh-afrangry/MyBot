// Exact public read endpoints only. No arbitrary URL, redirect, cookie, write API or automatic retry.
import {fetchWithSsrFGuard} from 'openclaw/plugin-sdk/ssrf-runtime';
import {E7Error, fail, codePattern} from './policy.js';

const API = 'https://admin.e7.wiki/api';
const ASSETS = 'https://assets2.e7.wiki';
export const USER_AGENT = 'kurumi-e7/0.1 (personal read-only wiki client)';
export function endpoint(kind, params = {}) {
  const fixed = {
    cards: '/open/epicseven/hero/card-list', summary: '/open/epicseven/hero_summary/hero-list',
    artifacts: '/open/epicseven/artifact/artifact-list', items: '/open/epicseven/item-dictionary/by-category',
  };
  if (Object.hasOwn(fixed, kind)) return {url: API + fixed[kind], method: 'GET', envelope: kind !== 'summary'};
  if (kind === 'hero') {
    if (!codePattern.test(params.heroCode ?? '')) fail('invalid_query');
    return {url: `${ASSETS}/static/heroes/${params.heroCode}.json`, method: 'GET', envelope: false};
  }
  if (kind === 'effects') return {url: ASSETS + '/static/effects.json', method: 'GET', envelope: false};
  if (kind === 'rankings') return {url: API + '/open/epicseven/tier/list', method: 'POST', envelope: true, body: {}};
  if (kind === 'guides' || kind === 'faq') {
    const page = params.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 1000 || (params.query !== undefined && (typeof params.query !== 'string' || !params.query.trim() || [...params.query].length > 128))) fail('invalid_query');
    return {url: API + '/open/epicseven/' + (kind === 'guides' ? 'guide' : 'faq') + '/page', method: 'POST', envelope: true,
      body: {page, size: 10, ...(params.query ? {keyWord: params.query} : {})}};
  }
  if (kind === 'builds' || kind === 'reviews') {
    if (typeof params.heroCode !== 'string' || !codePattern.test(params.heroCode)) fail('invalid_query');
    return {url: API + '/open/epicseven/' + (kind === 'builds' ? 'hero_equipment_scheme/getSchemeByHeroCode' : 'hero_review/by-hero'),
      method: 'POST', envelope: true, body: kind === 'builds' ? {hero_code: params.heroCode} : {heroCode: params.heroCode}};
  }
  if (kind === 'codes' || kind === 'wikiUpdates') return {
    url: API + (kind === 'codes' ? '/open/epic7/redeem_code/lastest?count=50' : '/open/epicseven/updates/latest?count=50'), method: 'GET', envelope: true,
  };
  if (kind === 'gameNews') {
    const page = params.page ?? 1;
    if (!Number.isInteger(page) || page < 1 || page > 1000 || (params.server !== undefined && ![1, 2].includes(params.server))) fail('invalid_query');
    return {url: API + '/open/epicseven/announcement/page', method: 'POST', envelope: true,
      body: {page, size: 10, order: 'createTime', sort: 'desc', ...(params.server ? {server: params.server} : {})}};
  }
  fail('unknown_resource');
}

export function fetchPolicy(url) {
  const host = new URL(url).hostname;
  if (!['admin.e7.wiki', 'assets2.e7.wiki'].includes(host)) fail('invalid_endpoint');
  // Exact operator-controlled origins, needed for this host's Fake-IP proxy, like the QQ/QWeather clients.
  return {hostnameAllowlist: [host], allowRfc2544BenchmarkRange: true, allowIpv6UniqueLocalRange: true};
}

function limiter(max) {
  let active = 0;
  const queue = [];
  return async (signal, run) => {
    signal?.throwIfAborted();
    if (active < max) active++;
    else await new Promise((resolve, reject) => {
      const entry = {resolve: () => {signal?.removeEventListener('abort', abort); resolve();}};
      const abort = () => {const i = queue.indexOf(entry); if (i >= 0) {queue.splice(i, 1); reject(new E7Error('cancelled'));}};
      queue.push(entry); signal?.addEventListener('abort', abort, {once: true});
    });
    try {signal?.throwIfAborted(); return await run();}
    finally {const next = queue.shift(); if (next) next.resolve(); else active--;}
  };
}
const header = value => typeof value === 'string' && value.length <= 1024 && !/[\r\n]/.test(value) ? value : undefined;
export class E7Client {
  constructor({guardedFetch = fetchWithSsrFGuard, timeoutMs = 15000, maxResponseBytes = 2 * 1024 * 1024, clock = Date.now, observe = () => {}} = {}) {
    this.fetch = guardedFetch; this.timeoutMs = timeoutMs; this.maxBytes = maxResponseBytes;
    this.clock = clock; this.observe = observe; this.slot = limiter(2); this.cooldowns = new Map();
  }
  async read(kind, params = {}, {signal, validators = {}, trace} = {}) {
    const spec = endpoint(kind, params), host = new URL(spec.url).hostname;
    return this.slot(signal, async () => {
      if ((this.cooldowns.get(host)?.until ?? 0) > this.clock()) throw new E7Error('upstream_backoff');
      const timeout = AbortSignal.timeout(this.timeoutMs), combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
      let guard, status = 0, bytes = 0;const started=this.clock();
      try {
        const headers = {Accept: 'application/json', 'User-Agent': USER_AGENT};
        if (header(validators.etag)) headers['If-None-Match'] = validators.etag;
        if (header(validators.lastModified)) headers['If-Modified-Since'] = validators.lastModified;
        if (spec.body) headers['Content-Type'] = 'application/json';
        guard = await this.fetch({url: spec.url, init: {method: spec.method, redirect: 'error', credentials: 'omit', headers,
          ...(spec.body ? {body: JSON.stringify(spec.body)} : {})},
          signal: combined, timeoutMs: this.timeoutMs, requireHttps: true, maxRedirects: 0, mode: 'trusted_env_proxy',
          policy: fetchPolicy(spec.url), capture: false, auditContext: 'kurumi-e7:public-read'});
        const res = guard.response; status = res.status;
        if (guard.finalUrl && guard.finalUrl !== spec.url) fail('redirect_refused');
        const meta = {url: spec.url, status, etag: header(res.headers.get('etag')), lastModified: header(res.headers.get('last-modified'))};
        if (status === 304) {this.cooldowns.delete(host); return meta;}
        if (status !== 200) {
          if (status === 403 || status === 429 || status >= 500) {
            const failures = (this.cooldowns.get(host)?.failures ?? 0) + 1;
            const retry = res.headers.get('retry-after');
            const delay = retry && /^\d+$/.test(retry) ? Number(retry) * 1000 : retry ? Date.parse(retry) - this.clock() : 0;
            this.cooldowns.set(host, {failures, until: this.clock() + Math.min(86400000, Math.max(status === 403 ? 3600000 : 30000, delay || 30000 * 2 ** Math.min(failures - 1, 6)))});
          }
          throw new E7Error(status === 403 ? 'upstream_forbidden' : status === 429 ? 'rate_limited' : status >= 300 && status < 400 ? 'redirect_refused' : status === 404 ? 'not_found' : 'upstream_failed', status);
        }
        if (!/\bapplication\/(?:[\w.-]+\+)?json\b/i.test(res.headers.get('content-type') ?? '')) fail('invalid_response');
        const reader = res.body?.getReader();
        if (!reader) fail('invalid_response');
        const chunks = [];
        try {
          while (true) {
            combined.throwIfAborted();
            const part = await reader.read(); if (part.done) break;
            bytes += part.value.byteLength;
            if (bytes > this.maxBytes) {await reader.cancel(); fail('response_too_large');}
            chunks.push(part.value);
          }
        } finally {reader.releaseLock();}
        let data;
        try {data = JSON.parse(Buffer.concat(chunks).toString('utf8'));} catch {fail('invalid_response');}
        if (spec.envelope) {
          if (!data || data.code !== 1000 || !Object.hasOwn(data, 'data')) fail('invalid_response');
          data = data.data;
        }
        this.cooldowns.delete(host);
        return {...meta, data};
      } catch (error) {
        if (signal?.aborted) throw new E7Error('cancelled');
        if (error instanceof E7Error) throw error;
        if (error?.name === 'GuardedFetchRedirectError') throw new E7Error('redirect_refused');
        const failures = (this.cooldowns.get(host)?.failures ?? 0) + 1;
        this.cooldowns.set(host, {failures, until: this.clock() + 30000 * 2 ** Math.min(failures - 1, 6)});
        throw new E7Error(timeout.aborted ? 'timeout' : 'network_failed');
      } finally {
        try {await guard?.response?.body?.cancel();} catch {}
        await guard?.release();
        try {this.observe({kind, method: spec.method, url: spec.url, status, bytes, durationMs:Math.max(0,this.clock()-started),correlation:trace});} catch {}
      }
    });
  }
}
