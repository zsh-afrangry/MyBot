// Offline query/cache tests: synthetic wiki data and temporary directories only.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {setup} from './fixtures.mjs';
import {E7Error, RESULT_BYTES} from '../../plugins/kurumi-e7/policy.js';
import {E7Store} from '../../plugins/kurumi-e7/store.js';

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
