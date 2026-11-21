// Disposable Gateway and KnowledgeMap SQLite, deterministic model and loopback OneBot.
// Weather requests receive an injected HTTP 503. The fixture uses no production data or accounts.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {localTime} from '../../plugins/personal-reminder-list/time.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {startIsolatedKnowledgeMap} from '../knowledgemap/isolated-api.mjs';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from './onebot-peer.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && isAbsolute(out ?? '') && !extra.length && !existsSync(out));
const root = mkdtempSync(join(tmpdir(), 'kurumi-daily-feedback-'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const owner = '810051', bot = '810052', token = randomBytes(24).toString('hex');
const tokenFile = join(root, 'token'), channelDir = join(root, 'channel'), workspace = join(root, 'workspace');
const weatherNotice = '这次天气取数失败，等服务恢复后再查。';
const queryReply = '已核对当次播报。';
const weatherTool = 'personal_weather_get_brief';
const report = {passed: false, cases: [], primaryModel: 'fixture/fixture',
  boundary: 'isolated OpenClaw, KnowledgeMap SQLite, HTTP weather failure, deterministic model and loopback OneBot'};
let peer, gateway, model, weatherApi, km, modelError, query, result;
const weatherRequests = [];
const check = () => {peer.check(); if (modelError) throw modelError;};

async function openHttp(handler) {
  const server = createServer(handler).listen(0, '127.0.0.1');
  await once(server, 'listening');
  return server;
}
function closeHttp(server) {
  if (!server) return;
  server.closeAllConnections();
  return new Promise(resolve => server.close(resolve));
}
function toolCall(request, name, args) {
  assert(request.tools.some(tool => tool.function.name === name), 'Missing tool ' + name);
  return {tool_calls: [{id: 'fixture_' + name, type: 'function', function: {name, arguments: JSON.stringify(args)}}]};
}
function contentOf(message) {
  return typeof message?.content === 'string' ? message.content : message?.content?.map(part => part.text ?? '').join('') ?? '';
}
function reply(request) {
  const last = request.messages.findLast(message => message.role === 'user' || message.role === 'tool');
  if (query) {
    if (last?.role !== 'tool') return toolCall(request, 'kurumi_logs', query);
    const text = contentOf(last);
    const start = text.indexOf('{"status":"ok"');
    assert(start >= 0, 'Missing successful daily-feedback result');
    result = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
    return {content: queryReply};
  }
  if (last?.role !== 'tool') {
    assert(request.messages.some(message => message.role === 'user' && contentOf(message).includes('FIXTURE_DAILY_WEATHER')),
      'Unexpected scheduled model request');
    return toolCall(request, weatherTool, {});
  }
  assert(contentOf(last).includes('UPSTREAM_UNAVAILABLE'), 'Expected structured weather failure');
  return {content: weatherNotice};
}

try {
  mkdirSync(workspace);
  writeFileSync(tokenFile, token, {mode: 0o600});
  km = await startIsolatedKnowledgeMap(root);
  assert.deepEqual(await km.client.allTasks(), []);
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});
  weatherApi = await openHttp((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'GET' || req.headers.authorization !== 'Bearer ' + token
      || !/^\/api\/assistant\/weather\/(current|daily|hourly|alerts)$/u.test(path)) {
      res.writeHead(400).end();
      return;
    }
    weatherRequests.push(path);
    res.writeHead(503, {'content-type': 'application/json'}).end('{"detail":{"code":"synthetic_unavailable"}}');
  });
  model = await openHttp(async (req, res) => {
    try {
      let body = '';
      for await (const chunk of req) body += chunk;
      const request = JSON.parse(body), message = {role: 'assistant', ...reply(request)};
      const finish = message.tool_calls ? 'tool_calls' : 'stop';
      const base = {id: 'daily-fixture', created: 1, model: 'fixture'};
      if (!request.stream) return res.setHeader('content-type', 'application/json').end(JSON.stringify({
        ...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason: finish}],
      }));
      if (message.tool_calls) message.tool_calls[0].index = 0;
      const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
        ...base, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}],
      }) + '\n\n';
      res.setHeader('content-type', 'text/event-stream').end(chunk(message, null) + chunk({}, finish) + 'data: [DONE]\n\n');
    } catch (error) {
      modelError ??= error;
      res.writeHead(400).end();
    }
  });
  const listAt = Math.ceil((Date.now() + 26000) / 60000) * 60000;
  const listSlot = localTime(listAt).slice(11, 16);
  const entries = {
    'kurumi-qq': {enabled: true},
    'kurumi-logs': {enabled: true, config: {backendRoot: repo, runtimeRoot: root, snowlumaRoot: root}},
    'personal-reminder-list': {enabled: true, config: {
      backendRoot: join(repo, 'chatbot'), defaultTimes: [listSlot], dataSource: 'knowledgemap',
      bridgeBaseUrl: km.config.baseUrl, bridgeTokenFile: km.config.tokenFile,
    }},
    'personal-weather': {enabled: true, config: {
      weatherBackend: 'knowledgemap', bridgeBaseUrl: 'http://127.0.0.1:' + weatherApi.address().port, bridgeTokenFile: tokenFile,
      apiHost: 'fixture.invalid', apiKey: 'fixture',
    }},
  };
  const plugins = Object.keys(entries);
  const cfg = withHostControl(compileAccessConfig({
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'},
      heartbeat: {every: '0m'}, model: {primary: 'fixture/fixture'}},
    entries: {main: {workspace, tools: {allow: [weatherTool, 'kurumi_logs']}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
      apiKey: 'fixture', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', contextWindow: 64000, maxTokens: 600}]}}},
    plugins: {allow: plugins, load: {paths: plugins.map(id => join(repo, 'chatbot/plugins', id))}, slots: {memory: 'none'}, entries},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: channelDir, mediaRoot: join(root, 'media'), segmentDelayMs: 0, inboundDebounceMs: 200, testIngress: false}},
    tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: true}, update: {checkOnStart: false}, logging: {file: join(root, 'runtime.log')},
  }, ownerPolicy(owner)), repo);
  gateway = await startIsolatedGateway({repo, root, token, configure: () => cfg});
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'OneBot connection');
  const call = gateway.call;
  const listJob = await waitForAcceptance(async () => {
    const {jobs} = await call('cron.list', {includeDisabled: true});
    return jobs.find(job => job.declarationKey === 'kurumi.reminder-list.daily:' + listSlot);
  }, 'managed reminder list schedule');
  assert.equal(listJob.state.nextRunAtMs, listAt);
  const waitRun = (id, timeoutMs) => waitForAcceptance(async () => {
    check();
    return (await call('cron.runs', {id, limit: 1})).entries[0];
  }, 'scheduled Cron completion', {pollMs: 500, timeoutMs});
  const listRun = await waitRun(listJob.id, 90000);
  assert.equal(listRun.status, 'ok');
  assert.equal(listRun.delivered, false);
  assert.equal(peer.sends.length, 0);
  report.cases.push('The scheduled fixed runner reads an empty shared list and makes zero OneBot sends');

  const weatherAt = Math.floor(Date.now() / 1000) * 1000 + 8000;
  const [hour, minute, second] = localTime(weatherAt).slice(11).split(':').map(Number);
  const weatherJob = await call('cron.add', {name: 'fixture.daily-weather', agentId: 'main', enabled: true,
    schedule: {kind: 'cron', expr: [second, minute, hour, '*', '*', '*'].join(' '), tz: 'Asia/Shanghai', staggerMs: 0},
    sessionTarget: 'isolated', wakeMode: 'now', payload: {kind: 'agentTurn', message: 'FIXTURE_DAILY_WEATHER', toolsAllow: [weatherTool]},
    delivery: {mode: 'announce', channel: 'kurumi-qq', to: 'user:' + owner, accountId: 'default'}, deleteAfterRun: false,
  });
  assert.equal(weatherJob.state.nextRunAtMs, weatherAt);
  const weatherRun = await waitRun(weatherJob.id, 30000);
  assert.equal(weatherRun.status, 'ok');
  assert.equal(weatherRequests.length, 4);
  assert.deepEqual(peer.sends.map(textOfSend), [weatherNotice]);
  const weatherSend = peer.sends[0];

  async function lookup(broadcast, at) {
    const before = peer.sends.length;
    query = {view: 'daily-feedback', broadcast, scheduledAt: localTime(at)};
    result = undefined;
    const id = await peer.send(peer.message(owner, '请核对当次每日播报。'));
    await waitForOneBotTurn(channelDir, [id], {check});
    query = undefined;
    assert.deepEqual(peer.sends.slice(before).map(textOfSend), [queryReply]);
    assert.equal(result?.view, 'daily-feedback');
    assert.equal(result.feedback.evidence.scheduledAt, new Date(at).toISOString());
    return result;
  }
  const list = await lookup('reminder-list', listAt);
  assert.equal(list.feedback.status, 'skipped');
  assert.equal(list.feedback.evidence.reason, 'empty_list');
  assert.equal(list.feedback.evidence.shouldSend, 'no');
  assert.equal(list.feedback.evidence.bodyStatus, 'not_generated');
  assert.equal(list.feedback.evidence.runAtMs, listRun.runAtMs);
  assert.equal(list.notification.platformStatus, 'not_attempted');
  assert.deepEqual(list.notification.segments, []);
  report.cases.push('Owner queries the empty slot by planned time and sees the skip and absence of delivery');

  const weather = await lookup('weather', weatherAt);
  assert.equal(weather.feedback.status, 'failed');
  assert.equal(weather.feedback.evidence.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(weather.feedback.evidence.shouldSend, 'yes');
  assert.equal(weather.feedback.evidence.bodyStatus, 'failed');
  assert.equal(weather.feedback.evidence.runAtMs, weatherRun.runAtMs);
  assert.equal(weather.notification.kind, 'error');
  assert.equal(weather.notification.platformStatus, 'accepted');
  assert.deepEqual(weather.notification.segments.map(segment => segment.messageId), [weatherSend.messageId]);
  report.cases.push('The weather tool fails and the owner query attributes the accepted error notice to the exact run');

  const adjacent = await lookup('weather', weatherAt - 1000);
  assert.equal(adjacent.feedback.status, 'unknown');
  assert.equal(adjacent.notification.platformStatus, 'unknown');
  assert.deepEqual(await lookup('weather', weatherAt), weather);
  assert.equal(weatherRequests.length, 4);
  assert.equal(peer.sends.filter(send => textOfSend(send) === weatherNotice).length, 1);
  report.cases.push('An adjacent time cannot adopt the receipt and repeating the query triggers no weather or notification work');
  report.passed = true;
} catch (error) {
  report.error = (modelError ?? error).stack;
} finally {
  const closed = await Promise.all([gateway?.close(), km?.close(), peer?.close(), closeHttp(model), closeHttp(weatherApi)]);
  if (closed.includes(false)) {
    report.passed = false;
    report.error ??= 'Fixture service shutdown failed';
  }
  report.configSha256 = gateway?.configSha256;
  if (report.passed) rmSync(root, {recursive: true, force: true});
  else {report.diagnosticsRoot = root; process.exitCode = 1;}
  report.fixtureCleaned = !existsSync(root);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
