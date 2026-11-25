// Isolated Gateway and loopback OneBot. Default uses synthetic Tavily and page responses.
// --model calls the configured paid model; --live also calls the configured Tavily provider
// and a public IANA page. No QQ or production-state writes.
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
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {assertionDiagnostics} from '../acceptance/assertion-diagnostics.mjs';
import {configuredModel, observedToolCall, observeToolResults, syntheticPersona} from '../acceptance/configured-dialogue.mjs';
import {captureDialogueEvidence} from '../acceptance/dialogue-evidence.mjs';
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress, scenarioSignal} from '../acceptance/scenario-lifecycle.mjs';

const args = process.argv.slice(2), out = args[1], realModel = args.includes('--model'), live = args.includes('--live');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(args[0] === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out));
assert(args.length === 2 + Number(realModel) + Number(live) && (!live || realModel));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-search-dialogue-'));
const owner = '810101', bot = '810102', token = randomBytes(24).toString('hex');
const channel = path.join(root, 'channel'), workspace = path.join(root, 'workspace');
const sourceUrl = 'https://example.com/kurumi-acceptance';
const report = {at: new Date().toISOString(), passed: false, cases: [], requests: 0,
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  boundary: live ? 'Isolated Gateway and loopback OneBot; real Tavily search and public IANA page' :
    'Isolated Gateway, loopback OneBot, synthetic Tavily and public-page responses'};
let peer, model, gateway, upstream, active, failureStep, currentTurn;
const observeResults = observeToolResults();

function complete(response, request, message) {
  const base = {id: 'search-fixture', created: 1, model: 'fixture'}, reason = message.tool_calls ? 'tool_calls' : 'stop';
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
    assert(active && ++report.requests <= 50, 'Unexpected model request');
    const request = await readFixtureJson(req); active.messages = request.messages ?? [];
    observeResults(active.messages, active.results);
    if (realModel) {
      const response = await fetch(upstream.url, {method: 'POST', redirect: 'error',
        headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + upstream.key},
        signal: AbortSignal.timeout(60000), body: JSON.stringify({...request, model: upstream.modelId, max_tokens: 2000, temperature: 0})});
      if (!response.ok) throw Error('Configured model HTTP ' + response.status);
      res.writeHead(200, {'Content-Type': response.headers.get('content-type') ?? 'application/json'});
      for await (const chunk of response.body) res.write(chunk);
      return res.end();
    }
    const step = active.steps[active.next++];
    if (!step) return complete(res, request, {role: 'assistant', content: `原文记载观测值为 42 单位，来源：${sourceUrl}`});
    return complete(res, request, {role: 'assistant', content: null, tool_calls: [{id: 'call_' + report.requests,
      type: 'function', function: {name: step.name, arguments: JSON.stringify(step.args)}}]});
  } catch (error) {
    report.modelError = redactText(String(error.message));
    res.writeHead(400).end('{"error":{"message":"isolated_search_dialogue_failed"}}');
  }
}

try {
  scenarioProgress('gateway-start', 'started', 'environment'); failureStep = 'gateway-start';
  if (realModel) {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
  for (const dir of [channel, workspace, path.join(root, 'media')]) fs.mkdirSync(dir, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(root, 'token'), token, {mode: 0o600});
  peer = await createOneBotPeer({token, botId: bot, subjects: [owner]});
  model = http.createServer(respond).listen(0, '127.0.0.1'); await once(model, 'listening');
  const env = {}, tavily = '/home/afrangry/.openclaw-fusion/plugins/node_modules/@openclaw/tavily-plugin';
  let preload;
  if (live) {
    const privateEnv = JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json', 'utf8'));
    assert(typeof privateEnv.TAVILY_API_KEY === 'string' && privateEnv.TAVILY_API_KEY, 'Tavily credential unavailable');
    env.TAVILY_API_KEY = privateEnv.TAVILY_API_KEY;
    for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
      if (typeof privateEnv[key] === 'string') env[key] = privateEnv[key];
    }
  } else {
    env.TAVILY_API_KEY = 'synthetic';
    preload = path.join(root, 'fetch-fixture.mjs');
    fs.writeFileSync(preload, `
      import fs from 'node:fs'; import dns from 'node:dns'; import {syncBuiltinESMExports} from 'node:module';
      const lookup=dns.promises.lookup.bind(dns.promises);
      dns.promises.lookup=async(host,options)=>['api.tavily.com','example.com'].includes(host)
        ? (options?.all ? [{address:'93.184.216.34',family:4}] : {address:'93.184.216.34',family:4}) : lookup(host,options);
      syncBuiltinESMExports();
      const original=globalThis.fetch;
      const fixture=async(input,options)=>{
        const u=new URL(input instanceof Request?input.url:input);
        if(u.href==='https://api.tavily.com/search'){
          fs.appendFileSync(${JSON.stringify(path.join(root, 'fixture-requests.jsonl'))},JSON.stringify({kind:'search'})+'\\n');
          return new Response(JSON.stringify({results:[{title:'合成观测站',url:${JSON.stringify(sourceUrl)},content:'旧摘要：17 单位',score:1}]}),{headers:{'content-type':'application/json'}});
        }
        if(u.href===${JSON.stringify(sourceUrl)}){
          fs.appendFileSync(${JSON.stringify(path.join(root, 'fixture-requests.jsonl'))},JSON.stringify({kind:'fetch'})+'\\n');
          return new Response('<html><head><title>合成观测站</title></head><body><main><h1>合成观测报告</h1><p>本次观测值为 42 单位。更新日期 2026-11-26。</p></main></body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
        }
        if(u.hostname==='127.0.0.1') return original(input,options);
        throw Error('Only declared fixture URLs and loopback are permitted');
      };
      fixture.mock={}; globalThis.fetch=fixture;
    `);
  }
  const policy = ownerPolicy(owner), plugins = ['kurumi-qq', 'tavily'];
  const config = withHostControl(compileAccessConfig({
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: `http://127.0.0.1:${model.address().port}/v1`,
      apiKey: 'synthetic', api: 'openai-completions', models: [{id: 'fixture', name: 'fixture', reasoning: false,
        input: ['text'], contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}]}}},
    agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}, heartbeat: {every: '0m'}},
      entries: {main: {workspace, model: {primary: 'fixture/fixture'}, tools: {profile: 'full', allow: ['web_search', 'web_fetch'],
        deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn']}}}},
    channels: {'kurumi-qq': {enabled: true, httpUrl: peer.httpUrl, wsUrl: peer.wsUrl, httpTokenFile: path.join(root, 'token'),
      wsTokenFile: path.join(root, 'token'), stateDir: channel, mediaRoot: path.join(root, 'media'), testIngress: false,
      inboundDebounceMs: 200, inboundDebounceMaxWaitMs: 1000, dailySendLimit: 100, segmentDelayMs: 0}},
    plugins: {allow: plugins, load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-qq'), tavily]},
      entries: {'kurumi-qq': {enabled: true}, tavily: {enabled: true}}, slots: {memory: 'none'}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false},
    logging: {file: path.join(root, 'runtime.log')},
    tools: {toolSearch: false, codeMode: false, deny: ['exec', 'process', 'message', 'sessions_spawn'],
      web: {search: {enabled: true, provider: 'tavily'}, fetch: {enabled: true, useTrustedEnvProxy: live}}},
  }, policy), repo);
  if (realModel) syntheticPersona({repo, root, config, policy, userFile: '这是一次公开资料查询验收。时区为 Asia/Shanghai。'});
  else fs.writeFileSync(path.join(workspace, 'AGENTS.md'), 'Use search and fetch to verify the cited source.');
  gateway = await startIsolatedGateway({repo, root, token, configure: () => config, preload, env});
  await gateway.ready(); await waitForAcceptance(peer.connected, 'search dialogue OneBot socket');
  await assert.rejects(gateway.call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  scenarioProgress('gateway-start', 'passed', 'environment'); failureStep = undefined;

  failureStep = 'search-and-read'; scenarioProgress(failureStep, 'started', 'check');
  active = {next: 0, results: [], steps: [{name: 'web_search', args: {query: '合成观测站 观测值'}},
    {name: 'web_fetch', args: {url: sourceUrl}}]};
  const startedAt = Date.now(), before = peer.sends.length;
  const request = live ? '请先搜索 site:iana.org example domains reserved documentation；等搜索结果返回后，选择其中 IANA 官网的链接打开原文，说明 example.com 的保留用途并附上来源链接。不要凭印象直接打开未出现在搜索结果中的链接。'
    : '请搜索合成观测站的观测值，打开搜索结果对应的原文核对，并附来源链接。';
  const event = peer.message(owner, request), inbound = await peer.send(event);
  currentTurn = {startedAt, messageIds: [String(event.message_id)]};
  await waitForOneBotTurn(channel, [inbound], {timeoutMs: realModel ? 180000 : 30000, check() {
    scenarioSignal.throwIfAborted(); peer.check(); assert(!report.modelError, report.modelError);
  }});
  if (!realModel) assert.equal(active.next, 3);
  const sends = peer.sends.slice(before), answer = sends.map(textOfSend).join('');
  assert(sends.length && sends.every(send => send.accepted));
  const searches = active.results.filter(row => row.tool === 'web_search');
  const citations = answer.match(/https?:\/\/[^\s)\]>`，。]+/gu) ?? [];
  const isIana = url => ['iana.org', 'www.iana.org'].includes(new URL(url).hostname);
  const matchesCitation = (citation, url) => {
    if (citation === url) return true;
    if (!live || typeof url !== 'string' || !url.startsWith('http://') || !isIana(url)) return false;
    // IANA's redirect may return HTTP while the model cites its HTTPS form.
    return citation === 'https://' + url.slice('http://'.length);
  };
  const fetch = active.results.find(row => row.tool === 'web_fetch' && typeof row.args?.url === 'string'
    && searches.some(search => search.value?.results?.some(result => result.url === row.args.url))
    && row.value?.status >= 200 && row.value.status < 300
    && citations.some(cite => matchesCitation(cite, row.args.url) || matchesCitation(cite, row.value.finalUrl))
    && (!live || (isIana(row.args.url) && isIana(row.value.finalUrl ?? row.args.url))));
  assert(fetch, 'Reply must cite a fetched page from the search results');
  // A parallel search and guessed URL do not prove that the page came from the search.
  const searchCalls = new Set(); let seenMatchingSearch = false, fetchedAfterSearch = false;
  for (const message of active.messages) {
    if (message.role === 'tool' && searchCalls.has(message.tool_call_id)
        && JSON.stringify(message.content).includes(fetch.args.url)) seenMatchingSearch = true;
    for (const call of message.tool_calls ?? []) {
      const {tool, args: callArgs} = observedToolCall(call.function);
      if (tool === 'web_search') searchCalls.add(call.id);
      if (tool === 'web_fetch' && callArgs.url === fetch.args.url && seenMatchingSearch) fetchedAfterSearch = true;
    }
  }
  assert(fetchedAfterSearch, 'The cited page must be fetched after the matching search result');
  if (live) {
    assert(/iana\.org/iu.test(fetch.args.url)); assert(/example\.com/iu.test(answer));
  } else {
    assert.equal(fetch.args.url, sourceUrl); assert(/观测值[^。\n]{0,30}42\s*单位/u.test(answer));
    const requests = fs.readFileSync(path.join(root, 'fixture-requests.jsonl'), 'utf8').trim().split('\n').map(line => JSON.parse(line).kind);
    assert(requests.includes('search') && requests.includes('fetch'));
    report.fixtureRequests = requests;
  }
  const dialogue = captureDialogueEvidence({root, owner, startedAt, finishedAt: Date.now(), messageIds: currentTurn.messageIds});
  currentTurn.runId = dialogue.runId;
  report.cases.push({label: failureStep, passed: true, dialogue, sourceUrl: fetch.args.url});
  scenarioProgress(failureStep, 'passed', 'check'); failureStep = undefined; currentTurn = undefined;
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
