// Disposable Gateway, loopback OneBot and local TLS SMTP. --model calls the configured paid model
// with synthetic conversation and recipients. No real QQ, email delivery or production writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {redactText} from '../../packages/observability/index.js';
import {MockSmtpServer, TEST_PASS, TEST_USER} from '../../plugins/kurumi-mail/test/helpers/mock-smtp.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {assertionDiagnostics} from '../acceptance/assertion-diagnostics.mjs';
import {configuredModel, observeToolResults, syntheticPersona} from '../acceptance/configured-dialogue.mjs';
import {captureDialogueEvidence} from '../acceptance/dialogue-evidence.mjs';
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from '../acceptance/scenario-lifecycle.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
const realModel = extra.length === 1 && extra[0] === '--model';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && (!extra.length || realModel), 'Require a new absolute --out');
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-mail-dialogue-'));
const owner = '810081', bot = '810082', token = randomBytes(24).toString('hex');
const channel = path.join(root, 'channel'), workspace = path.join(root, 'workspace');
const to = 'friend@example.test', cc = 'copy@example.test', subject = '合成邮件验收', body = '这是一封本地验收邮件。';
const report = {at: new Date().toISOString(), passed: false, cases: [], requests: 0,
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  boundary: 'Isolated Gateway, loopback OneBot and TLS SMTP; synthetic identities and recipients'};
let smtp, peer, model, gateway, upstream, active, failureStep, currentTurn;
const observeResults = observeToolResults();

function complete(response, request, message) {
  const base = {id: 'mail-fixture', created: 1, model: 'fixture'};
  const reason = message.tool_calls ? 'tool_calls' : 'stop';
  if (!request.stream) return response.setHeader('content-type', 'application/json').end(JSON.stringify({
    ...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason: reason}],
  }));
  const delta = message.tool_calls ? {...message, tool_calls: message.tool_calls.map((call, index) => ({...call, index}))} : message;
  const chunk = (value, finish) => 'data: ' + JSON.stringify({...base, object: 'chat.completion.chunk',
    choices: [{index: 0, delta: value, finish_reason: finish}]}) + '\n\n';
  response.setHeader('content-type', 'text/event-stream').end(chunk(delta, null) + chunk({}, reason) + 'data: [DONE]\n\n');
}

async function respond(req, res) {
  try {
    assert(active && ++report.requests <= 80, 'Unexpected model request');
    const request = await readFixtureJson(req);
    observeResults(request.messages ?? [], active.results);
    if (realModel) {
      const response = await fetch(upstream.url, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + upstream.key},
        signal: AbortSignal.timeout(60000), body: JSON.stringify({...request, model: upstream.modelId, max_tokens: 2000, temperature: 0})});
      if (!response.ok) throw Error('Configured model HTTP ' + response.status);
      res.writeHead(200, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
      for await (const chunk of response.body) res.write(chunk);
      return res.end();
    }
    if (active.expected) {
      const result = active.results.findLast(row => row.tool === active.expected.name);
      assert(result, 'Missing fixture tool result');
      active.expected.verify?.(result.value);
      active.expected = undefined;
    }
    const step = active.steps[active.next];
    if (!step) return complete(res, request, {role: 'assistant', content: typeof active.reply === 'function' ? active.reply() : active.reply});
    if (!active.found) {
      active.found = true;
      return complete(res, request, {role: 'assistant', content: null, tool_calls: [{id: 'search_' + report.requests,
        type: 'function', function: {name: 'tool_search', arguments: JSON.stringify({query: step.name, limit: 1})}}]});
    }
    active.found = false; active.next++; active.expected = step;
    return complete(res, request, {role: 'assistant', content: null, tool_calls: [{id: 'call_' + report.requests,
      type: 'function', function: {name: 'dispatch_action', arguments: JSON.stringify({id: step.name,
        args: typeof step.args === 'function' ? step.args() : step.args})}}]});
  } catch (error) {
    report.modelError = redactText(String(error.message));
    res.writeHead(400).end('{"error":{"message":"isolated_mail_dialogue_failed"}}');
  }
}

function mailState(draftId) {
  const db = new DatabaseSync(path.join(root, 'state/kurumi-mail/mail.sqlite'), {readOnly: true});
  try {
    const draft = db.prepare('SELECT status,message_id FROM mail_drafts WHERE draft_id=?').get(draftId);
    const audit = db.prepare('SELECT action,detail_json FROM mail_audit WHERE draft_id=? ORDER BY rowid').all(draftId)
      .map(row => ({action: row.action, detail: JSON.parse(row.detail_json)}));
    return {draft, audit};
  } finally {db.close();}
}

async function turn(label, text, steps, verify, reply = '已核对。') {
  scenarioSignal.throwIfAborted(); failureStep = label; scenarioProgress(label, 'started', 'check');
  active = {steps, next: 0, results: [], reply};
  const startedAt = Date.now(), before = peer.sends.length;
  const event = peer.message(owner, text), inbound = await peer.send(event);
  currentTurn = {startedAt, messageIds: [String(event.message_id)]};
  await waitForOneBotTurn(channel, [inbound], {timeoutMs: realModel ? 180000 : 30000, check() {
    scenarioSignal.throwIfAborted(); peer.check(); assert(!report.modelError, report.modelError);
  }});
  if (!realModel) {assert.equal(active.next, steps.length); assert(!active.expected, 'Last tool result was not observed');}
  const sends = peer.sends.slice(before);
  assert(sends.length && sends.every(send => send.accepted), 'No accepted loopback reply');
  const dialogue = captureDialogueEvidence({root, owner, startedAt, finishedAt: Date.now(), messageIds: currentTurn.messageIds});
  currentTurn.runId = dialogue.runId;
  await verify({sends, results: active.results});
  report.cases.push({label, passed: true, receiptCount: sends.length, dialogue});
  active = undefined; currentTurn = undefined; failureStep = undefined;
  scenarioProgress(label, 'passed', 'check');
}

try {
  scenarioProgress('gateway-start', 'started', 'environment'); failureStep = 'gateway-start';
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
  for (const dir of [channel, workspace, path.join(root, 'media')]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(root, 'token'), token, {mode: 0o600});
  smtp = new MockSmtpServer({rejectRecipients: [cc]});
  const smtpAddress = await smtp.start();
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});
  model = http.createServer(respond).listen(0, '127.0.0.1'); await once(model, 'listening');
  const policy = ownerPolicy(owner); policy.subjects[0].mailRecipients = [to, cc];
  const plugins = ['kurumi-qq', 'kurumi-mail', 'personal-confirmation'];
  const config = withHostControl(compileAccessConfig({
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      apiKey: 'synthetic', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', reasoning: false,
        input: ['text'], contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}]}}},
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}, heartbeat: {every: '0m'}},
      entries: {main: {workspace, model: {primary: 'fixture/fixture'}, tools: {profile: 'full',
        allow: ['email_draft', 'email_send', 'email_outbox', 'personal_confirmation'],
        deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn']}}}},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: path.join(root, 'token'),
      wsTokenFile: path.join(root, 'token'), stateDir: channel, mediaRoot: path.join(root, 'media'), testIngress: false,
      inboundDebounceMs: 200, inboundDebounceMaxWaitMs: 1000, dailySendLimit: 100, segmentDelayMs: 0}},
    plugins: {allow: plugins, load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))},
      entries: {'kurumi-qq': {enabled: true}, 'kurumi-mail': {enabled: true},
        'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}}}, slots: {memory: 'none'}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false},
    logging: {file: path.join(root, 'runtime.log')},
    tools: {codeMode: false, deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
  }, policy), repo);
  if (realModel) syntheticPersona({repo, root, config, policy, userFile: '这是一次虚构邮件场景。时区为 Asia/Shanghai。'});
  else fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Use the registered typed business tools.');
  gateway = await startIsolatedGateway({repo, root, token, configure: () => config, env: {
    NODE_EXTRA_CA_CERTS: path.join(repo, 'chatbot/plugins/kurumi-mail/test/fixtures/cert.pem'),
    KURUMI_MAIL_HOST: 'localhost', KURUMI_MAIL_PORT: String(smtpAddress.port),
    KURUMI_MAIL_USER: TEST_USER, KURUMI_MAIL_AUTH_CODE: TEST_PASS,
  }});
  await gateway.ready(); await waitForAcceptance(peer.connected, 'mail dialogue OneBot socket');
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment'); failureStep = undefined;

  let draft;
  await turn('mail-draft', `请给 ${to} 发邮件，抄送 ${cc}，主题“${subject}”，正文“${body}”。先给预览，不要发送。`, [
    {name: 'email_draft', args: {to, cc, subject, text: body}, verify(value) {draft = value;}},
  ], async ({sends, results}) => {
    draft = results.find(row => row.tool === 'email_draft' && row.value?.status === 'needs_confirmation')?.value;
    assert(draft?.draftId); assert.equal(mailState(draft.draftId).draft.status, 'pending');
    const preview = sends.map(textOfSend).join('');
    for (const value of [to, cc, subject, body]) assert(preview.includes(value), 'Draft preview omitted a frozen field');
    assert.equal(smtp.receivedCount, 0);
  }, () => draft.previewText);
  await turn('mail-question-not-confirmation', '发送前需要我做什么？我只是询问，不是确认。', [], async () => {
    assert.equal(smtp.receivedCount, 0); assert.equal(mailState(draft.draftId).draft.status, 'pending');
  }, '请确认后再发送。');
  await turn('mail-confirm-send', '确认发送刚才预览的邮件。', [
    {name: 'personal_confirmation', args: () => ({action: 'confirm', domain: 'mail', proposalId: draft.draftId, payloadHash: draft.payloadHash})},
    {name: 'email_send', args: () => ({draftId: draft.draftId})},
  ], async ({results, sends}) => {
    const sent = results.find(row => row.tool === 'email_send' && row.value?.draftId === draft.draftId)?.value;
    assert.equal(sent?.status, 'accepted'); assert.equal(sent.acceptedCount, 1); assert.equal(sent.rejectedCount, 1);
    const reply = sends.map(textOfSend).join('');
    assert(/拒|失败|未.{0,8}(?:受理|接受|送|成功)|无法.{0,8}(?:发送|投递)|部分/u.test(reply),
      'Reply must disclose the rejected recipient');
    assert.equal(smtp.receivedCount, 1); assert.deepEqual(smtp.sessions[0].rcpt, [to, cc]);
    const state = mailState(draft.draftId), audit = state.audit.find(row => row.action === 'sent');
    assert.equal(state.draft.status, 'sent'); assert.equal(state.draft.message_id, sent.messageId);
    assert.equal(audit.detail.acceptedCount, 1); assert.equal(audit.detail.rejectedCount, 1);
    report.delivery = {draftId: draft.draftId, messageId: sent.messageId, status: 'accepted', acceptedCount: 1, rejectedCount: 1};
  }, '主收件人已被服务器受理，抄送收件人被服务器拒绝。');
  await turn('mail-receipt', '请核对刚才那封邮件的发送回执，不要重复发送。', [
    {name: 'email_outbox', args: () => ({action: 'receipt', draftId: draft.draftId})},
  ], async ({results, sends}) => {
    const receipt = results.find(row => row.tool === 'email_outbox' && row.value?.draftId === draft.draftId)?.value;
    const delivery = receipt?.feedback?.find(row => row.action === 'mail.send');
    assert.equal(delivery?.status, 'accepted'); assert.equal(delivery.evidence.acceptedCount, 1);
    assert.equal(delivery.evidence.rejectedCount, 1); assert.equal(delivery.evidence.clientDelivery, 'unknown');
    assert(/拒|失败|未.{0,8}(?:受理|接受|送|成功)|无法.{0,8}(?:发送|投递)|部分/u.test(sends.map(textOfSend).join('')),
      'Receipt reply must disclose the rejected recipient');
    assert.equal(smtp.receivedCount, 1); assert.equal(smtp.sessions.length, 1);
    assert.equal(mailState(draft.draftId).audit.filter(row => row.action === 'sent').length, 1);
  }, '服务器受理了一个收件人，拒绝了一个；最终送达状态未知。');
  report.passed = true;
} catch (error) {
  report.error = report.modelError ?? redactText(String(error.message));
  report.failureDetails = assertionDiagnostics(error); report.blocked = failureStep === 'gateway-start';
  if (currentTurn && !currentTurn.runId) {
    try {currentTurn.runId = captureDialogueEvidence({root, owner, ...currentTurn, finishedAt: Date.now()}).runId;} catch {}
  }
  if (currentTurn?.runId) {
    const from = new Date(currentTurn.startedAt).toISOString(), to = new Date(Date.now() + 1000).toISOString();
    report.failureReference = {status: 'available', kind: 'log-query', runtimeRoot: root, runId: currentTurn.runId,
      messageIds: currentTurn.messageIds, command: process.execPath, args: [path.join(repo, 'chatbot/scripts/log-query.mjs'),
        '--runtime-root', root, '--from', from, '--to', to, '--run-id=' + currentTurn.runId, '--source', 'openclaw-session', '--no-text', '--json']};
  }
  if (failureStep) scenarioProgress(failureStep, 'failed', report.blocked ? 'environment' : 'check');
} finally {
  scenarioProgress('fixture-cleanup', 'started', 'cleanup');
  const stop = async (resource, close) => {if (!resource) return null; try {return (await close()) !== false;} catch {return false;}};
  report.gracefulStop = await stop(gateway, () => gateway.close());
  report.peerStopped = await stop(peer, () => peer.close());
  report.smtpStopped = await stop(smtp, () => smtp.stop());
  report.modelStopped = await stop(model, () => new Promise((resolve, reject) => {
    model.closeAllConnections(); model.close(error => error ? reject(error) : resolve(true));
  }));
  if ([report.gracefulStop, report.peerStopped, report.smtpStopped, report.modelStopped].includes(false)) {
    report.passed = false; report.error ??= 'Isolated service did not stop cleanly';
  }
  if (report.passed) {try {fs.rmSync(root, {recursive: true, force: true});} catch {}}
  report.fixtureRemoved = !fs.existsSync(root);
  if (!report.fixtureRemoved) {report.passed = false; report.diagnosticsRoot = root; process.exitCode = 1;}
  scenarioProgress('fixture-cleanup', report.fixtureRemoved ? 'passed' : 'failed', 'cleanup');
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, requests: report.requests, evidence: out}));
}
