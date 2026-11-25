// Disposable Gateway, KnowledgeMap SQLite, synthetic weather and loopback OneBot.
// --model calls the configured paid model. No production data, real QQ or weather API requests.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from './fixture-model.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {redactText} from '../../packages/observability/index.js';
import {dailyFeedbackQuery} from '../../packages/log-query/daily-feedback-query.js';
import {readDailyFeedback} from '../../packages/log-query/daily-feedback.js';
import {currentFixture, dailyFixture, hourlyFixture, alertFixture} from '../../packages/personal-domains/dist/test-fixtures.js';
import {localTime} from '../../plugins/personal-reminder-list/time.js';
import {manageRemoteList} from '../../plugins/personal-reminder-list/remote.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {startIsolatedKnowledgeMap} from '../knowledgemap/isolated-api.mjs';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {configuredModel, observeToolResults, syntheticPersona} from './configured-dialogue.mjs';
import {assertionDiagnostics} from './assertion-diagnostics.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from './onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from './scenario-lifecycle.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
const realModel = extra.length === 1 && extra[0] === '--model';
assert(flag === '--out' && isAbsolute(out ?? '') && (!extra.length || realModel) && !existsSync(out));
const root = mkdtempSync(join(tmpdir(), 'kurumi-daily-feedback-'));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const owner = '810051', bot = '810052', token = randomBytes(24).toString('hex');
const tokenFile = join(root, 'token'), channelDir = join(root, 'channel'), workspace = join(root, 'workspace');
const weatherNotice = '这次天气取数失败，等服务恢复后再查。';
const weatherSuccess = '当前多云，气温约32°C，天气数据来自本次本地样本。';
const queryReply = '已核对当次播报。';
const weatherTool = 'personal_weather_get_brief';
const report = {passed: false, cases: [], requests: 0, primaryModel: 'fixture/fixture',
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  boundary: 'isolated OpenClaw, KnowledgeMap SQLite, synthetic weather and loopback OneBot'};
let peer, gateway, model, weatherApi, km, modelError, query, result, upstream, failureStep, establishing, lastLookupText, weatherAvailable = true;
const weatherRequests = [], observeResults = observeToolResults();
let observed = [];
const check = () => {scenarioSignal.throwIfAborted(); peer.check(); if (modelError) throw modelError;};

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
  if (establishing) return {content: '我在，准备好了。'};
  if (query) {
    if (last?.role !== 'tool') return toolCall(request, 'kurumi_logs', query);
    const text = contentOf(last);
    const start = text.indexOf('{"status":"ok"');
    assert(start >= 0, 'Missing successful daily-feedback result');
    result = JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
    return {content: queryReply};
  }
  if (request.messages.some(message => contentOf(message).includes('scheduled_reminder_list_opening'))) {
    return {content: '这里还有一项待办，我们一起看看。'};
  }
  if (last?.role !== 'tool') {
    assert(request.messages.some(message => message.role === 'user' && contentOf(message).includes('FIXTURE_DAILY_WEATHER')),
      'Unexpected scheduled model request');
    return toolCall(request, weatherTool, {});
  }
  if (contentOf(last).includes('UPSTREAM_UNAVAILABLE')) return {content: weatherNotice};
  assert(/"ok"\s*:\s*true/u.test(contentOf(last)), 'Expected structured weather result');
  return {content: weatherSuccess};
}

try {
  failureStep = 'gateway-start'; scenarioProgress(failureStep, 'started', 'environment');
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
  mkdirSync(workspace);
  writeFileSync(tokenFile, token, {mode: 0o600});
  km = await startIsolatedKnowledgeMap(root);
  assert.deepEqual(await km.client.allTasks(), []);
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});
  const weatherResponses = () => {
    const today = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', dateStyle: 'short'}).format(Date.now());
    const tomorrow = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', dateStyle: 'short'}).format(Date.now() + 86400000);
    const daily = structuredClone(dailyFixture), hourly = structuredClone(hourlyFixture), alerts = structuredClone(alertFixture);
    Object.assign(daily.days[0], {forecastStartTime: today + 'T00:00+08:00', forecastEndTime: tomorrow + 'T00:00+08:00'});
    Object.assign(daily.days[0].daytime, {forecastStartTime: today + 'T07:00+08:00', forecastEndTime: today + 'T19:00+08:00'});
    Object.assign(daily.days[0].nighttime, {forecastStartTime: today + 'T19:00+08:00', forecastEndTime: tomorrow + 'T07:00+08:00'});
    hourly.hours[0].forecastTime = new Date(Date.now() + 3600000).toISOString(); alerts.metadata.zeroResult = true; alerts.alerts = [];
    return {current: currentFixture, daily, hourly, alerts};
  };
  weatherApi = await openHttp((req, res) => {
    const path = new URL(req.url, 'http://127.0.0.1').pathname;
    if (req.method !== 'GET' || req.headers.authorization !== 'Bearer ' + token
      || !/^\/api\/assistant\/weather\/(current|daily|hourly|alerts)$/u.test(path)) {
      res.writeHead(400).end();
      return;
    }
    weatherRequests.push(path);
    if (!weatherAvailable) return res.writeHead(503, {'content-type': 'application/json'}).end('{"detail":{"code":"synthetic_unavailable"}}');
    res.writeHead(200, {'content-type': 'application/json'}).end(JSON.stringify(weatherResponses()[path.split('/').at(-1)]));
  });
  model = await openHttp(async (req, res) => {
    try {
      assert(++report.requests <= 120, 'Model request budget exceeded');
      const request = await readFixtureJson(req);
      if (realModel) {
        observeResults(request.messages ?? [], observed);
        const response = await fetch(upstream.url, {method: 'POST', redirect: 'error',
          headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + upstream.key},
          signal: AbortSignal.timeout(60000), body: JSON.stringify({...request, model: upstream.modelId, max_tokens: 2000, temperature: 0})});
        if (!response.ok) throw Error('Configured model HTTP ' + response.status);
        res.writeHead(200, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
        for await (const chunk of response.body) res.write(chunk);
        return res.end();
      }
      const message = {role: 'assistant', ...reply(request)};
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
  const listAt = Math.ceil((Date.now() + 45000) / 60000) * 60000;
  const listSlot = localTime(listAt).slice(11, 16);
  const populatedAt = listAt + 60000, populatedSlot = localTime(populatedAt).slice(11, 16);
  const entries = {
    'kurumi-qq': {enabled: true},
    'kurumi-logs': {enabled: true, config: {backendRoot: repo, runtimeRoot: root, snowlumaRoot: root}},
    'personal-reminder-list': {enabled: true, config: {
      backendRoot: join(repo, 'chatbot'), defaultTimes: [listSlot, populatedSlot], dataSource: 'knowledgemap',
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
      apiKey: 'fixture', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}]}}},
    plugins: {allow: plugins, load: {paths: plugins.map(id => join(repo, 'chatbot/plugins', id))}, slots: {memory: 'none'}, entries},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: channelDir, mediaRoot: join(root, 'media'), segmentDelayMs: 0, inboundDebounceMs: 200, testIngress: false}},
    tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: true}, update: {checkOnStart: false}, logging: {file: join(root, 'runtime.log')},
  }, ownerPolicy(owner)), repo);
  if (realModel) syntheticPersona({repo, root, config: cfg, policy: ownerPolicy(owner),
    userFile: '这是一次虚构天气和待办播报场景。时区为 Asia/Shanghai。'});
  gateway = await startIsolatedGateway({repo, root, token, configure: () => cfg});
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'OneBot connection');
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment'); failureStep = undefined;
  // A scheduled assistant notice is bound to an established owner session.
  failureStep = 'establish-session'; scenarioProgress(failureStep, 'started', 'check');
  establishing = true;
  const sessionMessage = await peer.send(peer.message(owner, '你好，请回复一句准备好即可。'));
  await waitForOneBotTurn(channelDir, [sessionMessage], {check, timeoutMs: realModel ? 180000 : 30000});
  establishing = false;
  assert(peer.sends.length && peer.sends.every(send => send.accepted));
  const baselineSends = peer.sends.length;
  scenarioProgress(failureStep, 'passed', 'check');
  const call = gateway.call;
  const jobAt = slot => waitForAcceptance(async () => {
    const {jobs} = await call('cron.list', {includeDisabled: true});
    return jobs.find(job => job.declarationKey === 'kurumi.reminder-list.daily:' + slot);
  }, 'managed reminder list schedule');
  const listJob = await jobAt(listSlot), populatedJob = await jobAt(populatedSlot);
  assert.equal(listJob.state.nextRunAtMs, listAt);
  assert.equal(populatedJob.state.nextRunAtMs, populatedAt);
  const waitRun = (id, timeoutMs) => waitForAcceptance(async () => {
    check();
    return (await call('cron.runs', {id, limit: 1})).entries[0];
  }, 'scheduled Cron completion', {pollMs: 500, timeoutMs});
  failureStep = 'empty-list-schedule'; scenarioProgress(failureStep, 'started', 'check');
  const listRun = await waitRun(listJob.id, 120000);
  assert.equal(listRun.status, 'ok');
  assert.equal(listRun.delivered, false);
  assert.equal(peer.sends.length, baselineSends);
  report.cases.push('The scheduled fixed runner reads an empty shared list and makes zero OneBot sends');
  scenarioProgress(failureStep, 'passed', 'check');

  const task = await manageRemoteList(km.client, {action: 'add', title: '验收待办播报事项'},
    {sessionKey: 'synthetic-seed', messageId: 'daily-broadcast-task'});
  assert(task.item?.id); assert.equal((await km.client.allTasks()).length, 1);
  failureStep = 'populated-list-schedule'; scenarioProgress(failureStep, 'started', 'check');
  const beforeList = peer.sends.length;
  const populatedRun = await waitRun(populatedJob.id, 120000);
  assert.equal(populatedRun.status, 'ok');
  const listSends = peer.sends.slice(beforeList);
  assert(listSends.length && listSends.every(send => send.accepted));
  assert(listSends.map(textOfSend).join('').includes('验收待办播报事项'));
  report.cases.push('The next native Cron slot delivers the frozen shared task list once');
  scenarioProgress(failureStep, 'passed', 'check');

  async function scheduledWeather(label) {
    failureStep = label; scenarioProgress(label, 'started', 'check');
    const at = Math.floor(Date.now() / 1000) * 1000 + 8000;
    const [hour, minute, second] = localTime(at).slice(11).split(':').map(Number), before = peer.sends.length;
    const job = await call('cron.add', {name: 'fixture.daily-weather-' + label, agentId: 'main', enabled: true,
      schedule: {kind: 'cron', expr: [second, minute, hour, '*', '*', '*'].join(' '), tz: 'Asia/Shanghai', staggerMs: 0},
      sessionTarget: 'isolated', wakeMode: 'now', payload: {kind: 'agentTurn',
        message: 'FIXTURE_DAILY_WEATHER 请查询当前所在地的天气并播报，失败时如实说明。', toolsAllow: [weatherTool]},
      delivery: {mode: 'announce', channel: 'kurumi-qq', to: 'user:' + owner, accountId: 'default'}, deleteAfterRun: false,
    });
    assert.equal(job.state.nextRunAtMs, at);
    const run = await waitRun(job.id, 90000), sends = peer.sends.slice(before);
    assert.equal(run.status, 'ok'); assert(sends.length && sends.every(send => send.accepted));
    scenarioProgress(label, 'passed', 'check');
    return {at, run, sends};
  }
  weatherAvailable = false;
  const failedWeather = await scheduledWeather('weather-failure');
  const failedRequests = weatherRequests.length;
  assert(failedRequests >= 4 && failedRequests <= 12 && failedRequests % 4 === 0, 'Unexpected weather failure request count');
  if (!realModel) assert.equal(failedRequests, 4);
  if (!realModel) assert.equal(failedWeather.sends.map(textOfSend).join(''), weatherNotice);
  weatherAvailable = true;
  const goodWeather = await scheduledWeather('weather-success');
  const totalWeatherRequests = weatherRequests.length;
  assert(totalWeatherRequests >= failedRequests + 4 && totalWeatherRequests <= failedRequests + 12,
    'Unexpected weather success request count');
  if (!realModel) assert.equal(totalWeatherRequests, 8);
  if (!realModel) assert.equal(goodWeather.sends.map(textOfSend).join(''), weatherSuccess);
  else assert(/多云|31\.7|32/u.test(goodWeather.sends.map(textOfSend).join('')), 'Weather reply omitted the observed conditions');

  async function lookup(broadcast, at) {
    failureStep = 'lookup-' + broadcast; scenarioProgress(failureStep, 'started', 'check');
    const before = peer.sends.length;
    query = {view: 'daily-feedback', broadcast, scheduledAt: localTime(at)};
    result = undefined; observed = [];
    const kind = broadcast === 'weather' ? '天气' : '待办清单';
    const id = await peer.send(peer.message(owner, `请根据计划时间 ${localTime(at)} 核对${kind}播报的结果。`));
    await waitForOneBotTurn(channelDir, [id], {check, timeoutMs: realModel ? 180000 : 30000});
    query = undefined;
    const sends = peer.sends.slice(before);
    assert(sends.length && sends.every(send => send.accepted));
    lastLookupText = sends.map(textOfSend).join('');
    if (!realModel) assert.deepEqual(sends.map(textOfSend), [queryReply]);
    else {
      const decodeLog = value => {
        if (typeof value !== 'string' || !value.includes('EXTERNAL_UNTRUSTED_CONTENT')) return value;
        const start = value.indexOf('{"status":"ok"');
        return start < 0 ? undefined : JSON.parse(value.slice(start, value.lastIndexOf('}') + 1));
      };
      result = observed.filter(row => row.tool === 'kurumi_logs').map(row => decodeLog(row.value))
        .findLast(value => value?.view === 'daily-feedback' && value.feedback?.action === broadcast + '.daily'
          && value.feedback.evidence?.scheduledAt === new Date(at).toISOString());
    }
    assert.equal(result?.view, 'daily-feedback');
    assert.equal(result.feedback.evidence.scheduledAt, new Date(at).toISOString());
    report.lookups ??= [];
    report.lookups.push({broadcast, scheduledAt: result.feedback.evidence.scheduledAt, status: result.feedback.status,
      cronJobId: result.feedback.evidence.cronJobId, runId: result.feedback.evidence.runId,
      platformStatus: result.notification.platformStatus, messageIds: result.notification.segments.map(segment => segment.messageId)});
    scenarioProgress(failureStep, 'passed', 'check');
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

  const populated = await lookup('reminder-list', populatedAt);
  assert.equal(populated.feedback.status, 'succeeded');
  assert.equal(populated.feedback.evidence.bodyStatus, 'generated');
  assert.equal(populated.feedback.evidence.runAtMs, populatedRun.runAtMs);
  assert.equal(populated.notification.kind, 'business');
  assert.equal(populated.notification.platformStatus, 'accepted');
  assert.deepEqual(populated.notification.segments.map(segment => segment.messageId), listSends.map(send => send.messageId));
  report.cases.push('The planned task-list slot is associated with its body and accepted local receipt');

  const weather = await lookup('weather', failedWeather.at);
  assert.equal(weather.feedback.status, 'failed');
  if (realModel) {
    assert(/失败|不可用|未能|出错/u.test(lastLookupText), 'Reply omitted the actual weather failure');
    assert(!/不是.{0,8}(?:天气|上游).{0,8}(?:故障|失败|不可用|挂)/u.test(lastLookupText), 'Reply contradicted the historical weather result');
    assert(!/下次.{0,16}(?:修复|修好|不再)/u.test(lastLookupText), 'Reply promised an unperformed repair');
    assert(!/重试.{0,8}(?:成功|恢复)/u.test(lastLookupText), 'Reply attributed an independent run to a retry');
  }
  assert.equal(weather.feedback.evidence.code, 'UPSTREAM_UNAVAILABLE');
  assert.equal(weather.feedback.evidence.shouldSend, 'yes');
  assert.equal(weather.feedback.evidence.bodyStatus, 'failed');
  assert.equal(weather.feedback.evidence.runAtMs, failedWeather.run.runAtMs);
  assert.equal(weather.notification.kind, 'error');
  assert.equal(weather.notification.platformStatus, 'accepted');
  assert.deepEqual(weather.notification.segments.map(segment => segment.messageId), failedWeather.sends.map(send => send.messageId));
  report.cases.push('The weather tool fails and the owner query attributes the accepted error notice to the exact run');

  const successfulWeather = await lookup('weather', goodWeather.at);
  assert.equal(successfulWeather.feedback.status, 'succeeded');
  assert.equal(successfulWeather.feedback.evidence.weatherDataStatus, 'available');
  assert.equal(successfulWeather.feedback.evidence.runAtMs, goodWeather.run.runAtMs);
  assert.equal(successfulWeather.notification.kind, 'business');
  assert.equal(successfulWeather.notification.platformStatus, 'accepted');
  assert.deepEqual(successfulWeather.notification.segments.map(segment => segment.messageId), goodWeather.sends.map(send => send.messageId));
  report.cases.push('Successful weather data and local delivery are associated with the planned Cron slot');

  const adjacent = await lookup('weather', failedWeather.at - 1000);
  assert.equal(adjacent.feedback.status, 'unknown');
  assert.equal(adjacent.notification.platformStatus, 'unknown');
  if (realModel) assert(/未知|无法|没查到|查不到|未查到|没有.{0,8}记录|不能.{0,8}(?:确认|判断)|不清楚/u.test(lastLookupText),
    'Reply must acknowledge unknown evidence');
  if (realModel) {
    const repeated = readDailyFeedback(root, dailyFeedbackQuery({broadcast: 'weather', scheduledAt: localTime(failedWeather.at)}));
    assert.deepEqual(JSON.parse(JSON.stringify(repeated.feedback)), weather.feedback);
    assert.deepEqual(JSON.parse(JSON.stringify(repeated.notification)), weather.notification);
  } else assert.deepEqual(await lookup('weather', failedWeather.at), weather);
  assert.equal(weatherRequests.length, totalWeatherRequests);
  if (!realModel) assert.equal(peer.sends.filter(send => textOfSend(send) === weatherNotice).length, 1);
  report.cases.push('An adjacent time cannot adopt the receipt and repeating the query triggers no weather or notification work');
  report.passed = true;
} catch (error) {
  report.error = redactText(String((modelError ?? error).message));
  report.failureDetails = assertionDiagnostics(error); report.blocked = failureStep === 'gateway-start';
  if (failureStep) scenarioProgress(failureStep, 'failed', report.blocked ? 'environment' : 'check');
} finally {
  scenarioProgress('fixture-cleanup', 'started', 'cleanup');
  const stop = async (resource, close) => {if (!resource) return null; try {return (await close()) !== false;} catch {return false;}};
  report.gatewayStopped = await stop(gateway, () => gateway.close());
  report.knowledgeMapStopped = await stop(km, () => km.close());
  report.peerStopped = await stop(peer, () => peer.close());
  report.modelStopped = await stop(model, () => closeHttp(model));
  report.weatherStopped = await stop(weatherApi, () => closeHttp(weatherApi));
  if ([report.gatewayStopped, report.knowledgeMapStopped, report.peerStopped, report.modelStopped, report.weatherStopped].includes(false)) {
    report.passed = false;
    report.error ??= 'Fixture service shutdown failed';
  }
  report.configSha256 = gateway?.configSha256;
  if (report.passed) {try {rmSync(root, {recursive: true, force: true});} catch {}}
  report.fixtureCleaned = !existsSync(root);
  if (!report.fixtureCleaned) {report.passed = false; report.diagnosticsRoot = root; process.exitCode = 1;}
  scenarioProgress('fixture-cleanup', report.fixtureCleaned ? 'passed' : 'failed', 'cleanup');
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
