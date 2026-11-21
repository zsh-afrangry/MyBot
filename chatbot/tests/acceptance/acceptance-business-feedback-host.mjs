// Disposable OpenClaw, deterministic cognition and loopback OneBot only.
// Runs real domain tools and renders fixture E7 cards, or confirms and reads a temporary Profile/Planning SQLite database.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import {existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:http';
import {tmpdir} from 'node:os';
import {isAbsolute, join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {bodies} from '../e7/fixtures.mjs';
import {E7Service} from '../../plugins/kurumi-e7/service.js';
import {startIsolatedGateway} from './isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from './onebot-peer.mjs';

const [flag, out, scenario, ...extra] = process.argv.slice(2);
assert(flag === '--out' && isAbsolute(out ?? '') && !existsSync(out) && ['image', 'profile-planning'].includes(scenario) && !extra.length);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = mkdtempSync(join(tmpdir(), 'kurumi-business-feedback-'));
const owner = '810061', bot = '810062', token = randomBytes(24).toString('hex');
const channelDir = join(root, 'channel'), workspace = join(root, 'workspace'), tokenFile = join(root, 'token');
const report = {passed: false, cases: [], primaryModel: 'fixture/fixture',
  boundary: 'Isolated OpenClaw, deterministic model, loopback OneBot and temporary domain data'};
let peer, model, gateway, active, fault, imageResponse;
let calls = 0;
const isImage = send => send.message.some(segment => segment.type === 'image');
const check = () => {peer.check(); if (fault) throw fault;};

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
    assert(active && ++calls <= 70, 'Unexpected fixture model request');
    let body = '';
    for await (const part of req) body += part;
    const request = JSON.parse(body);
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
  const event = peer.message(owner, message);
  const before = peer.sends.length;
  active = {steps, answer, next: 0, results: []};
  const id = await peer.send(event);
  await waitForOneBotTurn(channelDir, [id], {check, timeoutMs: 20000});
  assert.equal(active.results.length, steps.length);
  return {id: String(event.message_id), results: active.results, sends: peer.sends.slice(before)};
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
    assert(sends.some(send => send.accepted && textOfSend(send).includes(savedText(results[1]))));
    return results[1];
  }
  async function lookup(domain, proposal) {
    const {results} = await turn('核对这次确认对应的记录。', [[domain + '_state_get', {proposal_id: proposal.proposalId}]]);
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

  const departure = new Date(Math.ceil((Date.now() + 86400000) / 60000) * 60000).toISOString();
  const itinerary = await propose(planning, '请登记明天去苏州的火车行程。', {kind: 'trip.create', title: '苏州行',
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
  assert.equal((await lookup(profile, itinerary)).error.code, 'proposal_not_found');
  assert.deepEqual(facts(), afterTrip);
  report.cases.push('A future trip is confirmed and read by proposal with its destination, dates and unchanged current location');

  const latest = await propose(profile, '我已经到南京了，请更新所在地。', location('南京'));
  await confirm(profile, 'personal_profile', latest);
  const beforeHistory = facts();
  const historical = await lookup(profile, first);
  assert.deepEqual(historical.feedback, firstReceipt.feedback);
  assert.equal(historical.currentLocation, '南京');
  assert.equal(historical.matchesCurrentLocation, false);
  const replay = await turn('核对原所在地提案的再次提交。', [[profile + '_change_commit', params(first)]]);
  assert.equal(replay.results[0].idempotent, true);
  assert.deepEqual(replay.results[0].feedback, firstReceipt.feedback);
  assert.deepEqual(facts(), beforeHistory);
  report.cases.push('Later location changes and replay preserve the first actual saved location');
}

try {
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
  const entries = {'kurumi-qq': {enabled: true}, ...(image ? {
    'kurumi-e7': {enabled: true, config: {cacheRoot, refreshEnabled: false}},
    'kurumi-logs': {enabled: true, config: {backendRoot: repo, runtimeRoot: root, snowlumaRoot: root}},
  } : {
    'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}},
    'personal-profile': {enabled: true, config: {locationCatalog}},
    'personal-planning': {enabled: true},
  })};
  const plugins = Object.keys(entries);
  const tools = image ? ['e7_image', 'kurumi_logs'] : ['personal_confirmation',
    ...['personal_profile', 'personal_planning'].flatMap(domain => ['state_get', 'change_propose', 'change_commit'].map(name => domain + '_' + name))];
  const cfg = withHostControl(compileAccessConfig({
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'},
      heartbeat: {every: '0m'}, model: {primary: 'fixture/fixture'}}, entries: {main: {workspace, tools: {allow: tools}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://127.0.0.1:' + model.address().port + '/v1',
      apiKey: 'fixture', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', contextWindow: 64000, maxTokens: 1200}]}}},
    plugins: {allow: plugins, load: {paths: plugins.map(id => join(repo, 'chatbot/plugins', id))},
      slots: {memory: 'none'}, entries},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: channelDir, mediaRoot: join(root, 'media'), segmentDelayMs: 0, inboundDebounceMs: 200, testIngress: false}},
    tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false}, logging: {file: join(root, 'runtime.log')},
  }, ownerPolicy(owner)), repo);
  gateway = await startIsolatedGateway({repo, root, token, configure: () => cfg, preload: limitFixtureFetch()});
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'OneBot connection');
  await (image ? acceptImages() : acceptProfilePlanning());
  report.passed = true;
} catch (error) {
  report.error = (fault ?? error).stack;
} finally {
  if (await gateway?.close() === false) {report.passed = false; report.error ??= 'Gateway shutdown failed';}
  model?.closeAllConnections();
  await Promise.all([peer?.close(), model && new Promise(resolve => model.close(resolve))]);
  report.configSha256 = gateway?.configSha256;
  if (report.passed) rmSync(root, {recursive: true, force: true});
  else {report.diagnosticsRoot = root; process.exitCode = 1;}
  report.fixtureCleaned = !existsSync(root);
  writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
}
