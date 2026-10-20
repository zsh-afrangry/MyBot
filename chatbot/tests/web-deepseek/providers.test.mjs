// Offline contract tests for docs/26 DeepSeek Search/Fetch providers: injected fetch only, no real API request.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DeepSeekWebClient, ENDPOINT, WebToolError, loadApiKey, publicUrl} from '../../plugins/kurumi-web-deepseek/client.js';
import {createDeepSeekWebPlugin, markdownText, PROVIDER_ID} from '../../plugins/kurumi-web-deepseek/index.js';

const KEY = 'sk-offline' + 'q'.repeat(32);
const manifest = JSON.parse(fs.readFileSync(new URL('../../plugins/kurumi-web-deepseek/openclaw.plugin.json', import.meta.url)));
const json = (body, status = 200) => new Response(typeof body === 'string' ? body : JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const hit = (n, extra = {}) => ({rerank_score: 2.5, title: 'T' + n, url: 'https://example.org/' + n, snippet: 'S' + n, summary: 'S' + n,
  site_name: 'Example', site_icon: null, date: '2026-10-01T00:00:00Z', authority: 3, ...extra});

function recorder(respond) {
  const calls = [];
  const fetchImpl = async (url, init) => {calls.push({url, init, body: JSON.parse(init.body)}); return respond(calls.length, init);};
  return {calls, fetchImpl};
}
const client = (fetchImpl, options = {}) => new DeepSeekWebClient({apiKey: () => KEY, fetchImpl, ...options});
const rejects = (promise, code) => assert.rejects(promise, error => {
  assert.ok(error instanceof WebToolError, String(error)); assert.equal(error.code, code);
  assert.ok(!error.message.includes(KEY)); return true;
});

test('search maps to the fixed official endpoint with bounded fields and normalized results', async () => {
  const {calls, fetchImpl} = recorder(() => json({results: [hit(1), hit(2, {summary: 'longer', date: null, site_name: null, authority: -1}), {url: 'javascript:alert(1)'}, null]}));
  const result = await client(fetchImpl).search({query: 'openclaw site:github.com', count: 3, originalQuestion: '问'.repeat(200)});
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT + '/v1/tools/search');
  assert.equal(calls[0].init.method, 'POST'); assert.equal(calls[0].init.redirect, 'error');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer ' + KEY);
  assert.deepEqual(calls[0].body, {query: 'openclaw site:github.com', count: 3, need_content: false, ori_question: '问'.repeat(128)});
  assert.equal(result.skipped, 2);
  assert.deepEqual(result.results[1], {title: 'T2', url: 'https://example.org/2', snippet: 'S2', summary: 'longer', siteName: null, published: null, authority: -1, score: 2.5});
});

test('invalid queries, counts and URLs fail before any request', async () => {
  const {calls, fetchImpl} = recorder(() => json({results: []}));
  const c = client(fetchImpl);
  for (const query of ['', '   ', 'x'.repeat(129), 42]) await rejects(c.search({query}), 'invalid_request');
  await rejects(c.search({query: 'ok', count: 51}), 'invalid_request');
  for (const url of ['ftp://example.org/a', 'https://user:pw@example.org/', 'not a url', 'https://example.org/' + 'a'.repeat(8200)]) await rejects(c.fetch({url}), 'invalid_request');
  for (const url of ['http://localhost:8080/', 'http://127.0.0.1/', 'http://10.1.2.3/x', 'http://192.168.1.1/', 'http://[::1]/', 'http://[fd00::1]/', 'http://169.254.169.254/latest', 'http://intranet/', 'http://printer.local/',
  'http://[::ffff:127.0.0.1]/', 'http://[::ffff:a00:1]/', 'http://[64:ff9b::a00:1]/', 'http://2130706433/', 'http://0x7f.1/'])
    await rejects(c.fetch({url}), 'private_target');
  assert.equal(calls.length, 0);
  assert.equal(publicUrl('https://example.org/a?b=1'), 'https://example.org/a?b=1');
});

test('official error statuses map to typed codes without echoing upstream bodies', async () => {
  const cases = {400: 'invalid_request', 401: 'auth_failed', 402: 'insufficient_balance', 403: 'fetch_blocked', 404: 'no_content', 408: 'upstream_timeout',
    429: 'rate_limited', 500: 'upstream_failed', 503: 'upstream_failed', 504: 'upstream_timeout'};
  for (const [status, code] of Object.entries(cases)) {
    const {calls, fetchImpl} = recorder(() => json({error: {message: 'secret upstream detail ' + KEY, type: 'x', code: 'x'}}, Number(status)));
    await assert.rejects(client(fetchImpl).search({query: 'q'}), error => {
      assert.equal(error.code, code); assert.equal(error.status, Number(status));
      assert.ok(!error.message.includes('upstream detail') && !error.message.includes(KEY)); return true;
    });
    assert.equal(calls.length, 1, 'no automatic paid retry for ' + status);
  }
});

test('timeouts, cancellation, stale callers and network failures are distinct', async () => {
  // A real socket keeps the loop alive; AbortSignal.timeout alone is unref'd, so the fake holds a ref'd timer.
  const hang = (url, init) => new Promise((_, reject) => {
    const hold = setTimeout(() => reject(Error('test fetch never aborted')), 5000);
    init.signal.addEventListener('abort', () => {clearTimeout(hold); reject(init.signal.reason);});
  });
  await rejects(client(hang, {timeoutMs: 20}).search({query: 'q'}), 'timeout');
  const controller = new AbortController();
  const pending = client(hang).search({query: 'q'}, {signal: controller.signal});
  setTimeout(() => controller.abort(), 10);
  await rejects(pending, 'cancelled');
  const {calls, fetchImpl} = recorder(() => json({results: []}));
  await rejects(client(fetchImpl).search({query: 'q'}, {signal: AbortSignal.abort()}), 'cancelled');
  await assert.rejects(client(fetchImpl).search({query: 'q'}, {assertCurrent() {throw Error('stale');}}), /stale/);
  assert.equal(calls.length, 0, 'aborted or stale callers never reach the network');
  await rejects(client(async () => {throw new TypeError('ECONNRESET');}).search({query: 'q'}), 'network_failed');
});

test('malformed and oversized responses are rejected', async () => {
  await rejects(client(async () => json('{"results": [')).search({query: 'q'}), 'invalid_response');
  await rejects(client(async () => json({data: []})).search({query: 'q'}), 'invalid_response');
  await rejects(client(async () => json({title: 't'})).fetch({url: 'https://example.org/'}), 'invalid_response');
  let cancelled = false;
  const huge = new ReadableStream({pull(controller) {controller.enqueue(new Uint8Array(1024 * 1024));}, cancel() {cancelled = true;}});
  await rejects(client(async () => new Response(huge, {status: 200})).search({query: 'q'}), 'invalid_response');
  assert.ok(cancelled, 'oversized body stream is cancelled');
  assert.deepEqual(await client(async () => json({results: []})).search({query: 'q'}), {results: [], skipped: 0});
});

test('in-flight requests are bounded and queued callers stay cancellable', async () => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const {calls, fetchImpl} = recorder(async () => {await gate; return json({results: []});});
  const c = client(fetchImpl, {maxConcurrent: 1});
  const first = c.search({query: 'a'});
  const controller = new AbortController();
  const queued = c.search({query: 'b'}, {signal: controller.signal});
  await new Promise(resolve => setTimeout(resolve, 10));
  controller.abort();
  await rejects(queued, 'cancelled');
  release(); await first;
  assert.deepEqual(calls.map(call => call.body.query), ['a']);
  // A released slot goes to the next waiter, never to a caller arriving in between.
  let inFlight = 0, peak = 0;
  const slow = client(async () => {inFlight++; peak = Math.max(peak, inFlight); await new Promise(resolve => setTimeout(resolve, 5)); inFlight--; return json({results: []});}, {maxConcurrent: 2});
  await Promise.all(Array.from({length: 7}, (_, n) => slow.search({query: 'q' + n})));
  assert.equal(peak, 2);
});

test('credentials load only from an owner-only regular JSON file', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-deepseek-'));
  try {
    const file = path.join(dir, 'keys.json');
    fs.writeFileSync(file, JSON.stringify({DEEPSEEK_API_KEY: KEY}), {mode: 0o600});
    assert.equal(loadApiKey(file), KEY);
    const link = path.join(dir, 'link.json'); fs.symlinkSync(file, link);
    fs.writeFileSync(path.join(dir, 'open.json'), JSON.stringify({DEEPSEEK_API_KEY: KEY}), {mode: 0o644});
    fs.chmodSync(path.join(dir, 'open.json'), 0o644);
    fs.writeFileSync(path.join(dir, 'empty.json'), '{}', {mode: 0o600});
    for (const name of ['link.json', 'open.json', 'empty.json', 'missing.json']) assert.throws(() => loadApiKey(path.join(dir, name)), error => {
      assert.equal(error.code, 'credential_unavailable'); assert.ok(!error.message.includes(KEY)); return true;
    });
  } finally {fs.rmSync(dir, {recursive: true, force: true});}
});

function host({fetchImpl, pluginConfig = {}}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'web-deepseek-host-'));
  const credentialsFile = path.join(dir, 'keys.json'), traceFile = path.join(dir, 'trace', 'events.jsonl');
  fs.writeFileSync(credentialsFile, JSON.stringify({DEEPSEEK_API_KEY: KEY}), {mode: 0o600});
  const registered = {};
  const api = {pluginConfig: {credentialsFile, traceFile, ...pluginConfig},
    registerWebSearchProvider: provider => {registered.search = provider;}, registerWebFetchProvider: provider => {registered.fetch = provider;}};
  try {createDeepSeekWebPlugin({clientFactory: options => new DeepSeekWebClient({...options, fetchImpl})}).register(api);}
  catch (error) {fs.rmSync(dir, {recursive: true, force: true}); throw error;}
  const traces = () => fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
  return {registered, traces, traceFile, cleanup: () => fs.rmSync(dir, {recursive: true, force: true})};
}

test('providers register under the manifest contract and are never implicitly selectable', () => {
  const h = host({fetchImpl: async () => json({results: []})});
  try {
    assert.deepEqual(manifest.contracts, {webSearchProviders: [PROVIDER_ID], webFetchProviders: [PROVIDER_ID]});
    assert.deepEqual(manifest.configSchema.required, ['credentialsFile']);
    for (const provider of [h.registered.search, h.registered.fetch]) {
      assert.equal(provider.id, PROVIDER_ID);
      // requiresCredential:false with no env var, configured value or auth-profile id: host auto-detect skips it.
      assert.equal(provider.requiresCredential, false); assert.deepEqual(provider.envVars, []);
      assert.equal(provider.authProviderId, undefined); assert.equal(provider.autoDetectOrder, undefined);
      assert.equal(provider.getConfiguredCredentialValue, undefined); assert.equal(provider.getCredentialValue(), undefined);
      assert.deepEqual(provider.inactiveSecretPaths, []);
    }
  } finally {h.cleanup();}
  for (const pluginConfig of [{credentialsFile: 'relative.json'}, {timeoutSeconds: 0}, {traceFile: 'x.jsonl'}])
    assert.throws(() => host({fetchImpl: async () => json({}), pluginConfig}), error => error.code === 'invalid_config');
});

test('web_search provider wraps external text, rejects unsupported filters, caches only non-empty results and traces without query or key', async () => {
  const {calls, fetchImpl} = recorder(n => json({results: n === 1 ? [hit(1), hit(2)] : []}));
  const h = host({fetchImpl});
  try {
    const tool = h.registered.search.createTool({config: {tools: {web: {search: {cacheTtlMinutes: 5}}}}, searchConfig: {cacheTtlMinutes: 5}});
    assert.equal(tool.parameters.additionalProperties, false);
    await rejects(tool.execute({query: 'q', freshness: 'week'}), 'unsupported_parameter');
    await rejects(tool.execute({query: 'q', count: 11}), 'invalid_request');
    assert.equal(calls.length, 0);
    let current = 0;
    const result = await tool.execute({query: '秘密问题 after:2026-01-01', count: 2}, {assertCurrent() {current++;}});
    assert.ok(current >= 2, 'caller freshness is checked around the request');
    assert.equal(result.provider, PROVIDER_ID); assert.equal(result.count, 2);
    assert.deepEqual(result.externalContent, {untrusted: true, source: 'web_search', provider: PROVIDER_ID, wrapped: true});
    assert.match(result.results[0].title, /EXTERNAL_UNTRUSTED_CONTENT[\s\S]*T1/);
    assert.equal(result.results[0].url, 'https://example.org/1');
    assert.equal(result.results[0].summary, undefined, 'identical summary is not duplicated');
    assert.equal((await tool.execute({query: '秘密问题 after:2026-01-01', count: 2})).cached, true);
    assert.equal(calls.length, 1, 'cache hit sends nothing');
    assert.equal((await tool.execute({query: 'none', count: 2})).count, 0);
    assert.equal((await tool.execute({query: 'none', count: 2})).count, 0);
    assert.equal(calls.length, 3, 'empty results are not cached');
    await rejects(tool.execute({query: 'q'}, {signal: AbortSignal.abort()}), 'cancelled');
    const raw = fs.readFileSync(h.traceFile, 'utf8');
    assert.ok(!raw.includes('秘密问题') && !raw.includes(KEY) && !raw.includes('T1'));
    assert.equal((fs.statSync(h.traceFile).mode & 0o777), 0o600);
    assert.deepEqual(h.traces().map(event => [event.source, event.data.tool, event.data.status, event.data.resultCount, event.data.queryChars]),
      [['web-deepseek', 'web_search', 'ok', 2, 21], ['web-deepseek', 'web_search', 'empty', 0, 4], ['web-deepseek', 'web_search', 'empty', 0, 4]]);
  } finally {h.cleanup();}
});

test('web_search provider surfaces upstream failures with HTTP status for the host diagnostic', async () => {
  const h = host({fetchImpl: async () => json({error: {message: 'quota'}}, 429)});
  try {
    const tool = h.registered.search.createTool({config: {}});
    await assert.rejects(tool.execute({query: 'q'}), error => error.code === 'rate_limited' && error.status === 429);
    assert.deepEqual(h.traces().map(event => [event.data.status, event.data.code, event.data.httpStatus]), [['error', 'rate_limited', 429]]);
  } finally {h.cleanup();}
});

test('web_fetch provider follows the host url/extractMode/maxChars contract and leaves wrapping to the host', async () => {
  const markdown = '# 标题\n\n正文 [链接](https://example.org/x) 和 **重点**。\n\n```js\ncode()\n```';
  const {calls, fetchImpl} = recorder(() => json({title: '页面', content: markdown}));
  const h = host({fetchImpl});
  try {
    const tool = h.registered.fetch.createTool({config: {}, fetchConfig: {}});
    const page = await tool.execute({url: 'https://example.org/page', extractMode: 'markdown', maxChars: 15000});
    assert.deepEqual(calls[0].body, {url: 'https://example.org/page'});
    assert.equal(calls[0].url, ENDPOINT + '/v1/tools/fetch');
    assert.deepEqual({...page, tookMs: undefined}, {title: '页面', text: markdown, finalUrl: 'https://example.org/page', status: 200,
      contentType: 'text/markdown', extractor: 'deepseek', rawLength: markdown.length, tookMs: undefined});
    const text = await tool.execute({url: 'https://example.org/page', extractMode: 'text', maxChars: 15000});
    assert.equal(text.text, '标题\n\n正文 链接 和 重点。\n\ncode()');
    await rejects(tool.execute({url: 'http://127.0.0.1/admin', extractMode: 'markdown', maxChars: 100}), 'private_target');
    assert.equal(calls.length, 2);
    assert.ok(!fs.readFileSync(h.traceFile, 'utf8').includes('example.org/page'), 'trace keeps no URL');
  } finally {h.cleanup();}
  assert.equal(markdownText('![图](a.png)\n> 引用\n- 项'), '图\n引用\n项');
});
