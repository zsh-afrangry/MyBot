// Real isolated Gateway with loopback OneBot and model, and a local synthetic ACP peer.
// Writes only temporary fixtures and a new --out evidence file. No paid model, QQ network, real DSH or production writes.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {git} from '../../plugins/kurumi-coding/workspaces.js';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';

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
const sends = [], modelNotices = [];
const blockedCall = 'notice-coding-probe';
let probeSent = false, probeDenied = false;
let socketFromGateway, taskId, modelFailure;
const toolCall = (id, args) => ({role: 'assistant', content: null, tool_calls: [
  {id, type: 'function', function: {name: 'kurumi_code', arguments: JSON.stringify(args)}},
]});
const readJson = async req => {let data = ''; for await (const chunk of req) data += chunk; return JSON.parse(data);};
const listen = async server => {server.listen(0, '127.0.0.1'); await once(server, 'listening'); return '127.0.0.1:' + server.address().port;};
const onebot = http.createServer(async (req, res) => {
  try {
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    const params = await readJson(req);
    let data = {};
    if (req.url === '/get_login_info') data = {user_id: Number(bot)};
    if (req.url === '/send_private_msg') {
      assert.equal(String(params.user_id), owner);
      data.message_id = 42000 + sends.length;
      sends.push({id: String(data.message_id), text: params.message.filter(value => value.type === 'text').map(value => value.data.text).join('')});
    }
    res.end(JSON.stringify({status: 'ok', retcode: 0, data}));
  } catch {res.writeHead(500).end('OneBot fixture error');}
});
const onebotAddress = await listen(onebot);
const ws = new WebSocketServer({server: onebot});
ws.on('connection', (socket, request) => {
  if (request.headers.authorization !== 'Bearer ' + token) {socket.close(1008); return;}
  socketFromGateway = socket;
});
const model = http.createServer(async (req, res) => {
  try {
    const body = await readJson(req);
    const messages = body.messages ?? [];
    const noticeHeader = '以下是绑定当前用户的业务结果';
    const text = content => typeof content === 'string' ? content : (content ?? []).map(value => value.text ?? '').join('\n');
    const userIndex = messages.findLastIndex(value => value.role === 'user' && /FIXTURE_REQUEST_|以下是绑定当前用户的业务结果/.test(text(value.content)));
    const prompt = text(messages[userIndex]?.content);
    const phase = /FIXTURE_REQUEST_(start|resume)/.exec(prompt)?.[1];
    let message;
    if (prompt.includes(noticeHeader)) {
      assert(prompt.includes(taskId));
      const execution = /fixture execution (start|resume)/.exec(prompt)?.[0];
      assert(execution);
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
        message = {role: 'assistant', content: 'Completed ' + taskId + ' ' + execution};
      }
    } else {
      assert(phase, 'Unknown foreground fixture message');
      if (messages.slice(userIndex + 1).some(value => value.role === 'tool')) {
        message = {role: 'assistant', content: 'Accepted ' + phase};
      } else {
        assert((body.tools ?? []).some(tool => tool.function?.name === 'kurumi_code'), 'Coding tool unavailable to foreground model');
        const args = phase === 'start' ? {action: 'start', projectId: 'fixture', task: 'Run the fixture.'}
          : {action: 'continue', taskId, task: 'Resume the fixture.'};
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
async function waitFor(read, description) {
  for (let i = 0; i < 220; i++) {
    if (modelFailure) throw Error(modelFailure);
    const value = read(); if (value) return value;
    await delay(50);
  }
  throw Error('Timed out waiting for ' + description);
}
async function verifyCompletion(directory, codingRoot, stage) {
  await waitFor(() => socketFromGateway?.readyState === 1, 'loopback OneBot connection');
  const coding = new DatabaseSync(path.join(codingRoot, 'coding.sqlite'), {readOnly: true});
  const tasks = () => coding.prepare('SELECT facts FROM coding_tasks').all().map(row => JSON.parse(row.facts));
  let channel;
  try {
    // The synthetic ACP peer cannot finish until the entire initiating QQ turn is closed.
    let previous, originalSession;
    for (const [phase, id] of [['start', 201], ['resume', 202]]) {
      socketFromGateway.send(JSON.stringify({post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(owner),
        message_id: id, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text: 'FIXTURE_REQUEST_' + phase}}]}));
      await waitFor(() => {
        const filename = path.join(directory, 'channel', 'channel.sqlite');
        if (!channel && fs.existsSync(filename) && fs.existsSync(filename + '-shm')) channel = new DatabaseSync(filename, {readOnly: true});
        return channel?.prepare('SELECT status FROM inbound WHERE id=?').get([bot, owner, id].join(':'))?.status === 'completed';
      }, 'closed foreground ' + phase + ' turn');
      assert(sends.some(value => value.text === 'Accepted ' + phase));
      const [pending, ...others] = tasks();
      assert(pending); assert.equal(others.length, 0);
      assert.equal(pending.state, 'running');
      assert.notEqual(pending.executionRoundId, previous);
      taskId ??= pending.id; assert.equal(pending.id, taskId);
      fs.writeFileSync(path.join(gates, phase), '');
      const done = await waitFor(() => {
        const [task] = tasks();
        return ['platform_accepted', 'generation_failed', 'unknown'].includes(task.delivery?.state) && task;
      }, 'terminal ' + phase + ' delivery');
      assert.equal(done.state, 'ready');
      assert.equal(done.checks.ok, true);
      assert.equal(done.delivery.state, 'platform_accepted', phase + ' notice: ' + done.delivery.code);
      assert.equal(done.delivery.roundId, pending.executionRoundId);
      previous = pending.executionRoundId;
      originalSession ??= done.externalSessionId;
      assert(originalSession); assert.equal(done.externalSessionId, originalSession);
      const stored = channel.prepare('SELECT status,message_id FROM outbound WHERE id=?').get(done.delivery.key + ':0');
      assert.equal(stored?.status, 'sent'); assert.equal(String(stored?.message_id), done.delivery.messageId);
      assert.equal(sends.filter(value => value.id === done.delivery.messageId && value.text.includes('fixture execution ' + phase)).length, 1);
    }
    assert(probeSent && probeDenied, 'The background business tool call must be denied');
    assert.equal(tasks().length, 1, 'Notifications must not create coding tasks');
    const decisions = fs.readFileSync(path.join(directory, 'channel', 'access-events.jsonl'), 'utf8').trim().split('\n')
      .map(line => JSON.parse(line).data).filter(entry => entry.tool === 'kurumi_code');
    assert.equal(decisions.filter(entry => entry.decision === 'allow').length, 2, 'Only the two foreground calls may be authorized');
    assert.deepEqual(modelNotices.map(({execution}) => execution), ['fixture execution start', 'fixture execution resume']);
    assert.equal(sends.length, 4);
    assert.equal(git(source, 'rev-parse', 'HEAD').trim(), baseline);
    stage.completion = {foregroundClosedBeforeCompletion: true, startAccepted: true, resumeAccepted: true, sameExternalSession: true,
      backgroundToolDenied: true, noticeSchemaCounts: modelNotices.map(({schemaCount}) => schemaCount)};
  } finally {channel?.close(); coding.close();}
}
async function run(enabled) {
  const directory = path.join(root, enabled ? 'enabled' : 'disabled'); fs.mkdirSync(directory);
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const codingRoot = path.join(directory, 'coding');
  const pluginConfig = {pilot: true, writeBoundary: {root, launcher: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'}, root: codingRoot, worktrees: path.join(directory, 'worktrees'), dsh: {command: peer, home: dshHome, model: ['fixture', 'fixture']}, projects: [{id: 'fixture', root: source, branch: 'main', checks: [{name: 'fixture check', argv: [process.execPath, '-e', 'process.exit(0)']}]}]};
  const config = withHostControl(compileAccessConfig({
    gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
    agents: {ownership: 'explicit', defaults: {workspace: path.join(directory, 'workspace'), heartbeat: {every: '0m'}, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}}, entries: {main: {workspace: path.join(directory, 'workspace'), tools: {alsoAllow: ['kurumi_code']}}}},
    models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: 'http://' + modelAddress + '/v1', apiKey: 'synthetic', api: 'openai-completions',
      models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 1000}]}}},
    plugins: {allow: ['kurumi-coding', 'kurumi-qq'], load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-coding'), path.join(repo, 'chatbot/plugins/kurumi-qq')]},
      entries: {'kurumi-coding': {enabled, config: pluginConfig}, 'kurumi-qq': {enabled}}, slots: {memory: 'none'}},
    channels: {'kurumi-qq': {enabled, httpUrl: 'http://' + onebotAddress, wsUrl: 'ws://' + onebotAddress, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: path.join(directory, 'channel'), mediaRoot: path.join(directory, 'media'), testIngress: false}},
    session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, update: {checkOnStart: false}, tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}}, logging: {file: path.join(directory, 'runtime.log')},
  }, ownerPolicy(owner)), repo);
  fs.mkdirSync(config.agents.defaults.workspace);
  const configFile = path.join(directory, 'openclaw.json'); fs.writeFileSync(configFile, JSON.stringify(config), {mode: 0o600});
  const fd = fs.openSync(path.join(directory, 'gateway.log'), 'w', 0o600);
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
    cwd: repo, detached: true, stdio: ['ignore', fd, fd],
    env: {PATH: process.env.PATH, HOME: directory, LANG: 'C.UTF-8', OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: configFile,
      OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_AGENT_DIR: path.join(directory, 'agents/main/agent')},
  }); fs.closeSync(fd);
  const call = (method, params = {}, timeout = 10000) => callGatewayFromCli(method,
    {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
  const stage = {enabled}; report.stages.push(stage);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {await call('health', {}, 1000); ready = true; break;}
      catch {if (child.exitCode !== null) throw Error('Isolated Gateway exited'); await new Promise(r => setTimeout(r, 300));}
    }
    assert(ready, 'Gateway readiness timed out');
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
    const exited = once(child, 'exit'); let killed = false;
    try {process.kill(-child.pid, 'SIGTERM');} catch {}
    const timer = setTimeout(() => {killed = true; try {process.kill(-child.pid, 'SIGKILL');} catch {}}, 8000); timer.unref();
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(timer); stage.gracefulStop = !killed; assert.equal(killed, false);
    assert.equal(fs.existsSync(path.join(codingRoot, 'service.lock')), false); stage.serviceLockReleased = true;
  }
}
try {await run(true); await run(false); report.passed = true;}
catch (error) {report.passed = false; report.error = {name: error.name, message: error.message}; process.exitCode = 1;}
finally {
  report.finishedAt = new Date().toISOString();
  for (const client of ws.clients) client.terminate();
  await new Promise(resolve => ws.close(resolve));
  for (const server of [onebot, model]) server.closeAllConnections();
  await Promise.all([onebot, model].map(server => new Promise(resolve => server.close(resolve))));
  if (report.passed) fs.rmSync(root, {recursive: true, force: true}); else report.diagnosticDirectory = root;
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({passed: report.passed, stages: report.stages.length, error: report.error}));
}
