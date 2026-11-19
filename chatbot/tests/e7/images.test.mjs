import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './fixtures.mjs';
import {E7Client} from '../../plugins/kurumi-e7/client.js';
import {validateImageQuery, selectImage} from '../../plugins/kurumi-e7/images.js';
import {buildCardLayout, heroCardLayout, renderCard} from '../../plugins/kurumi-e7/cards.js';
import {buildProjection} from '../../plugins/kurumi-e7/query.js';

const webp = Buffer.from('RIFF0000WEBP');
const redPng = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAMAAAADCAYAAABWKLW/AAAAFUlEQVR4nGP8z8DwnwEKmBiQAAoHAElTAgTVE24MAAAAAElFTkSuQmCC', 'base64');
test('E7 source image GET needs the pinned assets host, selected media prefix and matching MIME/signature', async () => {
  const calls = [];
  const client = new E7Client({guardedFetch: async args => {
    calls.push(args);
    return {response: new Response(webp, {headers: {'content-type': args.url.endsWith('mismatch.webp') ? 'image/png' : 'image/webp'}}),
      finalUrl: args.url, release() {}};
  }});
  const result = await client.read('heroImage', {kind: 'avatar', relative: '/static/avatar/test.webp'});
  assert.equal(result.contentType, 'image/webp');
  assert.deepEqual(result.data, webp);
  assert.equal(calls[0].url, 'https://assets2.e7.wiki/static/avatar/test.webp');
  assert.equal(calls[0].init.credentials, 'omit');
  for (const relative of ['/static/detailImage/test.webp', '/static/avatar/%2e%2e/test.webp', '/static/avatar/test.webp#hash', 'https://assets2.e7.wiki/static/avatar/test.webp', '/static/avatar/test.svg'])
    await assert.rejects(client.read('heroImage', {kind: 'avatar', relative}), {code: 'invalid_query'});
  assert.equal(calls.length, 1);
  await assert.rejects(client.read('heroImage', {kind: 'avatar', relative: '/static/avatar/mismatch.webp'}), {code: 'invalid_response'});
});

test('selects an effect only when attached to the current hero, never guesses a URL or accepts a recipient', async t => {
  const {service, calls, now} = setup(t, {
    read: async (kind, params, opts, data) => kind === 'heroImage' ? {status: 200, data: webp, contentType: 'image/webp'} : {status: 200, data: data[kind]},
  });
  const args = {heroCode: 'test-hero-1', kind: 'effect', effectId: '101'};
  for (const fields of [{to: 'group:123'}, {url: '/static/effects/test.webp'}, {skill: 1}, {effectId: undefined}])
    await assert.rejects(service.image({...args, ...fields}), {code: 'invalid_query'});
  assert.deepEqual(calls, []);
  await assert.rejects(service.image({...args, effectId: '999'}), {code: 'image_unavailable'});
  await assert.rejects(service.image({heroCode: 'test-hero-1', kind: 'cover'}), {code: 'image_unavailable'});
  assert.equal(calls.filter(c => c.kind === 'heroImage').length, 0);
  assert.deepEqual(await service.image(args), {bytes: webp, contentType: 'image/webp'});
  await service.image(args);
  const reads = () => calls.filter(c => c.kind === 'heroImage').map(c => c.params.relative);
  assert.deepEqual(reads(), ['/static/effects/test.webp']);
  now.value += 7 * 86400000;
  await service.image(args);
  assert.deepEqual(reads(), ['/static/effects/test.webp', '/static/effects/test.webp']);
  const skill = validateImageQuery({heroCode: 'test-hero-1', kind: 'skill', skill: 2});
  assert.equal(selectImage({skills: [{slot: 2, iconUrl: '/static/skills/second.png'}]}, skill), '/static/skills/second.png');
});

function isCard(result) {
  assert.equal(result.contentType, 'image/png');
  assert.equal(result.bytes.subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  assert.equal(result.bytes.readUInt32BE(16), 1120);
  assert.match(result.caption, /E7·WIKI.*校对日期（UTC）：2026-10-27/u);
}

test('hero card keeps conditional multipliers and renders a PNG when optional images are unavailable', async t => {
  const {service, data, calls} = setup(t, {read: async (kind, _params, _opts, source) => {
    if (kind === 'heroImage') throw Error('synthetic missing art');
    return {status: 200, data: source[kind]};
  }});
  data.hero.skills[0].iconUrl = '/static/skills/test.png';
  data.hero.skills[0].name = '甲 & 乙';
  const {svg} = heroCardLayout(data.hero, {source: 'E7·WIKI'});
  assert.match(svg, /甲 &amp; 乙/u);
  assert.match(svg, /普通倍率：基础倍率 0\.9/u);
  assert.match(svg, /条件倍率：基础倍率 1\.7/u);
  assert.match(svg, /角色图片暂不可用/u);
  isCard(await service.image({heroCode: 'test-hero-1', kind: 'hero_card'}));
  assert.deepEqual(new Set(calls.filter(c => c.kind === 'heroImage').map(c => c.params.kind)), new Set(['detail', 'avatar', 'skill']));
});

test('build cards require bounded filters, show real coverage and keep full five-digit stats on a two-column card', async t => {
  const {service, data, calls} = setup(t, {read: async (kind, _params, _opts, source) => {
    if (kind === 'heroImage') throw Error('synthetic missing art');
    return {status: 200, data: source[kind]};
  }});
  const args = {heroCode: 'test-hero-1', kind: 'build_card'};
  for (const extra of [{count: 11}, {count: 1.5}, {filters: {minStats: {unknown: 150}}}, {filters: {sets: ['速度', '速度']}}, {to: 'someone'}]) {
    await assert.rejects(service.image({...args, ...extra}), {code: 'invalid_query'});
  }
  await assert.rejects(service.image({...args, kind: 'hero_card', count: 1}), {code: 'invalid_query'});
  assert.equal(calls.length, 0);
  await assert.rejects(service.image({...args, filters: {sets: ['穿透'], minStats: {spd: 300}}}), {code: 'no_build_samples'});
  assert(!calls.some(c => c.kind === 'heroImage'));
  const filters = {sets: ['開戰', '穿透'], minStats: {spd: 223, chd: 250}};
  const result = await service.image({...args, count: 10, filters});
  isCard(result);
  assert.deepEqual(result.coverage, {requested: 10, shown: 3, matched: 3});
  assert.deepEqual((await service.image(args)).coverage, {requested: 1, shown: 1, matched: 12});
  const {svg} = buildCardLayout(data.cards[0], {samples: data.builds.slice(0, 2).map(buildProjection), requested: 10, total: 2, source: 'E7·WIKI'});
  assert.match(svg, /展示 2 条/u);
  assert.equal(svg.match(/>17,346<\/text>/gu)?.length, 2);
  assert.match(svg, /作者：合成作者/u);
  assert.match(svg, /来源更新时间：2026-10-28 01:00:00/u);
  assert.match(svg, /面板含装备/u);
});

test('sandbox composites validated raster art onto a generated card', async () => {
  const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="1120" height="12"><rect width="1120" height="12" fill="#000"/></svg>';
  const layout = {svg, height: 12, layers: []};
  const red = {asset: {bytes: redPng}, left: 0, top: 0, width: 6, height: 6};
  const [plain, withArt] = await Promise.all([renderCard(layout), renderCard({...layout, layers: [red]})]);
  assert.notDeepEqual(withArt.bytes, plain.bytes);
});
