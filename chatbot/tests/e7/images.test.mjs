import test from 'node:test';
import assert from 'node:assert/strict';
import {setup} from './fixtures.mjs';
import {E7Client} from '../../plugins/kurumi-e7/client.js';
import {validateImageQuery, selectImage} from '../../plugins/kurumi-e7/images.js';

const webp = Buffer.from('RIFF0000WEBP');
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
