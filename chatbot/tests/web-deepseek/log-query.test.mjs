// Offline read-only log-query adapter for DeepSeek provider traces, temporary runtime only. Design: docs/26.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {collectEvents, formatEvent} from '../../../scripts/fusion/log-query.mjs';
import {DeepSeekWebClient} from '../../plugins/kurumi-web-deepseek/client.js';
import {createDeepSeekWebPlugin} from '../../plugins/kurumi-web-deepseek/index.js';

test('configured web-deepseek trace is queryable and formatted without query text', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-web-log-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const credentialsFile = path.join(root, 'keys.json'), traceFile = path.join(root, 'web', 'events.jsonl');
  fs.writeFileSync(credentialsFile, JSON.stringify({DEEPSEEK_API_KEY: 'sk-offline' + 'z'.repeat(32)}), {mode: 0o600});
  const providers = {};
  createDeepSeekWebPlugin({clientFactory: options => new DeepSeekWebClient({...options,
    fetchImpl: async () => new Response(JSON.stringify({error: {message: 'busy'}}), {status: 504})})})
    .register({pluginConfig: {credentialsFile, traceFile}, registerWebSearchProvider: p => {providers.search = p;}, registerWebFetchProvider: () => {}});
  await assert.rejects(providers.search.createTool({}).execute({query: '不应出现在日志'}), error => error.code === 'upstream_timeout');

  assert.deepEqual(collectEvents({runtimeRoot: root, sources: ['web-deepseek'], from: 0, to: Date.now() + 1000}), [], 'unconfigured trace yields nothing');
  fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify({plugins: {entries: {'kurumi-web-deepseek': {config: {credentialsFile, traceFile}}}}}));
  const events = collectEvents({runtimeRoot: root, sources: ['web-deepseek'], from: 0, to: Date.now() + 1000});
  assert.equal(events.length, 1);
  assert.equal(events[0].data.credentialsFile, undefined);
  const line = formatEvent(events[0]);
  assert.match(line, /\[provider_call\] web-deepseek \| web_search error upstream_timeout 504 \d+ms/);
  assert.ok(!JSON.stringify(events).includes('不应出现在日志'));
});
