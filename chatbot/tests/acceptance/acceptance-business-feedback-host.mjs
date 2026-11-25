// Disposable OpenClaw and loopback OneBot. --model calls the configured paid model
// with synthetic profile/planning/weather data; no real QQ or production writes.
// Runs real domain tools and renders fixture E7 cards, or confirms and reads a temporary Profile/Planning SQLite database.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from './fixture-model.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {isAbsolute, join, resolve, sep} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {redactText} from '../../packages/observability/index.js';
import {currentFixture, dailyFixture, hourlyFixture, alertFixture} from '../../packages/personal-domains/dist/test-fixtures.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {bodies} from '../e7/fixtures.mjs';
import {E7Service} from '../../plugins/kurumi-e7/service.js';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {configuredModel, observeToolResults, syntheticPersona} from './configured-dialogue.mjs';
import {captureDialogueEvidence} from './dialogue-evidence.mjs';
import {assertionDiagnostics} from './assertion-diagnostics.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from './onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from './scenario-lifecycle.mjs';

const [flag, out, scenario, ...extra] = process.argv.slice(2);
const realModel = scenario === 'profile-planning' && extra.length === 1 && extra[0] === '--model';
assert(flag === '--out' && isAbsolute(out ?? '') && !existsSync(out) && ['image', 'profile-planning'].includes(scenario) && (!extra.length || realModel));
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(resolve(out).startsWith(resolve(repo, 'test-output') + sep), 'Use test-output for evidence');
const root = mkdtempSync(join(tmpdir(), 'kurumi-business-feedback-'));
const owner = '810061', bot = '810062', token = randomBytes(24).toString('hex');
const channelDir = join(root, 'channel'), workspace = join(root, 'workspace'), tokenFile = join(root, 'token');
const report = {passed: false, cases: [], turns: [], primaryModel: 'fixture/fixture',
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  boundary: 'Isolated OpenClaw, loopback OneBot, synthetic weather and temporary domain data'};
let peer, model, gateway, weatherApi, upstream, active, fault, imageResponse, currentTurn, failureStep;
const weatherRequests = [], observeResults = observeToolResults();
let calls = 0;
const isImage = send => send.message.some(segment => segment.type === 'image');
const check = () => {scenarioSignal.throwIfAborted(); peer.check(); if (fault) throw fault;};

function resultFrom(message) {
  const text = typeof message.content === 'string' ? message.content : message.content.map(part => part.text).join('');
  if (text.includes('EXTERNAL_UNTRUSTED_CONTENT')) {
    const start = text.indexOf('{"status":"ok"');
    assert(start >= 0, 'Missing authorized log result');
    return JSON.parse(text.slice(start, text.lastIndexOf('}') + 1));
  }
  return JSON.parse(text);
}

function complete(request, response, message) {
  const base = {id: 'fixture-' + calls, created: 1, model: 'fixture'};
  const stop = message.tool_calls ? 'tool_calls' : 'stop';
  if (!request.stream) return response.setHeader('content-type', 'application/json').end(JSON.stringify({
    ...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason: stop}],
  }));
  if (message.tool_calls) message.tool_calls[0].index = 0;
  const chunk = (delta, finish_reason) => 'data: ' + JSON.stringify({
    ...base, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}],
  }) + '\n\n';
  response.setHeader('content-type', 'text/event-stream').end(chunk(message, null) + chunk({}, stop) + 'data: [DONE]\n\n');
}

async function respond(req, res) {
  try {
    assert(active && ++calls <= 150, 'Unexpected model request');
    const request = await readFixtureJson(req);
    if (realModel) {
      observeResults(request.messages ?? [], active.observed);
      const response = await fetch(upstream.url, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + upstream.key},
        signal: AbortSignal.timeout(60000), body: JSON.stringify({...request, model: upstream.modelId, max_tokens: 2000, temperature: 0})});
      if (!response.ok) throw Error('Configured model HTTP ' + response.status);
      res.writeHead(200, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
      for await (const chunk of response.body) res.write(chunk);
      return res.end();
    }
    if (active.expected) {
      const last = request.messages.findLast(message => message.role === 'tool');
      assert(last, 'The host did not return the current tool result');
      const result = resultFrom(last);
      active.results.push(result);
      active.expected.verify?.(result);
      active.expected = undefined;
    }
    const step = active.steps[active.next++];
    if (!step) return complete(request, res, {role: 'assistant', content: active.answer(active.results)});
    const [name, args, verify] = step;
    assert(request.tools.some(tool => tool.function.name === name), 'Missing tool ' + name);
    const id = 'call_fixture_' + calls;
    active.expected = {verify};
    complete(request, res, {role: 'assistant', content: null,
      tool_calls: [{id, type: 'function', function: {name, arguments: JSON.stringify(args)}}]});
  } catch (error) {
    fault ??= error;
    res.writeHead(400).end('{"error":{"message":"isolated feedback fixture failed"}}');
  }
}

async function turn(message, steps, answer = () => '已经核对。') {
  scenarioSignal.throwIfAborted();
  failureStep = 'dialogue-turn-' + (report.turns.length + 1);
  scenarioProgress(failureStep, 'started', 'check');
  const startedAt = Date.now();
  const event = peer.message(owner, message);
  const before = peer.sends.length;
  active = {steps, answer, next: 0, results: [], observed: []};
  const id = await peer.send(event);
  currentTurn = {startedAt, messageIds: [String(event.message_id)]};
  await waitForOneBotTurn(channelDir, [id], {check, timeoutMs: realModel ? 180000 : 20000});
  const sends = peer.sends.slice(before);
  assert(sends.length && sends.every(send => send.accepted), 'No accepted loopback reply');
  const results = realModel ? steps.map(([name]) => {
    const row = active.observed.findLast(result => result.tool === name);
    assert(row, 'Missing expected ' + name + ' result');
    return row.value;
  }) : active.results;
  assert.equal(results.length, steps.length);
  const dialogue = captureDialogueEvidence({root, owner, startedAt, finishedAt: Date.now(), messageIds: currentTurn.messageIds});
  currentTurn.runId = dialogue.runId;
  report.turns.push({label: failureStep, dialogue});
  scenarioProgress(failureStep, 'passed', 'check');
  return {id: String(event.message_id), results, sends};
}

async function seedE7(cacheRoot) {
  const fixture = bodies();
  delete fixture.hero.avatarUrl;
  delete fixture.hero.detailImageUrl;
  const service = new E7Service({cacheRoot, refreshEnabled: false}, {client: {async read(kind) {
    assert(Object.hasOwn(fixture, kind));
    return {status: 200, data: structuredClone(fixture[kind])};
  }}});
  try {
    await service.resource('cards');
    for (const kind of ['hero', 'builds']) await service.resource(kind, {heroCode: 'test-hero-1'});
  } finally {await service.stop();}
}

function limitFixtureFetch() {
  const file = join(root, 'fixture-fetch.mjs');
  writeFileSync(file, `
    const loopback = globalThis.fetch;
    globalThis.fetch = (input, options) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.origin !== 'http://127.0.0.1:' + url.port) throw Error('Only loopback is allowed in the fixture');
      return loopback(input, options);
    };
  `);
  return file;
}

async function acceptImages() {
  const args = {heroCode: 'test-hero-1', kind: 'build_card'};
  const imageCall = (verify, extra = {}) => ['e7_image', {...args, ...extra}, verify];
  const images = () => peer.sends.filter(isImage);
  async function lookup(id, imageStatus, platformStatus) {
    const {results} = await turn('请核对这条发图请求的结果。', [['kurumi_logs',
      {view: 'events', sources: ['channel-delivery'], kind: 'qq.image_feedback', messageId: id, noText: true},
    ]]);
    assert.equal(results[0].total, 1);
    const [event] = results[0].events;
    assert.equal(event.correlation.qqMessageId, id);
    assert.equal(event.correlation.recipientId, owner);
    assert.equal(event.data.imageStatus, imageStatus);
    assert.equal(event.data.notification.platformStatus, platformStatus);
    assert.equal(event.data.notification.clientDelivery, 'unknown');
    return event.data;
  }
  const empty = await turn('发一张测试甲速度大于一千的配装图。', [imageCall(result => {
    assert.equal(result.error.code, 'no_build_samples');
    assert.equal(result.feedback?.status, 'skipped');
  }, {filters: {minStats: {spd: 1000}}})]);
  assert.equal((await lookup(empty.id, 'no_results', 'not_attempted')).feedback.evidence.code, 'no_build_samples');
  assert.equal(images().length, 0);
  report.cases.push('Zero matching builds yields a request receipt and no OneBot image sends');

  const sent = await turn('发一张测试甲的一套配装图。', [
    imageCall(result => assert.equal(result.status, 'sent')),
    imageCall(result => assert.equal(result.status, 'already_sent'), {kind: 'hero_card'}),
  ]);
  assert.equal(sent.results[0].messageId, sent.results[1].messageId);
  const [physical] = images();
  assert(physical?.accepted);
  assert.equal(String(physical.user_id), owner);
  const dataUrl = physical.message.find(segment => segment.type === 'image').data.file;
  assert.equal(Buffer.from(dataUrl.slice('base64://'.length), 'base64').subarray(0, 8).toString('hex'), '89504e470d0a1a0a');
  const accepted = await lookup(sent.id, 'generated', 'accepted');
  assert.equal(accepted.notification.messageId, physical.messageId);
  assert.equal(accepted.feedback.action, 'e7.image');
  assert.equal(accepted.feedback.evidence.kind, 'build_card');
  assert.deepEqual(await lookup(sent.id, 'generated', 'accepted'), accepted);
  assert.equal(images().length, 1);
  report.cases.push('A rendered E7 card is accepted once and repeated owner queries return that same receipt');

  imageResponse = 'lose-receipt';
  const lost = await turn('再发一张测试甲的配装图。', [imageCall(result => {
    assert.equal(result.feedback?.status, 'succeeded');
    assert.equal(result.notification.platformStatus, 'unknown');
  })]);
  assert.equal((await lookup(lost.id, 'generated', 'unknown')).notification.messageId, undefined);
  assert.equal(images().length, 2);
  report.cases.push('A lost response retains generation evidence and an unknown platform receipt');
}

async function acceptProfilePlanning() {
  const file = join(root, 'state', 'personal-weather', 'weather.sqlite');
  const facts = () => {
    const db = new DatabaseSync(file, {readOnly: true});
    try {
      const count = table => db.prepare('SELECT count(*) AS count FROM ' + table).get().count;
      return {trips: count('trips'), grants: count('approval_grants'), changes: count('audit_log'),
        location: db.prepare('SELECT place_id,revision FROM profile_current_location').get(),
        locationPeriods: count('location_periods')};
    } finally {db.close();}
  };
  async function propose(domain, message, request) {
    const {results, sends} = await turn(message, [[domain + '_change_propose', {schema_version: 1, request},
      result => assert.equal(result.status, 'pending')]], ([result]) => result.previewText);
    assert(sends.some(send => send.accepted && textOfSend(send).includes('提案确认截止')));
    return results[0];
  }
  const params = proposal => ({proposal_id: proposal.proposalId, payload_hash: proposal.payloadHash});
  async function confirm(domain, confirmationDomain, proposal) {
    const savedText = result => '已保存：' + (result.feedback.evidence.savedLocation ?? result.feedback.evidence.destination);
    const {results, sends} = await turn('确认', [
      ['personal_confirmation', {action: 'confirm', domain: confirmationDomain, proposalId: proposal.proposalId, payloadHash: proposal.payloadHash},
        result => assert.equal(result.ok, true, JSON.stringify(result))],
      [domain + '_change_commit', params(proposal), result => {
        assert.equal(result.status, 'committed');
        assert.equal(result.feedback?.status, 'succeeded');
      }],
    ], ([, result]) => savedText(result));
    const savedValue = results[1].feedback.evidence.savedLocation ?? results[1].feedback.evidence.destination;
    assert(sends.some(send => send.accepted && textOfSend(send).includes(realModel ? savedValue : savedText(results[1]))));
    return results[1];
  }
  async function lookup(domain, proposal, description = '刚才的提案') {
    const {results} = await turn(`请按原提案核对${description}的记录。`, [[domain + '_state_get', {proposal_id: proposal.proposalId}]]);
    return results[0];
  }

  const profile = 'personal_profile', planning = 'personal_planning';
  const location = city => ({kind: 'current_location.set', location: {text: city}});
  const first = await propose(profile, '我已经到杭州了，请更新所在地。', location('杭州'));
  const pending = facts();
  assert.equal((await lookup(profile, first)).feedback.status, 'pending_confirmation');
  assert.deepEqual(facts(), pending);
  const saved = await confirm(profile, 'personal_profile', first);
  assert.equal(saved.feedback.evidence.savedLocation, '杭州');
  const firstReceipt = await lookup(profile, first);
  assert.deepEqual(firstReceipt.feedback, saved.feedback);
  assert.equal(firstReceipt.matchesCurrentLocation, true);
  assert.equal(firstReceipt.currentLocation, '杭州');
  const afterLocation = facts();
  assert.equal(afterLocation.location.revision, pending.location.revision + 1);
  report.cases.push('A location proposal is read-only before confirmation and returns the committed location afterwards');

  const weather = await turn('我现在所在地天气怎么样？请说明数据来源和查询时间。', [
    ['personal_weather_get_brief', {}, result => assert.equal(result.ok, true)],
  ], ([result]) => result.formattedText);
  const brief = weather.results[0].brief;
  assert.equal(brief.location.shortName, '杭州');
  assert.equal(brief.current.temperature.value, currentFixture.temperature.value);
  assert.equal(brief.quality.current.state, 'fresh');
  assert(brief.attributions.length && Math.abs(Date.now() - Date.parse(brief.quality.current.fetchedAt)) < 60000);
  assert.equal(weatherRequests.length, 4);
  assert(weatherRequests.every(row => row.latitude === '30' && row.longitude === '120'));
  const weatherReply = weather.sends.map(textOfSend).join('');
  assert(weatherReply.includes('杭州') && /31\.7|32/u.test(weatherReply));
  assert(/来源|数据|天气/u.test(weatherReply) && /查询|时间|时|日期/u.test(weatherReply));
  assert.deepEqual(facts(), afterLocation);
  report.cases.push('Weather without a location uses the confirmed location and reports source and freshness');

  const day = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', dateStyle: 'short'}).format(Date.now() + 2 * 86400000);
  const departure = new Date(day + 'T10:30:00+08:00').toISOString();
  const itinerary = await propose(planning, `请登记${day}上午10点30分去苏州的火车行程。`, {kind: 'trip.create', title: '苏州行',
    destination: {text: '苏州'}, transport_mode: 'rail',
    departure: {earliest: departure, latest: departure, precision: 'exact', timezone: 'Asia/Shanghai'},
  });
  assert.equal(facts().trips, 0);
  const committed = await confirm(planning, 'planning', itinerary);
  const afterTrip = facts();
  const receipt = await lookup(planning, itinerary);
  assert.deepEqual(receipt.feedback, committed.feedback);
  assert.equal(receipt.trip.state, 'planned');
  assert.equal(receipt.trip.destinationText, '苏州');
  assert.equal(Date.parse(receipt.trip.displayTimes.departureEarliest), Date.parse(departure));
  assert.equal(receipt.currentLocation, '杭州');
  assert.deepEqual(afterTrip.location, afterLocation.location);
  assert.equal(afterTrip.trips, 1);
  assert.equal(afterTrip.locationPeriods, pending.locationPeriods);
  if (!realModel) assert.equal((await lookup(profile, itinerary)).error.code, 'proposal_not_found');
  assert.deepEqual(facts(), afterTrip);
  report.cases.push('A future trip is confirmed and read by proposal with its destination, dates and unchanged current location');

  const latest = await propose(profile, '我已经到南京了，请更新所在地。', location('南京'));
  await confirm(profile, 'personal_profile', latest);
  const beforeHistory = facts();
  const historical = await lookup(profile, first, '最初的杭州所在地变更');
  assert.deepEqual(historical.feedback, firstReceipt.feedback);
  assert.equal(historical.currentLocation, '南京');
  assert.equal(historical.matchesCurrentLocation, false);
  if (!realModel) {
    const replay = await turn('核对原所在地提案的再次提交。', [[profile + '_change_commit', params(first)]]);
    assert.equal(replay.results[0].idempotent, true);
    assert.deepEqual(replay.results[0].feedback, firstReceipt.feedback);
  }
  assert.deepEqual(facts(), beforeHistory);
  report.cases.push('Later location changes and replay preserve the first actual saved location');
}

try {
  scenarioProgress('gateway-start', 'started', 'environment'); failureStep = 'gateway-start';
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
  mkdirSync(workspace);
  writeFileSync(tokenFile, token, {mode: 0o600});
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner], reply: send => isImage(send) ? imageResponse : undefined});
  model = createServer(respond).listen(0, '127.0.0.1');
  await once(model, 'listening');
  const image = scenario === 'image';
  const cacheRoot = join(root, 'e7-cache');
  if (image) await seedE7(cacheRoot);
  const locationCatalog = ['杭州', '南京'].map((name, index) => ({id: 'fixture-' + index, name,
    countryCode: 'CN', latitude: 30 + index, longitude: 120 - index, timezone: 'Asia/Shanghai', precision: 'city'}));
  if (!image) {
    const today = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', dateStyle: 'short'}).format(Date.now());
    const tomorrow = new Intl.DateTimeFormat('sv-SE', {timeZone: 'Asia/Shanghai', dateStyle: 'short'}).format(Date.now() + 86400000);
    const daily = structuredClone(dailyFixture), hourly = structuredClone(hourlyFixture), alerts = structuredClone(alertFixture);
    Object.assign(daily.days[0], {forecastStartTime: today + 'T00:00+08:00', forecastEndTime: tomorrow + 'T00:00+08:00'});
    Object.assign(daily.days[0].daytime, {forecastStartTime: today + 'T07:00+08:00', forecastEndTime: today + 'T19:00+08:00'});
    Object.assign(daily.days[0].nighttime, {forecastStartTime: today + 'T19:00+08:00', forecastEndTime: tomorrow + 'T07:00+08:00'});
    hourly.hours[0].forecastTime = new Date(Date.now() + 3600000).toISOString();
    alerts.metadata.zeroResult = true; alerts.alerts = [];
    const responses = {current: currentFixture, daily, hourly, alerts};
    weatherApi = createServer((req, res) => {
      const url = new URL(req.url, 'http://127.0.0.1'), component = url.pathname.split('/').at(-1);
      if (req.method !== 'GET' || req.headers.authorization !== 'Bearer ' + token
        || !url.pathname.startsWith('/api/assistant/weather/') || !Object.hasOwn(responses, component)) return res.writeHead(400).end();
      weatherRequests.push({component, latitude: url.searchParams.get('latitude'), longitude: url.searchParams.get('longitude')});
      res.setHeader('content-type', 'application/json').end(JSON.stringify(responses[component]));
    }).listen(0, '127.0.0.1');
    await once(weatherApi, 'listening');
  }
  const entries = {'kurumi-qq': {enabled: true}, ...(image ? {
    'kurumi-e7': {enabled: true, config: {cacheRoot, refreshEnabled: false}},
    'kurumi-logs': {enabled: true, config: {backendRoot: repo, runtimeRoot: root, snowlumaRoot: root}},
  } : {
    'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}},
    'personal-profile': {enabled: true, config: {locationCatalog}},
    'personal-planning': {enabled: true},
    'personal-weather': {enabled: true, config: {weatherBackend: 'knowledgemap', bridgeBaseUrl: 'http://127.0.0.1:' + weatherApi.address().port,
      bridgeTokenFile: tokenFile, apiHost: 'fixture.invalid', apiKey: 'fixture'}},
  })};
  const plugins = Object.keys(entries);
  const tools = image ? ['e7_image', 'kurumi_logs'] : ['personal_confirmation',
    'personal_weather_get_brief', ...['personal_profile', 'personal_planning'].flatMap(domain => ['state_get', 'change_propose', 'change_commit'].map(name => domain + '_' + name))];
  const cfg = withHostControl(compileAccessConfig({
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'},
      heartbeat: {every: '0m'}, model: {primary: 'fixture/fixture'}}, entries: {main: {workspace, tools: {allow: tools}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
      apiKey: 'fixture', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}]}}},
    plugins: {allow: plugins, load: {paths: plugins.map(id => join(repo, 'chatbot/plugins', id))},
      slots: {memory: 'none'}, entries},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: channelDir, mediaRoot: join(root, 'media'), segmentDelayMs: 0, inboundDebounceMs: 200, testIngress: false}},
    tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false}, logging: {file: join(root, 'runtime.log')},
  }, ownerPolicy(owner)), repo);
  if (realModel) syntheticPersona({repo, root, config: cfg, policy: ownerPolicy(owner),
    userFile: '这是一次虚构地点、行程和天气场景。时区为 Asia/Shanghai。'});
  gateway = await startIsolatedGateway({repo, root, token, configure: () => cfg, preload: limitFixtureFetch()});
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'OneBot connection');
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment'); failureStep = undefined;
  await (image ? acceptImages() : acceptProfilePlanning());
  report.passed = true;
} catch (error) {
  report.error = redactText(String((fault ?? error).message));
  report.failureDetails = assertionDiagnostics(error); report.blocked = failureStep === 'gateway-start';
  if (currentTurn && !currentTurn.runId) {
    try {currentTurn.runId = captureDialogueEvidence({root, owner, ...currentTurn, finishedAt: Date.now()}).runId;} catch {}
  }
  if (currentTurn?.runId) {
    const from = new Date(currentTurn.startedAt).toISOString(), to = new Date(Date.now() + 1000).toISOString();
    report.failureReference = {status: 'available', kind: 'log-query', runtimeRoot: root, runId: currentTurn.runId,
      messageIds: currentTurn.messageIds, command: process.execPath, args: [join(repo, 'chatbot/scripts/log-query.mjs'),
        '--runtime-root', root, '--from', from, '--to', to, '--run-id=' + currentTurn.runId,
        '--source', 'openclaw-session', '--no-text', '--json']};
  }
  if (failureStep) scenarioProgress(failureStep, 'failed', report.blocked ? 'environment' : 'check');
} finally {
  scenarioProgress('fixture-cleanup', 'started', 'cleanup');
  const stop = async (resource, close) => {if (!resource) return null; try {return (await close()) !== false;} catch {return false;}};
  const closeServer = server => new Promise((resolve, reject) => {
    server.closeAllConnections(); server.close(error => error ? reject(error) : resolve(true));
  });
  report.gatewayStopped = await stop(gateway, () => gateway.close());
  report.peerStopped = await stop(peer, () => peer.close());
  report.modelStopped = await stop(model, () => closeServer(model));
  report.weatherStopped = await stop(weatherApi, () => closeServer(weatherApi));
  if ([report.gatewayStopped, report.peerStopped, report.modelStopped, report.weatherStopped].includes(false)) {
    report.passed = false; report.error ??= 'Isolated service did not stop cleanly';
  }
  report.configSha256 = gateway?.configSha256;
  if (report.passed) {try {rmSync(root, {recursive: true, force: true});} catch {}}
  report.fixtureCleaned = !existsSync(root);
  if (!report.fixtureCleaned) {report.passed = false; report.diagnosticsRoot = root; process.exitCode = 1;}
  scenarioProgress('fixture-cleanup', report.fixtureCleaned ? 'passed' : 'failed', 'cleanup');
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
