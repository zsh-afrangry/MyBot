// Isolated Gateway, loopback OneBot, and KnowledgeMap's disposable FastAPI/SQLite.
// --model calls the configured paid model with synthetic conversations. No real QQ or production writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {redactText} from '../../packages/observability/index.js';
import {manageRemoteList} from '../../plugins/personal-reminder-list/remote.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {assertionDiagnostics} from '../acceptance/assertion-diagnostics.mjs';
import {captureDialogueEvidence} from '../acceptance/dialogue-evidence.mjs';
import {configuredModel, observeToolResults, relayConfiguredModel} from '../acceptance/configured-dialogue.mjs';
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from '../acceptance/scenario-lifecycle.mjs';
import {startIsolatedKnowledgeMap} from './isolated-api.mjs';
import {applyPersonaFile, personaFiles} from '../../../scripts/fusion/lib/persona-workspaces.mjs';

const args = process.argv.slice(2);
const outIndex = args.indexOf('--out');
const out = outIndex < 0 ? undefined : args[outIndex + 1];
const realModel = args.includes('--model');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.isAbsolute(out ?? '') && !fs.existsSync(out), 'Require a new absolute --out');
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');
assert(args.length === (realModel ? 3 : 2) && outIndex === 0, 'Invalid acceptance arguments');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-shared-dialogue-'));
const owner = '810071', bot = '810072', token = randomBytes(24).toString('hex');
const channelDir = path.join(root, 'channel'), workspace = path.join(root, 'workspace');
const report = {at: new Date().toISOString(), passed: false, cases: [], requests: 0,
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  boundary: 'Isolated Gateway, loopback OneBot and KnowledgeMap FastAPI/SQLite; synthetic identities and data'};
let km, peer, gateway, model, active, upstream, failureStep, currentTurn;
const observeResults = observeToolResults();

function decode(value) {
  for (let i = 0; i < 7; i++) {
    if (typeof value === 'string') {try {value = JSON.parse(value); continue;} catch {break;}}
    if (Array.isArray(value) && value.length === 1) {value = value[0].text; continue;}
    if (value?.result) {value = value.result; continue;}
    if (value?.content?.length === 1) {value = value.content[0].text; continue;}
    break;
  }
  return value;
}

function complete(response, request, message) {
  const base = {id: 'shared-fixture', object: 'chat.completion', created: 1, model: 'fixture'};
  const reason = message.tool_calls ? 'tool_calls' : 'stop';
  if (!request.stream) {
    response.setHeader('content-type', 'application/json');
    return response.end(JSON.stringify({...base, choices: [{index: 0, message, finish_reason: reason}]}));
  }
  const delta = message.tool_calls ? {...message, tool_calls: message.tool_calls.map((call, index) => ({...call, index}))} : message;
  const chunk = (value, finish) => 'data: ' + JSON.stringify({...base, choices: [{index: 0, delta: value, finish_reason: finish}]}) + '\n\n';
  response.setHeader('content-type', 'text/event-stream');
  response.end(chunk(delta, null) + chunk({}, reason) + 'data: [DONE]\n\n');
}

async function respond(req, res) {
  try {
    assert(active && ++report.requests <= 150, 'Unexpected model request');
    const body = await readFixtureJson(req);
    if (realModel) {
      assert(report.requests <= 80, 'Real model request budget exceeded');
      observeResults(body.messages ?? [], active.results);
      return await relayConfiguredModel(upstream, body, res);
    }
    if (active.observe) {
      const last = body.messages.findLast(message => message.role === 'tool');
      const value = decode(last?.content);
      active.results.push({tool: active.observe.name, value});
      await active.observe.verify?.(value);
      active.observe = undefined;
    }
    const step = active.steps[active.next];
    if (!step) return complete(res, body, {role: 'assistant', content: active.reply});
    if (!active.found) {
      active.found = true;
      return complete(res, body, {role: 'assistant', content: null, tool_calls: [{id: 'search_' + report.requests,
        type: 'function', function: {name: 'tool_search', arguments: JSON.stringify({query: step.name, limit: 1})}}]});
    }
    active.found = false;
    active.next++;
    active.observe = step;
    const input = typeof step.args === 'function' ? step.args() : step.args;
    return complete(res, body, {role: 'assistant', content: null, tool_calls: [{id: 'call_' + report.requests,
      type: 'function', function: {name: 'dispatch_action', arguments: JSON.stringify({id: step.name, args: input})}}]});
  } catch (error) {
    report.modelError = redactText(error.message);
    res.writeHead(400).end('{"error":{"message":"isolated_shared_dialogue_failed"}}');
  }
}

function preparePersona(config) {
  if (!realModel) {
    fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Use the registered typed business tools.');
    return;
  }
  const source = path.join(root, 'persona-source');
  const put = (file, bytes) => {
    fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o700});
    fs.writeFileSync(file, bytes, {mode: 0o600});
  };
  const {identityName, roleFile} = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
  put(path.join(source, 'config/persona.json'), JSON.stringify({identityName, roleFile,
    userFile: '这是一次虚构事项和账单场景。时区为 Asia/Shanghai。', agentsIntro: '你正在协助合成测试用户。'}));
  put(path.join(source, 'config/access-control.json'), JSON.stringify(ownerPolicy(owner)));
  put(path.join(source, 'config/runtime.config.json'), JSON.stringify(config));
  for (const file of [roleFile, 'scripts/fusion/templates/AGENTS.md']) put(path.join(source, file), fs.readFileSync(path.join(repo, file)));
  for (const [file, text] of personaFiles(source, root).files) applyPersonaFile(file, text);
}

function apiEvidence(runId) {
  const file = path.join(root, 'state/knowledgemap/trace.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
    .filter(event => event.correlation?.runId === runId)
    .map(event => ({kind: event.kind, at: event.at, method: event.data?.method, path: event.data?.path,
      status: event.data?.status, code: event.data?.code, businessId: event.correlation?.businessId}));
}

async function turn(label, text, steps, verify, reply = '已核对。') {
  scenarioSignal.throwIfAborted();
  scenarioProgress(label, 'started', 'check');
  failureStep = label;
  active = {label, steps, next: 0, found: false, results: [], reply};
  const startedAt = Date.now(), before = peer.sends.length;
  const event = peer.message(owner, text), id = await peer.send(event);
  currentTurn = {startedAt, messageIds: [String(event.message_id)]};
  await waitForOneBotTurn(channelDir, [id], {timeoutMs: realModel ? 180000 : 30000, check() {
    scenarioSignal.throwIfAborted(); peer.check(); assert(!report.modelError, report.modelError);
  }});
  if (!realModel) {
    assert.equal(active.next, steps.length);
    assert(!active.observe, 'Last tool result was not observed');
  }
  const sends = peer.sends.slice(before);
  assert(sends.length && sends.every(send => send.accepted), 'Loopback reply was not accepted');
  const evidence = captureDialogueEvidence({root, owner, startedAt, finishedAt: Date.now(), messageIds: [String(event.message_id)]});
  currentTurn.runId = evidence.runId;
  const api = apiEvidence(evidence.runId);
  await verify({sends, results: active.results, messageId: String(event.message_id), evidence, api});
  report.cases.push({label, passed: true, receiptCount: sends.length, logEvidence: evidence, apiEvidence: api});
  active = undefined;
  scenarioProgress(label, 'passed', 'check');
  failureStep = undefined;
  currentTurn = undefined;
}

const queryTask = () => ({name: 'personal_reminder_list_get', args: {}});
const queryBill = query => ({name: 'knowledge_bills_get', args: {action: 'list', query}});

try {
  scenarioProgress('gateway-start', 'started', 'environment');
  failureStep = 'gateway-start';
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
  for (const dir of [workspace, channelDir, path.join(root, 'media')]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  const tokenFile = path.join(root, 'onebot-token');
  fs.writeFileSync(tokenFile, token, {mode: 0o600});
  km = await startIsolatedKnowledgeMap(root);
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});
  model = http.createServer(respond).listen(0, '127.0.0.1');
  await once(model, 'listening');
  const plugins = ['kurumi-qq', 'personal-reminder-list', 'kurumi-knowledgemap'];
  const toolNames = ['personal_reminder_list_get', 'personal_reminder_list_manage',
    'knowledge_bills_get', 'knowledge_bill_add', 'knowledge_bill_manage'];
  const config = withHostControl(compileAccessConfig({
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      apiKey: 'synthetic', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', reasoning: false,
        input: ['text'], contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}]}}},
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}, heartbeat: {every: '0m'}},
      entries: {main: {workspace, model: {primary: 'fixture/fixture'}, tools: {profile: 'full', allow: toolNames,
        deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn']}}}},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: tokenFile,
      wsTokenFile: tokenFile, stateDir: channelDir, mediaRoot: path.join(root, 'media'), testIngress: false,
      inboundDebounceMs: 200, inboundDebounceMaxWaitMs: 1000, dailySendLimit: 100, segmentDelayMs: 0}},
    plugins: {allow: plugins, load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))},
      entries: {'kurumi-qq': {enabled: true},
        'personal-reminder-list': {enabled: true, config: {backendRoot: path.join(repo, 'chatbot'), defaultTimes: ['23:58'],
          dataSource: 'knowledgemap', bridgeBaseUrl: km.config.baseUrl, bridgeTokenFile: km.config.tokenFile}},
        'kurumi-knowledgemap': {enabled: true, config: km.config}}, slots: {memory: 'none'}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false},
    logging: {file: path.join(root, 'runtime.log')},
    tools: {codeMode: false, deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
  }, ownerPolicy(owner)), repo);
  preparePersona(config);
  gateway = await startIsolatedGateway({repo, root, token, configure: () => config});
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'OneBot socket');
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment');
  failureStep = undefined;

  await turn('task-add', '请在提醒列表新增“验收事项甲”，没有截止时间。', [
    {name: 'personal_reminder_list_manage', args: {action: 'add', title: '验收事项甲', ddl: null}},
  ], async ({api}) => {
    const rows = (await km.web('calendar-events/')).filter(row => row.title === '验收事项甲');
    assert.equal(rows.length, 1); assert.equal(rows[0].event_date, null); assert.equal(rows[0].version, 1);
    assert(api.some(row => row.method === 'POST' && row.path === '/api/assistant/tasks' && row.status === 200));
  });
  const task = (await km.web('calendar-events/')).find(row => row.title === '验收事项甲');
  await turn('task-list', '现在提醒列表里有什么？', [queryTask()], async ({sends, api}) => {
    assert(sends.some(send => textOfSend(send).includes('验收事项甲')));
    assert(api.some(row => row.method === 'GET' && row.path === '/api/assistant/tasks'));
  }, '1. 验收事项甲。');
  await turn('task-complete-reference', '把刚才那条标记完成。', [queryTask(),
    {name: 'personal_reminder_list_manage', args: {action: 'complete', id: 'km:' + task.id, expectedVersion: task.version}},
  ], async ({api}) => {
    const item = (await km.client.allTasks({history: true})).find(row => row.id === task.id);
    assert(item.completed_at); assert.equal(item.version, task.version + 1);
    assert(api.some(row => row.method === 'POST' && row.path === '/api/assistant/tasks' && row.status === 200));
  });

  for (const id of ['first', 'second']) await manageRemoteList(km.client, {action: 'add', title: '验收同名事项'},
    {sessionKey: 'synthetic-seed', messageId: 'task-ambiguity-' + id});
  const ambiguousTasks = (await km.client.allTasks()).filter(item => item.title === '验收同名事项');
  assert.equal(ambiguousTasks.length, 2);
  await turn('task-ambiguous', '把验收同名事项完成。', [queryTask()], async ({sends}) => {
    const after = (await km.client.allTasks()).filter(item => item.title === '验收同名事项');
    assert.deepEqual(after.map(item => [item.id, item.version]), ambiguousTasks.map(item => [item.id, item.version]));
    assert(sends.some(send => /哪|两|几|具体|区分|更多/u.test(textOfSend(send))), 'Expected a clarification');
  }, '有两条同名事项，请告诉我具体是哪一条。');

  if (!realModel) {
    const seeded = await manageRemoteList(km.client, {action: 'add', title: '验收并发事项'},
      {sessionKey: 'synthetic-seed', messageId: 'task-conflict'});
    const item = seeded.item, numericId = Number(item.id.slice(3));
    await turn('task-version-conflict', '把验收并发事项标记完成。', [
      {name: 'personal_reminder_list_get', args: {query: '验收并发事项'}, async verify(result) {
        assert.equal(result.items[0].version, item.version);
        await km.web(`calendar-events/${numericId}`, 'PATCH', {note: '并发修改', expected_version: item.version});
      }},
      {name: 'personal_reminder_list_manage', args: {action: 'complete', id: item.id, expectedVersion: item.version},
        verify(result) {assert.equal(result.ok, false); assert.equal(result.error.code, 'version_conflict');}},
    ], async ({api}) => {
      const actual = (await km.client.allTasks()).find(row => row.id === numericId);
      assert.equal(actual.version, item.version + 1); assert.equal(actual.completed_at, null); assert.equal(actual.note, '并发修改');
      assert(api.some(row => row.method === 'POST' && row.status === 409));
    }, '该事项已变化，请重新确认。');
  }

  await turn('bill-add', '请记一笔：2026年11月12日午饭支出14元，备注验收午饭。', [
    {name: 'knowledge_bill_add', args: {expense_date: '2026-11-12', amount: '14.00', note: '验收午饭'}},
  ], async ({api}) => {
    const rows = await km.client.request('/api/assistant/bills', {query: {query: '验收午饭'}});
    assert.equal(rows.total, 1); assert.equal(rows.items[0].amount, '14.00'); assert.equal(rows.items[0].version, 1);
    assert(api.some(row => row.method === 'POST' && row.path === '/api/assistant/bills' && row.status >= 200 && row.status < 300));
  });
  const bill = (await km.client.request('/api/assistant/bills', {query: {query: '验收午饭'}})).items[0];
  await turn('bill-monthly', '查一下2026年11月账单支出。', [
    {name: 'knowledge_bills_get', args: {action: 'monthly', year: 2026, month: 11}},
  ], async ({api}) => {
    const total = await km.client.request('/api/assistant/bills/monthly', {query: {year: 2026, month: 11}});
    assert.equal(total.expense, '14.00');
    assert(api.some(row => row.method === 'GET' && row.path === '/api/assistant/bills/monthly'));
  }, '2026年11月支出14元。');
  let updateMessageId;
  await turn('bill-update', '刚才验收午饭那笔实际是15.50元，帮我改一下。', [queryBill('验收午饭'),
    {name: 'knowledge_bill_manage', args: {action: 'update', id: bill.id, expected_version: bill.version, fields: {amount: '15.50'}}},
  ], async ({api, messageId}) => {
    const current = await km.web(`bills/${bill.id}`);
    assert.equal(current.amount, '15.50'); assert.equal(current.version, bill.version + 1);
    assert(api.some(row => row.method === 'POST' && row.path === '/api/assistant/bills/manage' && row.status === 200));
    updateMessageId = messageId;
  });
  await turn('bill-receipt', `根据原消息 ID ${updateMessageId} 核对刚才那笔账单修改结果。`, [
    {name: 'knowledge_bills_get', args: {action: 'receipt', message_id: updateMessageId}},
  ], async ({results, api}) => {
    const receipt = results.find(row => row.tool === 'knowledge_bills_get'
      && row.value?.feedback?.evidence?.sourceMessageId === updateMessageId)?.value;
    assert(receipt); assert.equal(receipt.feedback.status, 'succeeded');
    assert.equal(receipt.feedback.evidence.billId, bill.id); assert.equal(receipt.feedback.evidence.version, bill.version + 1);
    assert(api.some(row => row.method === 'GET' && row.path.includes('/receipt')));
    assert(api.every(row => row.method !== 'POST'), 'Receipt lookup must not write again');
    const current = await km.web(`bills/${bill.id}`);
    assert.equal(current.amount, '15.50'); assert.equal(current.version, bill.version + 1);
  });
  for (const [index, amount] of ['8.00', '9.00'].entries()) {
    await km.client.request('/api/assistant/bills', {method: 'POST', key: 'shared-ambiguous-bill-000' + index,
      body: {amount, expense_date: '2026-11-12', note: '验收同名账单'}});
  }
  const ambiguousBills = (await km.client.request('/api/assistant/bills', {query: {query: '验收同名账单'}})).items;
  assert.equal(ambiguousBills.length, 2);
  await turn('bill-ambiguous', '删除验收同名账单那一笔。', [queryBill('验收同名账单')], async ({sends}) => {
    const after = (await km.client.request('/api/assistant/bills', {query: {query: '验收同名账单'}})).items;
    assert.deepEqual(after.map(item => [item.id, item.version]), ambiguousBills.map(item => [item.id, item.version]));
    assert(sends.some(send => /哪|两|几|具体|区分|更多/u.test(textOfSend(send))), 'Expected a clarification');
  }, '有两笔同名账单，请告诉我具体是哪一笔。');
  report.passed = true;
} catch (error) {
  report.error = redactText(String(error.message));
  report.failureDetails = assertionDiagnostics(error);
  report.blocked = failureStep === 'gateway-start';
  report.diagnosticsRoot = root;
  if (currentTurn && !currentTurn.runId) {
    try {currentTurn.runId = captureDialogueEvidence({root, owner, ...currentTurn, finishedAt: Date.now()}).runId;} catch {}
  }
  if (currentTurn?.runId) {
    const from = new Date(currentTurn.startedAt).toISOString(), to = new Date(Date.now() + 1000).toISOString();
    report.failureReference = {status: 'available', kind: 'log-query', runtimeRoot: root,
      runId: currentTurn.runId, messageIds: currentTurn.messageIds, command: process.execPath,
      args: [path.join(repo, 'chatbot/scripts/log-query.mjs'), '--runtime-root', root, '--snowluma-root', root,
        '--from', from, '--to', to, '--run-id=' + currentTurn.runId,
        '--source', 'openclaw-session', '--source', 'knowledgemap', '--no-text', '--json']};
  }
  if (failureStep) scenarioProgress(failureStep, 'failed', report.blocked ? 'environment' : 'check');
  process.exitCode = 1;
} finally {
  scenarioProgress('fixture-cleanup', 'started', 'cleanup');
  const stop = async (resource, close) => {
    if (!resource) return null;
    try {return (await close()) !== false;} catch {return false;}
  };
  report.gracefulStop = await stop(gateway, () => gateway.close());
  report.modelStopped = await stop(model, () => new Promise((resolve, reject) => {
    model.closeAllConnections();
    model.close(error => error ? reject(error) : resolve(true));
  }));
  report.peerStopped = await stop(peer, () => peer.close());
  report.knowledgeMapStopped = await stop(km, () => km.close());
  if ([report.gracefulStop, report.modelStopped, report.peerStopped, report.knowledgeMapStopped].includes(false)) {
    report.passed = false; report.error ??= 'Isolated service did not stop gracefully'; process.exitCode = 1;
  }
  if (report.passed) {
    try {fs.rmSync(root, {recursive: true, force: true});} catch {}
    report.fixtureRemoved = !fs.existsSync(root);
    if (!report.fixtureRemoved) {report.passed = false; report.error = 'Isolated fixture was not removed'; process.exitCode = 1;}
  }
  scenarioProgress('fixture-cleanup', report.passed ? 'passed' : 'failed', 'cleanup');
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, requests: report.requests, evidence: out}));
}
