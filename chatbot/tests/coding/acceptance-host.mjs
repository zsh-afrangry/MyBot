// Real isolated Gateway with loopback OneBot and model, and a local synthetic ACP peer.
// Writes only temporary fixtures and a new --out evidence file. No paid model, QQ network, real DSH or production writes.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {git} from '../../plugins/kurumi-coding/workspaces.js';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {createOneBotPeer, readOneBotLedger, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !path.isAbsolute(out ?? '') || fs.existsSync(out)) throw Error('Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-coding-host-'));
const source = path.join(root, 'source'); fs.mkdirSync(source); git(source, 'init', '-b', 'main');
fs.writeFileSync(path.join(source, 'README.md'), 'synthetic host load only\n'); git(source, 'add', '.');
git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'host fixture');
const dshHome = path.join(root, 'dsh-home'); fs.mkdirSync(dshHome);
const token = randomBytes(24).toString('hex');
const owner = '100001', bot = '100002';
const baseline = git(source, 'rev-parse', 'HEAD').trim();
const peer = path.join(root, 'synthetic-acp'), gates = path.join(root, 'gates');
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
fs.mkdirSync(gates);
fs.writeFileSync(peer, '#!/bin/bash\nexec ' + [process.execPath, fileURLToPath(new URL('./acp-peer.mjs', import.meta.url)), '--completion-fixture', gates].map(quote).join(' ') + ' "$@"\n', {mode: 0o700});
const tokenFile = path.join(root, 'onebot-token'); fs.writeFileSync(tokenFile, token, {mode: 0o600});
const report = {at: new Date().toISOString(), boundary: 'Isolated Gateway and foreground QQ turn through loopback OneBot/model, synthetic ACP, and real local Git. No external model, QQ or production state.', stages: []};
const modelNotices = [];
const phaseStates = {start: 'ready', resume: 'ready', failure: 'failed', blocked: 'needs_permission'};
const noticeTasks = new Map();
const blockedCall = 'notice-coding-probe';
let probeSent = false, probeDenied = false;
let modelFailure;
const toolCall = (id, args) => ({role: 'assistant', content: null, tool_calls: [
  {id, type: 'function', function: {name: 'kurumi_code', arguments: JSON.stringify(args)}},
]});
const readJson = readFixtureJson;
const listen = async server => {server.listen(0, '127.0.0.1'); await once(server, 'listening'); return '127.0.0.1:' + server.address().port;};
const onebot = await createOneBotPeer({token, botId: bot, subjects: [owner]});
const {sends} = onebot;
const model = http.createServer(async (req, res) => {
  try {
    const body = await readJson(req);
    const messages = body.messages ?? [];
    const noticeHeader = '以下是绑定当前用户的业务结果';
    const text = content => typeof content === 'string' ? content : (content ?? []).map(value => value.text ?? '').join('\n');
    const userIndex = messages.findLastIndex(value => value.role === 'user' && /FIXTURE_REQUEST_|以下是绑定当前用户的业务结果/.test(text(value.content)));
    const prompt = text(messages[userIndex]?.content);
    const phase = /FIXTURE_REQUEST_(start|resume|failure|blocked)/.exec(prompt)?.[1];
    let message;
    if (prompt.includes(noticeHeader)) {
      const [execution, noticePhase] = /fixture execution (start|resume|failure|blocked)/.exec(prompt) ?? [];
      assert(execution);
      const taskId = noticeTasks.get(noticePhase);
      assert(taskId && prompt.includes(taskId));
      assert(prompt.includes(phaseStates[noticePhase]));
      // The pinned host can retain schemas for history/prefix reuse. Force a
      // business call and verify the runtime's denial rather than count schemas.
      const probeResult = messages.slice(userIndex + 1).find(value => value.role === 'tool');
      if (execution === 'fixture execution start' && !probeResult) {
        assert(!probeSent, 'The model did not see a result for its background tool attempt: ' + messages.slice(userIndex + 1).map(value => value.role).join(','));
        probeSent = true;
        message = toolCall(blockedCall, {action: 'start', projectId: 'fixture', task: 'Must never be started by a notification.'});
      } else {
        if (probeResult) {
          assert.match(text(probeResult.content), /untrusted_identity_context|not available in this background run|unknown tool|tool.*not found/i);
          probeDenied = true;
        }
        modelNotices.push({execution, schemaCount: (body.tools ?? []).length});
        message = {role: 'assistant', content: `${phaseStates[noticePhase]} ${taskId} ${execution}`};
      }
    } else {
      assert(phase, 'Unknown foreground fixture message');
      if (messages.slice(userIndex + 1).some(value => value.role === 'tool')) {
        message = {role: 'assistant', content: 'Accepted ' + phase};
      } else {
        assert((body.tools ?? []).some(tool => tool.function?.name === 'kurumi_code'), 'Coding tool unavailable to foreground model');
        const args = phase === 'resume'
          ? {action: 'continue', taskId: noticeTasks.get('start'), task: 'Resume the fixture.'}
          : {action: 'start', projectId: 'fixture', title: `Fixture ${phase}`, task: `FIXTURE_CASE_${phase}`};
        message = toolCall('coding-' + phase, args);
      }
    }
    const base = {id: 'coding-host-fixture', created: 1, model: 'fixture'};
    const finish_reason = message.tool_calls ? 'tool_calls' : 'stop';
    if (!body.stream) {res.end(JSON.stringify({...base, object: 'chat.completion', choices: [{index: 0, message, finish_reason}]})); return;}
    const delta = message.tool_calls ? {...message, tool_calls: message.tool_calls.map((tool, index) => ({...tool,index}))} : message;
    const chunk = (value, reason) => 'data: ' + JSON.stringify({...base, object: 'chat.completion.chunk', choices: [{index: 0, delta: value, finish_reason: reason}]}) + '\n\n';
    res.setHeader('content-type', 'text/event-stream');
    res.end(chunk(delta, null) + chunk({}, finish_reason) + 'data: [DONE]\n\n');
  } catch (error) {modelFailure = error.message; res.writeHead(400).end('Model fixture error');}
});
const modelAddress = await listen(model);
function check() {
  onebot.check();
  if (modelFailure) throw Error(modelFailure);
}
const waitFor = (read, description) => waitForAcceptance(() => {check(); return read();}, description);
async function verifyCompletion(directory, codingRoot, stage) {
  await waitFor(onebot.connected, 'loopback OneBot connection');
  const channelDir = path.join(directory, 'channel');
  const coding = new DatabaseSync(path.join(codingRoot, 'coding.sqlite'), {readOnly: true});
  const tasks = () => coding.prepare('SELECT facts FROM coding_tasks').all().map(row => JSON.parse(row.facts));
  try {
    // The synthetic ACP peer cannot finish until the entire initiating QQ turn is closed.
    const knownTasks = new Set(), seenRounds = new Set();
    let originalSession;
    for (const [phase, expectedState] of Object.entries(phaseStates)) {
      const id = await onebot.send(onebot.message(owner, 'FIXTURE_REQUEST_' + phase));
      await waitForOneBotTurn(channelDir, [id], {check});
      assert(sends.some(value => value.accepted && textOfSend(value) === 'Accepted ' + phase));
      const allTasks = tasks(), [pending, ...others] = allTasks.filter(task => task.state === 'running');
      assert(pending); assert.equal(others.length, 0);
      assert.equal(pending.title, `Fixture ${phase === 'resume' ? 'start' : phase}`);
      assert(!seenRounds.has(pending.executionRoundId)); seenRounds.add(pending.executionRoundId);
      if (phase === 'resume') assert.equal(pending.id, noticeTasks.get('start'));
      else {assert(!knownTasks.has(pending.id)); knownTasks.add(pending.id);}
      assert.equal(allTasks.length, knownTasks.size);
      noticeTasks.set(phase, pending.id);
      fs.writeFileSync(path.join(gates, phase), '');
      const done = await waitFor(() => {
        const task = tasks().find(task => task.id === pending.id);
        if (task?.state === 'cancelled') throw Error(`${phase} unexpectedly recorded as cancelled`);
        return ['platform_accepted', 'generation_failed', 'unknown'].includes(task.delivery?.state) && task;
      }, 'terminal ' + phase + ' delivery');
      assert.equal(done.state, expectedState);
      if (expectedState === 'ready') assert.equal(done.checks.ok, true);
      else {assert.equal(done.checks, undefined); assert.equal(done.verifiedCommit, baseline);}
      if (phase === 'blocked') assert.equal(done.permissionSummary.rejected, 1);
      assert.equal(done.delivery.state, 'platform_accepted', phase + ' notice: ' + done.delivery.code);
      assert.equal(done.delivery.roundId, pending.executionRoundId);
      if (phase === 'start') {originalSession = done.externalSessionId; assert(originalSession);}
      if (phase === 'resume') assert.equal(done.externalSessionId, originalSession);
      const stored = readOneBotLedger(channelDir, db => db.prepare('SELECT status,message_id FROM outbound WHERE id=?').get(done.delivery.key + ':0'));
      assert.equal(stored?.status, 'sent'); assert.equal(String(stored?.message_id), done.delivery.messageId);
      assert.equal(sends.filter(value => value.accepted && value.messageId === done.delivery.messageId && textOfSend(value).includes('fixture execution ' + phase)).length, 1);
    }
    assert(probeSent && probeDenied, 'The background business tool call must be denied');
    assert.equal(tasks().length, knownTasks.size, 'Notifications must not create coding tasks');
    const decisions = fs.readFileSync(path.join(directory, 'channel', 'access-events.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line).data).filter(entry => entry.tool === 'kurumi_code');
    const phases = Object.keys(phaseStates);
    assert.equal(decisions.filter(entry => entry.decision === 'allow').length, phases.length, 'Only the foreground calls may be authorized');
    assert.deepEqual(modelNotices.map(({execution}) => execution), phases.map(phase => 'fixture execution ' + phase));
    assert.equal(sends.length, 2 * phases.length);
    assert.equal(git(source, 'rev-parse', 'HEAD').trim(), baseline);
    stage.completion = {foregroundClosedBeforeCompletion: true, startAccepted: true, resumeAccepted: true, failureAccepted: true, permissionBlockedAccepted: true, sameExternalSession: true,
      backgroundToolDenied: true, noticeSchemaCounts: modelNotices.map(({schemaCount}) => schemaCount)};
  } finally {coding.close();}
}
async function run(enabled) {
  const directory = path.join(root, enabled ? 'enabled' : 'disabled'); fs.mkdirSync(directory);
  const codingRoot = path.join(directory, 'coding');
  const pluginConfig = {pilot: true, writeBoundary: {root, launcher: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'}, root: codingRoot, worktrees: path.join(directory, 'worktrees'), dsh: {command: peer, home: dshHome, model: ['fixture', 'fixture']}, projects: [{id: 'fixture', root: source, branch: 'main', checks: [{name: 'fixture check', argv: [process.execPath, '-e', 'process.exit(0)']}]}]};
  const config = withHostControl(compileAccessConfig({
    agents: {ownership: 'explicit', defaults: {workspace: path.join(directory, 'workspace'), heartbeat: {every: '0m'}, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}}, entries: {main: {workspace: path.join(directory, 'workspace'), tools: {alsoAllow: ['kurumi_code']}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://' + modelAddress + '/v1', apiKey: 'synthetic', api: 'openai-completions',
      models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: FIXTURE_CONTEXT_WINDOW, maxTokens: 1000}]}}},
    plugins: {allow: ['kurumi-coding', 'kurumi-qq'], load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-coding'), path.join(repo, 'chatbot/plugins/kurumi-qq')]},
      entries: {'kurumi-coding': {enabled, config: pluginConfig}, 'kurumi-qq': {enabled}}, slots: {memory: 'none'}},
    channels: {'kurumi-qq': {enabled, httpUrl: onebot.httpUrl, wsUrl: onebot.wsUrl, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: path.join(directory, 'channel'), mediaRoot: path.join(directory, 'media'), testIngress: false}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false}, tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}}, logging: {file: path.join(directory, 'runtime.log')},
  }, ownerPolicy(owner)), repo);
  fs.mkdirSync(config.agents.defaults.workspace);
  const host = await startIsolatedGateway({repo, root: directory, token, configure: () => config});
  const {call} = host;
  const stage = {enabled, configSha256: host.configSha256}; report.stages.push(stage);
  try {
    await host.ready();
    const plugins = await call('plugins.list'), catalog = await call('tools.catalog', {agentId: 'main', includePlugins: true});
    const plugin = plugins.plugins.find(p => p.id === 'kurumi-coding'); assert(plugin);
    const names = catalog.groups.filter(g => g.pluginId === 'kurumi-coding').flatMap(g => g.tools.map(t => t.id));
    if (enabled) {assert.equal(plugin.runtime.state, 'active'); assert.deepEqual(names, ['kurumi_code']);}
    else {assert(['disabled', 'unloaded'].includes(plugin.runtime.state)); assert.deepEqual(names, []);}
    assert.equal(fs.existsSync(path.join(codingRoot, 'coding.sqlite')), enabled);
    assert.equal(fs.existsSync(path.join(codingRoot, 'tasks')), false); // Loading never starts a model task.
    if (enabled) await verifyCompletion(directory, codingRoot, stage);
    Object.assign(stage, {state: plugin.runtime.state, tools: names, noInitialTask: true, passed: true});
  } catch (error) {
    stage.error = error.message;
    throw error;
  } finally {
    stage.gracefulStop = await host.close();
    assert(stage.gracefulStop, 'Isolated Gateway did not stop gracefully');
    assert.equal(fs.existsSync(path.join(codingRoot, 'service.lock')), false); stage.serviceLockReleased = true;
  }
}
try {await run(true); await run(false); report.passed = true;}
catch (error) {report.passed = false; report.error = {name: error.name, message: error.message}; process.exitCode = 1;}
finally {
  report.finishedAt = new Date().toISOString();
  model.closeAllConnections();
  await Promise.all([onebot.close(), new Promise(resolve => model.close(resolve))]);
  if (report.passed) {fs.rmSync(root, {recursive: true, force: true}); report.fixtureRemoved = !fs.existsSync(root);}
  else {report.diagnosticDirectory = root; report.fixtureRemoved = false;}
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, stages: report.stages.length, error: report.error}));
}
