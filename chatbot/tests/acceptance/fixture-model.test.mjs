import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {readFixtureJson} from './fixture-model.mjs';

test('fixture model decodes UTF-8 after collecting arbitrary HTTP chunks', async () => {
  const encoded = Buffer.from(JSON.stringify({text: '确认这份中文账单'}));
  const chunks = [...encoded].map(byte => Buffer.from([byte]));
  assert.deepEqual(await readFixtureJson(Readable.from(chunks)), {text: '确认这份中文账单'});
});

test('fixture model rejects oversized and malformed requests', async () => {
  await assert.rejects(readFixtureJson(Readable.from([Buffer.from('{"x":'), Buffer.from('"中"}')]), {maxBytes: 8}),
    /fixture_model_request_too_large/);
  await assert.rejects(readFixtureJson(Readable.from([Buffer.from('{bad')])), SyntaxError);
});
