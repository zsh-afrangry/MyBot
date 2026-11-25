// Isolated Gateway and loopback OneBot with a synthetic PDF and translator.
// --model calls the configured paid chat model; no real translation API, QQ or production writes.
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {Documents, sha256} from '../../packages/documents/index.js';
import {redactText} from '../../packages/observability/index.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {assertionDiagnostics} from '../acceptance/assertion-diagnostics.mjs';
import {configuredModel, observeToolResults, syntheticPersona} from '../acceptance/configured-dialogue.mjs';
import {captureDialogueEvidence} from '../acceptance/dialogue-evidence.mjs';
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from '../acceptance/scenario-lifecycle.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
const realModel = extra.length === 1 && extra[0] === '--model';
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && (!extra.length || realModel));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-paper-dialogue-'));
const owner = '810091', bot = '810092', token = randomBytes(24).toString('hex');
const channel = path.join(root, 'channel'), workspace = path.join(root, 'workspace'), documentRoot = path.join(root, 'documents');
const docs = new Documents(documentRoot), uploads = [];
const report = {at: new Date().toISOString(), passed: false, cases: [], requests: 0,
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  boundary: 'Isolated Gateway, loopback OneBot, synthetic PDF and translator; no real QQ or translation API'};
let peer, model, gateway, upstream, active, failureStep, currentTurn;
const observeResults = observeToolResults();

function complete(response, request, message) {
  const base = {id: 'paper-fixture', created: 1, model: 'fixture'}, reason = message.tool_calls ? 'tool_calls' : 'stop';
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
    const request = await readFixtureJson(req); observeResults(request.messages ?? [], active.results);
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
      assert(result, 'Missing fixture tool result'); active.expected.verify?.(result.value); active.expected = undefined;
    }
    const step = active.steps[active.next];
    if (!step) return complete(res, request, {role: 'assistant', content: active.reply});
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
    res.writeHead(400).end('{"error":{"message":"isolated_paper_dialogue_failed"}}');
  }
}

async function turn(label, message, steps, verify, reply = '已核对。') {
  scenarioSignal.throwIfAborted(); failureStep = label; scenarioProgress(label, 'started', 'check');
  active = {steps, next: 0, results: [], reply};
  const startedAt = Date.now(), before = peer.sends.length, event = peer.message(owner, message);
  const inbound = await peer.send(event); currentTurn = {startedAt, messageIds: [String(event.message_id)]};
  await waitForOneBotTurn(channel, [inbound], {timeoutMs: realModel ? 180000 : 30000, check() {
    scenarioSignal.throwIfAborted(); peer.check(); assert(!report.modelError, report.modelError);
  }});
  if (!realModel) {assert.equal(active.next, steps.length); assert(!active.expected, 'Last tool result was not observed');}
  const sends = peer.sends.slice(before);
  assert(sends.length && sends.every(send => send.accepted), 'No accepted loopback reply');
  const dialogue = captureDialogueEvidence({root, owner, startedAt, finishedAt: Date.now(), messageIds: currentTurn.messageIds});
  currentTurn.runId = dialogue.runId;
  await verify({sends, results: active.results, event});
  report.cases.push({label, passed: true, receiptCount: sends.length, dialogue});
  active = undefined; currentTurn = undefined; failureStep = undefined;
  scenarioProgress(label, 'passed', 'check');
}

try {
  scenarioProgress('gateway-start', 'started', 'environment'); failureStep = 'gateway-start';
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
  for (const dir of [channel, workspace, path.join(root, 'media')]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(root, 'token'), token, {mode: 0o600});
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner], methods: {
    get_private_file_url(args) {
      assert.equal(String(args.user_id), owner); assert.equal(args.file_id, 'synthetic-paper-1');
      return {url: 'https://multimedia.nt.qq.com/synthetic-paper-1'};
    },
    upload_private_file(args) {
      assert.equal(String(args.user_id), owner);
      assert(path.resolve(args.file).startsWith(path.resolve(documentRoot) + path.sep));
      uploads.push({sha256: sha256(fs.readFileSync(args.file)), name: args.name});
      return {file_id: 'synthetic-upload-' + uploads.length};
    },
  }});
  model = http.createServer(respond).listen(0, '127.0.0.1'); await once(model, 'listening');
  const fixture = path.join(root, 'paper-plugin'); fs.mkdirSync(fixture);
  fs.copyFileSync(path.join(repo, 'chatbot/plugins/kurumi-papers/openclaw.plugin.json'), path.join(fixture, 'openclaw.plugin.json'));
  fs.writeFileSync(path.join(fixture, 'package.json'), JSON.stringify({name: 'kurumi-papers', type: 'module', openclaw: {extensions: ['./index.js']}}));
  const source = file => JSON.stringify(pathToFileURL(path.join(repo, file)).href);
  fs.writeFileSync(path.join(fixture, 'index.js'), `
    import fs from 'node:fs'; import path from 'node:path';
    import {createPaperPlugin} from ${source('chatbot/plugins/kurumi-papers/index.js')};
    import {PaperService} from ${source('chatbot/plugins/kurumi-papers/service.js')};
    import {pdf} from ${source('chatbot/tests/papers/fixtures.mjs')};
    export default createPaperPlugin({serviceFactory:(config,deps)=>new PaperService(config,{...deps,runner:async({work,outputKind})=>{
      const result={usage:{requests:0,fixture:true}};
      for(const kind of outputKind==='both'?['dual','mono']:[outputKind]){
        result[kind]=path.join(work,kind+'.pdf'); fs.writeFileSync(result[kind],pdf('Synthetic translated '+kind));
      } return result;
    }})});
  `);
  const preload = path.join(root, 'fetch-fixture.mjs');
  fs.writeFileSync(preload, `
    import {pdf} from ${source('chatbot/tests/papers/fixtures.mjs')};
    const original=globalThis.fetch;
    globalThis.fetch=(input,options)=>{
      const u=new URL(input instanceof Request?input.url:input);
      if(u.href==='https://multimedia.nt.qq.com/synthetic-paper-1') return Promise.resolve(new Response(pdf('Synthetic source paper.')));
      if(u.hostname==='127.0.0.1') return original(input,options);
      throw Error('Only fixture and loopback network are allowed');
    };
  `);
  const policy = ownerPolicy(owner), plugins = ['kurumi-qq', 'kurumi-papers'];
  const config = withHostControl(compileAccessConfig({
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      apiKey: 'synthetic', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', reasoning: false,
        input: ['text'], contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}]}}},
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}, heartbeat: {every: '0m'}},
      entries: {main: {workspace, model: {primary: 'fixture/fixture'}, tools: {profile: 'full',
        allow: ['kurumi_document', 'kurumi_translate', 'kurumi_document_send'],
        deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn']}}}},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: path.join(root, 'token'),
      wsTokenFile: path.join(root, 'token'), stateDir: channel, mediaRoot: path.join(root, 'media'), testIngress: false,
      inboundDebounceMs: 200, inboundDebounceMaxWaitMs: 1000, dailySendLimit: 100, segmentDelayMs: 0}},
    plugins: {allow: plugins, load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-qq'), fixture]},
      entries: {'kurumi-qq': {enabled: true}, 'kurumi-papers': {enabled: true,
        config: {root: documentRoot, python: '/unused', credentialsFile: '/unused', liveTranslationEnabled: true}}}, slots: {memory: 'none'}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false},
    logging: {file: path.join(root, 'runtime.log')},
    tools: {codeMode: false, deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
  }, policy), repo);
  if (realModel) syntheticPersona({repo, root, config, policy, userFile: '这是一次虚构论文和文件场景。时区为 Asia/Shanghai。'});
  else fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Use the registered typed business tools.');
  gateway = await startIsolatedGateway({repo, root, token, configure: () => config, preload});
  await gateway.ready(); await waitForAcceptance(peer.connected, 'paper dialogue OneBot socket');
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment'); failureStep = undefined;

  let jobId, sourceId;
  await turn('paper-file-and-start', [
    {type: 'text', data: {text: '请把这次上传的验收论文翻译成中文，只要双语 PDF，完成后发给我。'}},
    {type: 'file', data: {name: '验收论文.pdf', file_id: 'synthetic-paper-1'}},
  ], [{name: 'kurumi_translate', args: () => ({action: 'start', documentId: docs.list({kind: 'input'})[0].id, output: 'dual', delivery: 'qq'})}],
  async ({results}) => {
    const input = docs.list({kind: 'input'}); assert.equal(input.length, 1);
    assert.equal(input[0].source.type, 'qq'); assert.equal(input[0].source.fileId, 'synthetic-paper-1'); sourceId = input[0].id;
    const started = results.find(row => row.tool === 'kurumi_translate' && row.value?.job?.documentId === sourceId)?.value;
    assert(started?.ok && started.job.id); jobId = started.job.id;
  }, '已启动后台翻译任务，完成后会投递。');

  failureStep = 'paper-background-delivery'; scenarioProgress(failureStep, 'started', 'check');
  const job = await waitForAcceptance(() => {
    peer.check();
    const file = path.join(documentRoot, 'jobs', jobId + '.json');
    if (!fs.existsSync(file)) return;
    const value = JSON.parse(fs.readFileSync(file));
    if (value.status === 'failed') throw Error('Synthetic translation task failed');
    return value.status === 'succeeded' && value.delivery?.status === 'platform_accepted' ? value : undefined;
  }, 'synthetic translation and loopback upload', {timeoutMs: 45000, pollMs: 100});
  assert.equal(job.documentId, sourceId); assert.equal(job.deliveryKind, 'dual');
  assert.deepEqual(Object.keys(job.artifacts), ['dual']); assert.equal(uploads.length, 1);
  const artifact = docs.describe(job.artifacts.dual);
  assert.equal(artifact.source.inputId, sourceId); assert.equal(artifact.sha256, uploads[0].sha256);
  assert.equal(job.delivery.receipts[0].documentId, artifact.id);
  report.job = {jobId, sourceId, artifactId: artifact.id, status: job.status, delivery: job.delivery.status,
    fixtureTranslator: true, uploadCount: uploads.length};
  report.cases.push({label: failureStep, passed: true}); scenarioProgress(failureStep, 'passed', 'check'); failureStep = undefined;

  await turn('paper-result-lookup', '请核对刚才那篇论文的翻译任务和文件投递结果，不要重新翻译或发送。', [
    {name: 'kurumi_translate', args: {action: 'status', jobId}},
  ], async ({results}) => {
    const status = results.find(row => row.tool === 'kurumi_translate' && row.value?.job?.id === jobId)?.value;
    assert(status?.ok); assert.equal(status.job.status, 'succeeded');
    const upload = status.job.feedback?.find(row => row.action === 'paper.qq_upload' && row.evidence.documentId === artifact.id);
    assert.equal(upload?.status, 'accepted'); assert.equal(uploads.length, 1);
  });
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
  report.modelStopped = await stop(model, () => new Promise((resolve, reject) => {
    model.closeAllConnections(); model.close(error => error ? reject(error) : resolve(true));
  }));
  if ([report.gracefulStop, report.peerStopped, report.modelStopped].includes(false)) {
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
