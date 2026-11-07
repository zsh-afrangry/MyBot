// Offline HTTP transport tests: injected guard/local HTTP only, no public API or production state.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import {once} from 'node:events';
import {E7Client, endpoint, fetchPolicy, USER_AGENT} from '../../plugins/kurumi-e7/client.js';

const json = (data, status = 200, headers = {}) => new Response(data == null ? null : JSON.stringify(data), {status, headers: {'content-type': 'application/json', ...headers}});
function setup(respond, options = {}) {
  const calls = []; let releases = 0;
  const client = new E7Client({guardedFetch: async p => {calls.push(p); return {response: await respond(p), finalUrl: p.url, release: async () => {releases++;}};}, ...options});
  return {client, calls, releases: () => releases};
}
const rejects = (promise, code) => assert.rejects(promise, e => e.code === code);

test('only fixed read endpoints, conditional headers and an exact trusted-proxy host are used', async () => {
  const {client, calls, releases} = setup(() => json({code: 1000, data: []}));
  await client.read('cards', {}, {validators: {etag: '"old"', lastModified: 'Wed, 01 Oct 2026 00:00:00 GMT'}});
  await client.read('gameNews', {page: 2, server: 2});
  assert.equal(calls[0].url, 'https://admin.e7.wiki/api/open/epicseven/hero/card-list');
  assert.equal(calls[0].init.headers['If-None-Match'], '"old"');
  assert.equal(calls[0].init.headers['User-Agent'], USER_AGENT);
  assert.equal(calls[0].mode, 'trusted_env_proxy'); assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].maxRedirects, 0);
  assert.deepEqual(calls[0].policy.hostnameAllowlist, ['admin.e7.wiki']);
  assert.deepEqual(JSON.parse(calls[1].init.body), {page: 2, size: 10, order: 'createTime', sort: 'desc', server: 2});
  assert.equal(releases(), 2);
  for (const kind of ['https://evil.invalid/', 'image', 'toString', '__proto__']) await rejects(client.read(kind), 'unknown_resource');
  for (const heroCode of ['../tokens', 'x/../evil', '%2e%2e', 'x?y', 'https://evil.invalid']) assert.throws(() => endpoint('hero', {heroCode}));
  assert.throws(() => fetchPolicy('https://evil.invalid/a'));
  assert.equal(calls.length, 2);
});

test('304 releases the body without trying to parse JSON', async () => {
  const f = setup(() => json(null, 304));
  assert.equal((await f.client.read('cards')).status, 304); assert.equal(f.releases(), 1);
});

test('community endpoints build different fixed read-only POST bodies and refuse path input before IO', async () => {
  const f = setup(() => json({code: 1000, data: []}));
  await f.client.read('builds', {heroCode: 'test-hero-1'});
  await f.client.read('reviews', {heroCode: 'test-hero-1'});
  assert.equal(f.calls[0].url, 'https://admin.e7.wiki/api/open/epicseven/hero_equipment_scheme/getSchemeByHeroCode');
  assert.equal(f.calls[1].url, 'https://admin.e7.wiki/api/open/epicseven/hero_review/by-hero');
  assert.deepEqual(f.calls.map(c => JSON.parse(c.init.body)), [{hero_code: 'test-hero-1'}, {heroCode: 'test-hero-1'}]);
  assert(f.calls.every(c => c.init.method === 'POST' && c.init.credentials === 'omit' && c.maxRedirects === 0));
  for (const heroCode of [undefined, '../secret', 'abc?url=evil', 'https://evil.invalid'])
    for (const kind of ['builds', 'reviews']) await rejects(f.client.read(kind, {heroCode}), 'invalid_query');
  assert.equal(f.calls.length, 2); assert.equal(f.releases(), 2);
});

test('rankings and content use only verified list/page reads with exact keyword casing and bounded pages', async () => {
  const f = setup(() => json({code: 1000, data: []}));
  await f.client.read('rankings'); await f.client.read('guides', {page: 2, query: '测试'}); await f.client.read('faq', {page: 1});
  assert.deepEqual(f.calls.map(c => [new URL(c.url).pathname, JSON.parse(c.init.body)]), [
    ['/api/open/epicseven/tier/list', {}], ['/api/open/epicseven/guide/page', {page: 2, size: 10, keyWord: '测试'}],
    ['/api/open/epicseven/faq/page', {page: 1, size: 10}],
  ]);
  for (const params of [{page: 0}, {page: 1001}, {page: '1'}, {query: ''}, {query: 'x'.repeat(129)}, {query: {url: 'evil'}}])
    await rejects(f.client.read('guides', params), 'invalid_query');
  for (const kind of ['guideDetail', 'increment-read', 'like']) await rejects(f.client.read(kind), 'unknown_resource');
  assert.equal(f.calls.length, 3);
});

test('malformed envelopes, HTML and streamed decoded oversize are rejected without exposing a body', async () => {
  for (const response of [json({code: 1, message: 'PRIVATE-UPSTREAM-ERROR'}), json({not: 'envelope'}), new Response('HTML', {headers: {'content-type': 'text/html'}}), new Response('{', {headers: {'content-type': 'application/json'}})]) {
    const f = setup(() => response); await rejects(f.client.read('cards'), 'invalid_response'); assert.equal(f.releases(), 1);
  }
  let cancelled = false;
  const stream = new ReadableStream({pull(c) {c.enqueue(new Uint8Array(1024));}, cancel() {cancelled = true;}});
  const huge = setup(() => new Response(stream, {headers: {'content-type': 'application/json'}}), {maxResponseBytes: 1500});
  await rejects(huge.client.read('summary'), 'response_too_large'); assert(cancelled); assert.equal(huge.releases(), 1);
});

test('403/429/5xx stop subsequent requests to that host, redirects and unrelated errors do not leak text', async () => {
  for (const [status, code] of [[403, 'upstream_forbidden'], [429, 'rate_limited'], [503, 'upstream_failed']]) {
    let now = 0;
    const f = setup(() => json({private: 'DO-NOT-ECHO'}, status, {'retry-after': '120'}), {clock: () => now});
    await rejects(f.client.read('cards'), code);
    await rejects(f.client.read('artifacts'), 'upstream_backoff'); assert.equal(f.calls.length, 1);
    now = 4000000; await rejects(f.client.read('cards'), code); assert.equal(f.calls.length, 2);
  }
  const redirect = setup(() => json(null, 302, {location: 'https://evil.invalid/'}));
  await rejects(redirect.client.read('cards'), 'redirect_refused'); assert.equal(redirect.calls.length, 1);
});

test('requests and queued callers are cancellable and concurrency never exceeds two', async () => {
  let active = 0, peak = 0;
  const f = setup(async () => {active++; peak = Math.max(peak, active); await new Promise(r => setTimeout(r, 10)); active--; return json([]);});
  await Promise.all(Array.from({length: 8}, () => f.client.read('summary'))); assert.equal(peak, 2);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.client.read('cards', {}, {signal: controller.signal})); assert.equal(f.calls.length, 8);
  const slow = setup(p => new Promise((resolve, reject) => {
    const hold = setTimeout(resolve, 1000); p.signal.addEventListener('abort', () => {clearTimeout(hold); reject(p.signal.reason);});
  }), {timeoutMs: 20});
  await rejects(slow.client.read('cards'), 'timeout');
});

test('actual local HTTP streaming exercises POST, parsing and body limits through an injected test transport', async t => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = ''; req.on('data', b => body += b); req.on('end', () => {
      requests.push({method: req.method, body}); res.writeHead(200, {'content-type': 'application/json'});
      res.end(JSON.stringify({code: 1000, data: {list: [], pagination: {page: 1, size: 10, total: 0}}}));
    });
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => server.close());
  const client = new E7Client({guardedFetch: async p => ({response: await fetch('http://127.0.0.1:' + server.address().port, {...p.init, signal: p.signal}), finalUrl: p.url, release: async () => {}})});
  const result = await client.read('gameNews'); assert.equal(result.data.pagination.total, 0);
  assert.equal(requests[0].method, 'POST'); assert.equal(JSON.parse(requests[0].body).size, 10);
});


test('HTTP telemetry includes the supplied host correlation and measured time for 304 without response content',async()=>{
 const events=[],trace={runId:'host-1',toolCallId:'call-1'};let now=100;
 const f=setup(()=>{now=125;return json(null,304);},{clock:()=>now,observe:e=>events.push(e)});
 await f.client.read('cards',{}, {trace});assert.equal(events[0].correlation,trace);assert.equal(events[0].durationMs,25);assert.equal(events[0].status,304);assert.equal(events[0].bytes,0);
});


test('2C uses only fixed bounded gameplay reads and validated season/hero query values',async()=>{
 const f=setup(()=>json({code:1000,data:[]}));
 for(const [kind,params] of [['gvgHomework',{page:2}],['gvgHot',{}],['fates',{}],['fateHeroes',{seasonId:'season-1'}],['heroFates',{seasonId:'season-1',heroCode:'test-hero-1'}],['packs',{}]])await f.client.read(kind,params);
 assert.deepEqual(JSON.parse(f.calls[0].init.body),{page:2,size:100});assert(f.calls[1].url.endsWith('/hot-defenses?limit=100'));
 assert(f.calls[3].url.endsWith('/recommend-heroes?seasonId=season-1'));assert(f.calls[4].url.endsWith('/recommend-hero-fates?seasonId=season-1&heroCode=test-hero-1'));
 assert(f.calls.slice(1).every(c=>c.init.method==='GET'&&!c.init.body));
 for(const page of [0,31,'1',Infinity])await rejects(f.client.read('gvgHomework',{page}),'invalid_query');
 for(const seasonId of [undefined,'../secret','x&heroCode=other','https://evil.invalid'])await rejects(f.client.read('fateHeroes',{seasonId}),'invalid_query');
 await rejects(f.client.read('heroFates',{seasonId:'season-1',heroCode:'../x'}),'invalid_query');assert.equal(f.calls.length,6);
});
