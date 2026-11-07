// Offline query/cache tests: synthetic wiki data and temporary directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup} from './fixtures.mjs';
import {E7Error, RESULT_BYTES} from '../../plugins/kurumi-e7/policy.js';
import {E7Store} from '../../plugins/kurumi-e7/store.js';
import {E7Service} from '../../plugins/kurumi-e7/service.js';

test('name normalization, alias ambiguity, typed filtering and cursor binding use the complete local index', async t => {
  const {service, calls} = setup(t);
  const search = a => service.query({action: 'search', kind: 'hero', ...a});
  assert.equal((await search({query: ' 測 試 甲 '})).data.items[0].heroCode, 'test-hero-1');
  assert.equal((await search({query: 'ＴＥＳＴ－ＨＥＲＯ－１'})).data.items[0].name, '测试甲');
  const aliases = await search({query: '公共别名'}); assert.equal(aliases.data.needsSelection, true); assert.equal(aliases.data.total, 2);
  const first = await search({filters: {attribute: 'fire'}, limit: 5}); assert.equal(first.data.total, 12);
  const second = await search({filters: {attribute: 'fire'}, limit: 3, cursor: first.data.nextCursor}); assert.equal(second.data.items[0].heroCode, 'test-hero-6');
  await assert.rejects(search({query: '测试', cursor: first.data.nextCursor}), e => e.code === 'cursor_expired');
  const effects = await search({filters: {effectIds: ['101']}}); assert.equal(effects.data.total, 1);
  assert.equal(calls.filter(c => c.kind === 'cards').length, 1);
  await assert.rejects(search({filters: {effectIds: ['missing']}}), e => e.code === 'unknown_effect');
});

test('seven hero views share one detail and preserve numeric basis, skill conditions and missing values', async t => {
  const {service, calls} = setup(t);
  const query = (view, extra) => service.query({action: 'hero', heroCode: 'test-hero-1', view, ...extra});
  const skills = await query('skills'); assert.equal(skills.data.skills[0].description, '第一段相连\n第二段');
  assert.equal(skills.data.skills[0].soulBurn.cost, 20); assert(!('enhancements' in skills.data.skills[0]));
  assert.equal((await query('skills', {skill: 1})).data.skills[0].enhancements.length, 1);
  const stats = await query('stats'); assert.equal(stats.data.stats.spd, 120); assert.equal(stats.data.percentages.chd, 165);
  assert.equal(stats.data.statBasis.equipmentIncluded, false); assert.equal(stats.data.statBasis.level, null); assert.equal(stats.data.passiveStats.cri, '0.3');
  assert.equal((await query('multipliers', {skill: 2})).data.skills[0].groups[1].items[0].value, '1.7');
  assert.equal((await query('devotion')).data.self.grades.sss, 0.21);
  const exclusive = await query('exclusive'); assert.equal(exclusive.data.exclusiveEquipment, null); assert.deepEqual(exclusive.missingFields, ['exclusiveEquipment']);
  assert.equal((await query('profile')).data.audioAvailable, false); assert.equal((await query('overview')).data.availableViews.length, 7);
  assert.equal(calls.filter(c => c.kind === 'hero').length, 1); assert(!JSON.stringify(skills.data).includes('/static/'));
});

test('artifacts use filled effect text, dictionaries remain separate and codes/news retain source limitations', async t => {
  const {service} = setup(t);
  const art = await service.query({action: 'artifact', artifactId: '5'});
  assert.equal(art.data.effect, '攻击提升10(20)%。\n第二行'); assert(!JSON.stringify(art).includes('{per('));
  assert.equal(art.data.effectBasis.level, null); assert.equal(art.data.effectBasis.limitBreak, null);
  assert.equal((await service.query({action: 'dictionary', kind: 'effect', entryId: '101'})).data.items[0].description, '攻击增加');
  const item = await service.query({action: 'dictionary', kind: 'item', query: '測試金幣'}); assert.equal(item.data.items[0].defaultPrice, '1.0000');
  const codes = await service.query({action: 'codes', server: '国际服'}); assert.equal(codes.data.timezone, null); assert.equal(codes.data.redemptionVerified, false);
  assert.equal((await service.query({action: 'codes', server: '国服'})).data.items.length, 0);
  const wiki = await service.query({action: 'news', kind: 'wiki_update'}); assert.match(wiki.data.coverage, /网站更新/);
  const news = await service.query({action: 'news', kind: 'game', limit: 3}); assert.equal(news.data.items[0].bodyExtracted, false);
  assert.equal(news.data.items[0].url, 'https://assets2.e7.wiki/announcement/event/test-0.pdf');
  const next = await service.query({action: 'news', kind: 'game', limit: 10, cursor: news.data.nextCursor}); assert.equal(next.data.items.length, 7);
  const page2 = await service.query({action: 'news', kind: 'game', cursor: next.data.nextCursor}); assert.equal(page2.data.items.length, 2); assert.equal(page2.data.nextCursor, null);
});

test('unsupported actions, mixed parameters and URL/path inputs fail before any cache/network activity', async t => {
  const {service, calls, root} = setup(t);
  for (const args of [{action: 'image'}, {action: 'builds'}, {action: 'hero', heroCode: '../token'}, {action: 'hero', heroCode: 'test-hero-1', view: 'stats', skill: 1},
    {action: 'search', kind: 'hero', query: 'x', url: 'https://evil.invalid'}, {action: 'news', kind: 'site_notice'}, {action: 'news', kind: 'wiki_update', server: '国服'},
    {action: 'dictionary', kind: 'effect', query: 'a', entryId: '101'}, {action: 'search', kind: 'artifact', filters: {attribute: 'fire'}}]) await assert.rejects(service.query(args));
  assert.equal(calls.length, 0); assert.equal(fs.readdirSync(root).length, 0);
});

test('conditional 304, content hash and count shrink protect the last validated cache across service instances', async t => {
  let mode = 'normal';
  const {service, calls, now, root} = setup(t, {read: async (kind, params, opts, data) => mode === '304' ? {status: 304}
    : mode === 'error' ? Promise.reject(new E7Error('network_failed')) : {status: 200, data: mode === 'shrink' ? data[kind].slice(0, 8) : data[kind], etag: '"v1"'}});
  const args = {action: 'search', kind: 'hero', query: '测试'};
  await service.query(args); const files = fs.readdirSync(root); assert.equal(files.length, 1);
  assert.equal(fs.statSync(path.join(root, files[0])).mode & 0o777, 0o600);
  now.value += 25 * 3600000; mode = '304';
  const before = new E7Store(root).read(JSON.stringify(['cards', {}]));
  const second = await service.query(args); assert.equal(second.stale, false); assert.equal(calls.at(-1).opts.validators.etag, '"v1"');
  const checked = new E7Store(root).read(JSON.stringify(['cards', {}])); assert.equal(checked.fetchedAt, before.fetchedAt); assert(checked.checkedAt > before.checkedAt); assert.equal(checked.hash, before.hash);
  now.value += 25 * 3600000; mode = 'normal'; await service.query(args);
  assert.equal(new E7Store(root).read(JSON.stringify(['cards', {}])).fetchedAt, before.fetchedAt, 'identical 200 keeps original fetchedAt');
  now.value += 25 * 3600000; mode = 'shrink';
  const stale = await service.query(args); assert.equal(stale.stale, true); assert.equal(stale.data.total, 12); assert.equal(stale.sources[0].warning, 'catalog_shrank');
  mode = 'error'; assert.equal((await service.query(args)).stale, true);
  assert.equal(new E7Store(root).read(JSON.stringify(['cards', {}])).hash, before.hash);
});

test('no cache plus failure returns an error, invalid JSON cache is not trusted, and symlinks are refused', async t => {
  const {service, root} = setup(t, {read: async () => {throw new E7Error('network_failed');}});
  await assert.rejects(service.query({action: 'search', kind: 'hero', query: 'x'}), e => e.code === 'network_failed');
  const store = new E7Store(root), key = 'test'; fs.writeFileSync(store.file(key), '{'); assert.equal(store.read(key), null);
  const destination = path.join(root, 'target'); fs.writeFileSync(destination, 'secret'); fs.unlinkSync(store.file(key)); fs.symlinkSync(destination, store.file(key));
  assert.throws(() => store.read(key), e => e.code === 'cache_read_failed'); assert.equal(fs.readFileSync(destination, 'utf8'), 'secret');
});

test('shared reads coalesce, one cancelled waiter does not cancel others, stop aborts and waits for outstanding reads', async t => {
  let release;
  const gate = new Promise(resolve => {release = resolve;});
  const {service, calls} = setup(t, {read: async (kind, params, opts, data) => {
    await Promise.race([gate, new Promise((resolve, reject) => opts.signal.addEventListener('abort', () => reject(new E7Error('cancelled')), {once: true}))]);
    return {status: 200, data: data[kind]};
  }});
  const args = {action: 'search', kind: 'hero', query: '测试'}, controller = new AbortController();
  const cancelled = service.query(args, {signal: controller.signal}), other = service.query(args);
  controller.abort(); await assert.rejects(cancelled); release(); await other; assert.equal(calls.length, 1);
  // Force an in-flight refresh rather than reuse the fresh response.
  const pending = service.resource('artifacts'); const stopped = service.stop();
  await assert.rejects(pending, e => e.code === 'cancelled'); await stopped; assert.equal(service.flights.size, 0);
});

test('long external prose is bounded while JSON structure, IDs, source dates and truncation remain usable', async t => {
  const {service} = setup(t, {read: async (kind, params, opts, data) => ({status: 200, data: kind === 'hero' ? {...data.hero, story: '长篇\n'.repeat(15000)} : data[kind]})});
  const result = await service.query({action: 'hero', heroCode: 'test-hero-1', view: 'profile'});
  assert.equal(result.truncated, true); assert.equal(result.data.heroCode, 'test-hero-1'); assert(Buffer.byteLength(JSON.stringify(result)) < RESULT_BYTES);
  assert.equal(result.sources.length, 2); assert.equal(result.sources[1].upstreamUpdatedAt, null);
});

test('equipped builds preserve percentage points, nulls and sources; filters and cursors bind to the snapshot', async t => {
  const {service, calls, now, data} = setup(t);
  const query = extra => service.query({action: 'builds', heroCode: 'test-hero-1', ...extra});
  const first = await query({limit: 3});
  const sample = first.data.items[0];
  assert.equal(sample.stats.chd, 289); assert.equal(sample.stats.eff, null);
  assert.equal(sample.statBasis.equipmentIncluded, true); assert.equal(sample.statBasis.percentUnit, 'percentage_points');
  assert.equal(sample.statBasis.level, null); assert.equal(sample.author, '合成作者'); assert.equal(sample.updatedAt, '2026-10-28 01:00:00');
  assert.equal(first.data.total, 12); assert(first.missingFields.includes('items.stats'));
  assert(first.sources.some(s => s.url.endsWith('/getSchemeByHeroCode'))); assert(!JSON.stringify(first).includes('artifact_icon'));
  const next = await query({cursor: first.data.nextCursor, limit: 10}); assert.equal(next.data.items[0].id, '4');
  const matched = await query({filters: {sets: ['開戰', '穿透'], minStats: {spd: 220, chd: 250, eff: 0}}});
  assert.equal(matched.data.total, 6); assert(matched.data.items.every(r => r.stats.spd >= 220));
  const reordered = await service.query({heroCode: 'test-hero-1', cursor: matched.data.nextCursor,
    filters: {minStats: {eff: 0, chd: 250, spd: 220}, sets: ['開戰', '穿透']}, action: 'builds'});
  assert.equal(reordered.data.items.length, 1); assert(!reordered.missingFields.includes('items.stats'));
  await assert.rejects(query({filters: {sets: ['速度']}, cursor: first.data.nextCursor}), e => e.code === 'cursor_expired');
  assert.equal(calls.filter(c => c.kind === 'builds').length, 1);
  now.value += 25 * 3600000; data.builds[0].speed = '219';
  await assert.rejects(query({cursor: first.data.nextCursor}), e => e.code === 'cursor_expired');
});

test('reviews keep category, attribution and cleaned prose; no reviews is a successful empty result', async t => {
  const {service, data, now, calls} = setup(t);
  const query = extra => service.query({action: 'reviews', heroCode: 'test-hero-1', ...extra});
  const all = await query({limit: 2}); assert.equal(all.data.total, 4); assert.deepEqual(all.data.availableCategories, ['RTA', 'PVP', 'PVE', '综合']);
  assert.equal(all.data.items[0].content, '合成测评正文'); assert.equal(all.data.items[0].author, '合成作者');
  const pve = await query({category: 'PVE'}); assert.equal(pve.data.items[0].category, 'PVE'); assert.equal(pve.data.total, 1);
  await assert.rejects(query({category: 'PVE', cursor: all.data.nextCursor}), e => e.code === 'cursor_expired');
  assert.equal(calls.filter(c => c.kind === 'reviews').length, 1);
  now.value += 25 * 3600000; data.reviews = [];
  const empty = await query({}); assert.equal(empty.status, 'ok'); assert.equal(empty.data.total, 0); assert.equal(empty.data.nextCursor, null);
  assert.equal((await service.query({action: 'builds', heroCode: 'missing-hero'})).status, 'not_found');
  assert(!calls.some(c => c.params.heroCode === 'missing-hero'));
});

test('community queries reject malformed filters and mixed action parameters before any IO', async t => {
  const {service, calls} = setup(t);
  for (const args of [
    {action: 'builds', filters: {sets: []}}, {action: 'builds', filters: {sets: ['开战', '開戰']}},
    {action: 'builds', filters: {minStats: {chd: '250'}}}, {action: 'builds', filters: {minStats: {spd: -1}}},
    {action: 'builds', filters: {minStats: {attack: 1}}}, {action: 'builds', filters: {minStats: {spd: Infinity}}},
    {action: 'builds', filters: {attribute: 'fire'}}, {action: 'builds', category: 'RTA'}, {action: 'reviews', category: 'unknown'},
    {action: 'reviews', filters: {sets: ['速度']}}, {action: 'reviews', url: 'https://evil.invalid'},
  ]) await assert.rejects(service.query({heroCode: 'test-hero-1', ...args}), e => e.code === 'invalid_query');
  assert.equal(calls.length, 0);
});

test('foreign hero or malformed community responses cannot replace a validated cache', async t => {
  const {service, data, now} = setup(t);
  for (const action of ['builds', 'reviews']) {
    const args = {action, heroCode: 'test-hero-1'};
    const good = await service.query(args);
    now.value += 25 * 3600000; data[action][0].hero_code = 'foreign-hero';
    const stale = await service.query(args); assert.equal(stale.stale, true);
    assert(stale.sources.some(s => s.warning === 'invalid_response')); assert.deepEqual(stale.data.items, good.data.items);
    data[action][0].hero_code = 'test-hero-1';
  }
  data.builds[0].att = 'NaN';
  const stale = await service.query({action: 'builds', heroCode: 'test-hero-1'}); assert.equal(stale.stale, true); assert.equal(stale.data.items[0].stats.atk, 4249);
});

test('community prose is bounded without damaging pagination and record identity', async t => {
  const {service, data} = setup(t);
  data.reviews.forEach(row => {row.content = '合成长文\n'.repeat(10000);});
  const r = await service.query({action: 'reviews', heroCode: 'test-hero-1', limit: 3});
  assert.equal(r.truncated, true); assert(Buffer.byteLength(JSON.stringify(r)) < RESULT_BYTES - 2048);
  assert(r.data.nextCursor); assert.equal(r.data.items[2].id, '3'); assert.equal(r.data.total, 4);
});

test('rankings preserve unknown object types and paginate every assignment beyond the result array cap', async t => {
  const {service, calls} = setup(t);
  const all = await service.query({action: 'rankings'});
  assert.equal(all.data.total, 3); assert.equal(all.data.untypedCount, 1);
  assert.equal(all.data.items[2].objectType, null); assert(all.missingFields.includes('items.objectType'));
  const artifacts = await service.query({action: 'rankings', objectType: 'artifact'});
  assert.deepEqual(artifacts.data.items.map(r => r.rankingId), ['2']);
  const artifact = await service.query({action: 'rankings', mode: 'get', rankingId: '2'});
  assert.equal(artifact.data.objectType, 'artifact'); assert.equal(artifact.data.items[0].objectCode, 'test-object-0');
  assert(!('heroCode' in artifact.data.items[0])); assert.equal(artifact.data.author, '合成署名');
  const unknown = await service.query({action: 'rankings', mode: 'get', rankingId: '3'});
  assert.equal(unknown.data.objectType, null); assert(unknown.missingFields.includes('objectType'));
  assert.equal((await service.query({action: 'rankings', mode: 'get', rankingId: '999'})).status, 'not_found');
  const seen = []; let cursor;
  do {
    const page = await service.query({action: 'rankings', mode: 'get', rankingId: '1', limit: 10, ...(cursor ? {cursor} : {})});
    assert.equal(page.data.tiers.length, 2); assert.equal(page.data.total, 55); assert.equal(page.truncated, false);
    seen.push(...page.data.items.map(r => r.objectCode)); cursor = page.data.nextCursor;
  } while (cursor);
  assert.equal(seen.length, 55); assert.equal(new Set(seen).size, 55); assert.equal(seen.at(-1), 'test-object-54');
  assert.equal(calls.length, 1);
});

test('invalid ranking tier references never replace a valid snapshot', async t => {
  const {service, now, data} = setup(t);
  const args = {action: 'rankings', mode: 'get', rankingId: '1'};
  const original = await service.query(args); now.value += 25 * 3600000;
  data.rankings[0].heroAssignments[0].tierId = 'foreign-tier';
  const stale = await service.query(args);
  assert.equal(stale.stale, true); assert.deepEqual(stale.data, original.data);
  assert.equal(stale.sources[0].warning, 'invalid_response');
});

test('articles search before get, clean prose, preserve image gaps and persist kind-specific locators', async t => {
  const {service, root, calls, now, data} = setup(t);
  await assert.rejects(service.query({action: 'content', kind: 'guide', mode: 'get', contentId: '1'}), e => e.code === 'content_search_required');
  assert.equal(calls.length, 0);
  data.guides.list[0].summary = '合成摘要'.repeat(200);
  const list = await service.query({action: 'content', kind: 'guide'});
  assert.equal(list.data.total, 12); assert.equal(list.data.items.length, 5);
  assert(!('content' in list.data.items[0])); assert.equal(list.data.items[0].summaryTruncated, true);
  const guide = await service.query({action: 'content', kind: 'guide', mode: 'get', contentId: '1'});
  assert.equal(guide.data.content, '第一段 A&B\n第二段。'); assert.equal(guide.data.author, '合成署名');
  assert.equal(guide.data.updatedAt, '2026-10-28 04:00:00'); assert.equal(guide.data.imageDependency, true);
  assert.equal(guide.data.detailUrl, null); assert(guide.missingFields.includes('images')); assert(guide.missingFields.includes('detailUrl'));
  assert.equal(guide.data.sourcePage, 'https://e7.wiki/guides'); assert(!JSON.stringify(guide).includes('HIDDEN-'));
  await assert.rejects(service.query({action: 'content', kind: 'faq', mode: 'get', contentId: '1'}), e => e.code === 'content_search_required');
  await service.query({action: 'content', kind: 'faq', query: 'FAQ0'});
  const faq = await service.query({action: 'content', kind: 'faq', mode: 'get', contentId: '1'});
  assert.equal(faq.data.answer, '合成答案0'); assert.equal(faq.data.kind, 'faq');
  const restarted = new E7Service({cacheRoot: root, refreshEnabled: false}, {clock: () => now.value,
    client: {read() {throw new Error('fresh public cache should survive restart');}}});
  t.after(() => restarted.stop());
  assert.equal((await restarted.query({action: 'content', kind: 'guide', mode: 'get', contentId: '1'})).data.content, guide.data.content);
});

test('article cursors traverse within and between real source pages without duplicates and bind kind/query/snapshot', async t => {
  const {service, data, now} = setup(t);
  const first = await service.query({action: 'content', kind: 'guide', limit: 3});
  const ids = first.data.items.map(r => r.contentId); let cursor = first.data.nextCursor;
  while (cursor) {
    const next = await service.query({kind: 'guide', action: 'content', cursor, limit: 3});
    ids.push(...next.data.items.map(r => r.contentId)); cursor = next.data.nextCursor;
  }
  assert.deepEqual(ids, Array.from({length: 12}, (_, n) => String(n + 1)));
  await assert.rejects(service.query({action: 'content', kind: 'faq', cursor: first.data.nextCursor}), e => e.code === 'cursor_expired');
  await assert.rejects(service.query({action: 'content', kind: 'guide', query: '合成', cursor: first.data.nextCursor}), e => e.code === 'cursor_expired');
  const bad = JSON.parse(Buffer.from(first.data.nextCursor, 'base64url')); bad.o = 99;
  await assert.rejects(service.query({action: 'content', kind: 'guide', cursor: Buffer.from(JSON.stringify(bad)).toString('base64url')}), e => e.code === 'invalid_cursor');
  now.value += 25 * 3600000; data.guides.list[0].title += '改版';
  await assert.rejects(service.query({action: 'content', kind: 'guide', cursor: first.data.nextCursor}), e => e.code === 'cursor_expired');
  const absent = await service.query({action: 'content', kind: 'guide', query: '不存在的测试词'});
  assert.equal(absent.status, 'ok'); assert.equal(absent.data.total, 0); assert.equal(absent.data.nextCursor, null);
});

test('moved articles require a new search and malformed pagination cannot overwrite the last valid page', async t => {
  const {service, now, data} = setup(t);
  const args = {action: 'content', kind: 'guide'};
  const original = await service.query(args);
  now.value += 25 * 3600000; data.guides.pagination.size = 11;
  const stale = await service.query(args); assert.equal(stale.stale, true);
  assert.deepEqual(stale.data, original.data); assert.equal(stale.sources[0].warning, 'invalid_response');
  data.guides.pagination.size = 10; data.guides.list.reverse();
  await assert.rejects(service.query({action: 'content', kind: 'guide', mode: 'get', contentId: '1'}), e => e.code === 'content_locator_expired');
  const faq = await service.query({action: 'content', kind: 'faq'}); assert(faq.data.items.length);
  now.value += 25 * 3600000; data.faq.list[0].answer = null;
  assert((await service.query({action: 'content', kind: 'faq', mode: 'get', contentId: '1'})).missingFields.includes('answer'));
});

test('reference modes and mixed or path-like IDs fail before any IO', async t => {
  const {service, calls, root} = setup(t);
  for (const args of [{action: 'rankings', mode: null}, {action: 'rankings', mode: 'search'}, {action: 'rankings', objectType: 'any'},
    {action: 'rankings', mode: 'get', rankingId: '../1'}, {action: 'rankings', rankingId: '1'}, {action: 'rankings', mode: 'get'},
    {action: 'content', kind: 'guide', mode: 'get', contentId: '1', query: 'x'}, {action: 'content', kind: 'guide', mode: 'get', contentId: '1', limit: 1},
    {action: 'content', kind: 'guide', contentId: '1'}, {action: 'content', kind: 'faq', mode: 'get', contentId: 'https://evil.invalid'},
    {action: 'content', kind: 'news'}, {action: 'content', kind: 'faq', mode: 'get'}, {action: 'content', kind: 'guide', mode: null},
    {action: 'content', kind: 'guide', url: 'https://evil.invalid'}, {action: 'content', kind: 'guide', query: ' '},
  ]) await assert.rejects(service.query(args), e => e.code === 'invalid_query');
  assert.equal(calls.length, 0); assert.equal(fs.readdirSync(root).length, 0);
});

test('FAQ compound query falls back within FAQ, binds pagination and retrieves only verified candidates', async t => {
  const {service,calls}=setup(t,{read:async(kind,params)=>{
    assert.equal(kind,'faq'); const found=params.query==='团战';
    return {status:200,data:{list:found?Array.from({length:4},(_,i)=>({id:i+41,question:'团战防御塔人数差'+i,answer:'合成答案',analysis:''})):[],pagination:{page:params.page,size:10,total:found?4:0}}};
  }});
  const args={action:'content',kind:'faq',query:'团战人数差防御塔血量',limit:2};
  const first=await service.query(args);assert.equal(first.data.search.matchMode,'keyword-fallback');assert.equal(first.data.search.effectiveQuery,'团战');
  assert.deepEqual(first.data.search.attemptedQueries,[args.query,'团战']);assert.equal(first.data.items[0].contentId,'41');assert(first.data.search.candidatesOnly);
  const next=await service.query({...args,cursor:first.data.nextCursor});assert.equal(next.data.items[0].contentId,'43');assert.equal(next.data.search.effectiveQuery,'团战');
  const detail=await service.query({action:'content',kind:'faq',mode:'get',contentId:'41'});assert.equal(detail.data.answer,'合成答案');
  assert.equal(calls.length,2,'cache is reused for cursor and get');
  await assert.rejects(service.query({...args,query:'另一个问题',cursor:first.data.nextCursor}),e=>e.code==='cursor_expired');
  const tampered=JSON.parse(Buffer.from(first.data.nextCursor,'base64url'));tampered.q='任意外部词';
  await assert.rejects(service.query({...args,cursor:Buffer.from(JSON.stringify(tampered)).toString('base64url')}),e=>e.code==='invalid_cursor');
});
test('FAQ miss is bounded and explicit; upstream failure does not trigger retries or an empty success',async t=>{
  const {service,calls}=setup(t,{read:async(kind,params)=>({status:200,data:{list:[],pagination:{page:params.page,size:10,total:0}}})});
  const result=await service.query({action:'content',kind:'faq',query:'团战人数防御血量完全未知词'});
  assert.equal(result.data.items.length,0);assert.equal(result.data.search.matchMode,'none');assert.match(result.data.search.note,/不代表站内没有/);assert(calls.length<=4);
  const failing=setup(t,{read:async()=>{throw new E7Error('rate_limited')}});
  await assert.rejects(failing.service.query({action:'content',kind:'faq',query:'团战人数差'}),e=>e.code==='rate_limited');assert.equal(failing.calls.length,1);
});


test('resource telemetry keeps per-consumer trusted correlation, 304/cache/fallback facts and no keyword or URL',async t=>{
 const events=[];let mode='ok';const f=setup(t,{dependencies:{observe:e=>events.push(e)},read:(kind,params,opts,data)=>{
  if(mode==='fail')throw new E7Error('network_failed');return mode==='304'?{status:304}:{status:200,data:kind==='faq'?{list:[],pagination:{page:params.page??1,size:10,total:0}}:data[kind],etag:'"fixture"'};
 }}),first={runId:'actual-1',toolCallId:'call-1'},second={runId:'actual-2',toolCallId:'call-2'};
 await f.service.query({action:'content',kind:'faq',query:'PRIVATE KEYWORD'},{trace:first});
 await f.service.resource('cards',{}, {trace:first});await f.service.resource('cards',{}, {trace:second});
 mode='304';await f.service.resource('cards',{}, {force:true,trace:first});mode='fail';await f.service.resource('cards',{}, {force:true,trace:second});
 assert(events.some(e=>e.correlation.runId==='actual-2'&&e.data.cache==='fresh_cache'));
 assert(events.some(e=>e.data.httpStatus===304&&e.data.cache==='revalidated'));assert(events.some(e=>e.data.stale&&e.data.cache==='stale_fallback'));
 assert(!JSON.stringify(events).includes('PRIVATE'));assert(!JSON.stringify(events).includes('https:'));
});
