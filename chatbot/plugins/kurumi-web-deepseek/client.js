// Fixed-endpoint DeepSeek Search/Fetch client. Design: docs/26; official contract: api-docs.deepseek.com/guides/search.
import fs from 'node:fs';
import {isIP, BlockList} from 'node:net';

export const ENDPOINT = 'https://api.deepseek.com';
const PATHS = {search: '/v1/tools/search', fetch: '/v1/tools/fetch'};
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

export class WebToolError extends Error {
  constructor(code, message, status = 0) {super(message); this.code = code; this.status = status;}
}

// Official status table; anything else is upstream_failed. Messages never echo upstream bodies.
const STATUS = {
  400: ['invalid_request', 'DeepSeek 拒绝了请求参数'],
  401: ['auth_failed', 'DeepSeek 凭据无效或缺失'],
  402: ['insufficient_balance', 'DeepSeek 账户余额不足'],
  403: ['fetch_blocked', 'DeepSeek 安全策略拒绝抓取该网址'],
  404: ['no_content', '该网址没有可用正文（失效、站点限制或类型不支持）'],
  408: ['upstream_timeout', 'DeepSeek 读取请求超时'],
  413: ['invalid_request', '请求体过大'],
  429: ['rate_limited', 'DeepSeek 限流，请稍后再试'],
  504: ['upstream_timeout', 'DeepSeek 下游超时'],
};

export function loadApiKey(file) {
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077)) throw Error();
    const key = JSON.parse(fs.readFileSync(file, 'utf8'))?.DEEPSEEK_API_KEY;
    if (typeof key !== 'string' || !/^[\x21-\x7e]{16,256}$/.test(key.trim())) throw Error();
    return key.trim();
  } catch {throw new WebToolError('credential_unavailable', 'DeepSeek 检索凭据不可用');}
}

const privateRanges = new BlockList();
for (const [net, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 3]]) privateRanges.addSubnet(net, bits, 'ipv4');
// IPv4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96) literals could otherwise smuggle a private IPv4 target.
for (const [net, bits] of [['::', 127], ['::ffff:0:0', 96], ['64:ff9b::', 96], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) privateRanges.addSubnet(net, bits, 'ipv6');

// The host already applies its own SSRF guard before a provider runs; this keeps local URLs from leaving the machine anyway.
export function publicUrl(value) {
  if (typeof value !== 'string' || !value || value.length > 8192) throw new WebToolError('invalid_request', '网址须为 1 到 8192 个字符');
  let url;
  try {url = new URL(value);} catch {throw new WebToolError('invalid_request', '网址格式无效');}
  if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) throw new WebToolError('invalid_request', '只支持带主机名的 HTTP/HTTPS 网址');
  if (url.username || url.password) throw new WebToolError('invalid_request', '网址不能包含用户名或密码');
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const family = isIP(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || (!family && !host.includes('.'))
    || (family && privateRanges.check(host, family === 6 ? 'ipv6' : 'ipv4')))
    throw new WebToolError('private_target', '本机或内网地址不交给第三方抓取');
  return url.href;
}

export function throwIfCancelled(signal) {
  if (signal?.aborted) throw new WebToolError('cancelled', '请求已取消');
}

export function searchQuery(value) {
  const query = typeof value === 'string' ? value : '';
  const length = [...query].length;
  if (!query.trim() || length > 128) throw new WebToolError('invalid_request', '搜索词须为 1 到 128 个字符且不能全为空白');
  return query;
}

// Bounded in-flight requests; a released slot is handed straight to the next waiter, queued callers stay cancellable.
function limiter(max) {
  let active = 0; const waiting = [];
  return async (signal, run) => {
    if (active < max) active++;
    else await new Promise((resolve, reject) => {
      const entry = {resolve, reject};
      waiting.push(entry);
      signal?.addEventListener('abort', () => {
        const at = waiting.indexOf(entry);
        if (at >= 0) {waiting.splice(at, 1); reject(new WebToolError('cancelled', '请求已取消'));}
      }, {once: true});
    });
    try {return await run();} finally {const next = waiting.shift(); if (next) next.resolve(); else active--;}
  };
}

export class DeepSeekWebClient {
  constructor({apiKey, timeoutMs = 20000, maxConcurrent = 4, fetchImpl = fetch} = {}) {
    if (typeof apiKey !== 'function') throw new WebToolError('invalid_config', '需要凭据读取函数');
    this.apiKey = apiKey; this.timeoutMs = timeoutMs; this.fetchImpl = fetchImpl; this.slot = limiter(maxConcurrent);
  }
  async post(kind, body, {signal, assertCurrent} = {}) {
    throwIfCancelled(signal);
    return this.slot(signal, async () => {
      throwIfCancelled(signal);
      const key = this.apiKey();
      assertCurrent?.();
      const timeout = AbortSignal.timeout(this.timeoutMs);
      let response;
      try {
        response = await this.fetchImpl(ENDPOINT + PATHS[kind], {method: 'POST', redirect: 'error',
          headers: {Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Accept: 'application/json'},
          body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, timeout]) : timeout});
      } catch (error) {
        if (signal?.aborted) throw new WebToolError('cancelled', '请求已取消');
        if (timeout.aborted) throw new WebToolError('timeout', 'DeepSeek 请求超时');
        throw new WebToolError('network_failed', 'DeepSeek 网络请求失败');
      }
      if (!response.ok) {
        try {await response.body?.cancel();} catch { /* Body is irrelevant on failure. */ }
        const [code, message] = STATUS[response.status] ?? ['upstream_failed', 'DeepSeek 服务暂时失败'];
        throw new WebToolError(code, message, response.status);
      }
      const reader = response.body?.getReader();
      if (!reader) throw new WebToolError('invalid_response', 'DeepSeek 返回空响应', response.status);
      let size = 0; const parts = [];
      try {
        while (true) {
          const part = await reader.read(); if (part.done) break;
          size += part.value.length;
          if (size > MAX_RESPONSE_BYTES) {await reader.cancel(); throw new WebToolError('invalid_response', 'DeepSeek 响应超限', response.status);}
          parts.push(part.value);
        }
      } catch (error) {
        if (error instanceof WebToolError) throw error;
        if (signal?.aborted) throw new WebToolError('cancelled', '请求已取消');
        throw new WebToolError(timeout.aborted ? 'timeout' : 'network_failed', 'DeepSeek 响应读取失败');
      } finally {reader.releaseLock();}
      try {return JSON.parse(Buffer.concat(parts).toString('utf8'));}
      catch {throw new WebToolError('invalid_response', 'DeepSeek 返回无效 JSON', response.status);}
    });
  }
  async search({query, count = 5, originalQuestion, needContent = false}, options) {
    const body = {query: searchQuery(query), count, need_content: needContent === true};
    if (!Number.isInteger(count) || count < 1 || count > 50) throw new WebToolError('invalid_request', 'count 须为 1 到 50 的整数');
    // ori_question is only a hint for query understanding; an over-long one is shortened, never the query itself.
    if (typeof originalQuestion === 'string' && originalQuestion.trim()) body.ori_question = [...originalQuestion.trim()].slice(0, 128).join('');
    const raw = await this.post('search', body, options);
    if (!raw || !Array.isArray(raw.results)) throw new WebToolError('invalid_response', 'DeepSeek 搜索结果格式无效');
    const text = value => typeof value === 'string' ? value : '';
    const results = [];
    let skipped = 0;
    for (const item of raw.results) {
      if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url)) {skipped++; continue;}
      results.push({title: text(item.title), url: item.url, snippet: text(item.snippet), summary: text(item.summary),
        ...(text(item.content) ? {content: item.content} : {}),
        siteName: typeof item.site_name === 'string' ? item.site_name : null,
        published: typeof item.date === 'string' ? item.date : null,
        authority: Number.isInteger(item.authority) ? item.authority : -1,
        score: typeof item.rerank_score === 'number' ? item.rerank_score : null});
    }
    return {results, skipped};
  }
  async fetch({url}, options) {
    const raw = await this.post('fetch', {url: publicUrl(url)}, options);
    if (!raw || typeof raw.content !== 'string') throw new WebToolError('invalid_response', 'DeepSeek 抓取结果格式无效');
    return {title: typeof raw.title === 'string' ? raw.title : '', content: raw.content};
  }
}
