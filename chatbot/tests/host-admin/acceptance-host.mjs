// Isolated OpenClaw Gateway acceptance for kurumi-host-admin (docs/37 Stage 1).
// --model sends synthetic conversations to the configured paid model; otherwise cognition is deterministic.
// Only loopback OneBot, temporary state and a new --out report; sudo/systemctl always use local stubs.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import assert from 'node:assert/strict';
import {execFileSync, spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {createOneBotPeer, readOneBotLedger, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {closeOnScenarioDisconnect, scenarioProgress, scenarioSignal} from '../acceptance/scenario-lifecycle.mjs';
import {configuredModel, findObservedToolResult, observedAuthorization, observeToolResults, relayConfiguredModel} from '../acceptance/configured-dialogue.mjs';
import {captureDialogueEvidence} from '../acceptance/dialogue-evidence.mjs';
import {git} from '../../plugins/kurumi-coding/workspaces.js';

const [flag, out, ...extra] = process.argv.slice(2);
const fault = extra.length === 2 && extra[0] === '--diagnostic-fault' && extra[1] === 'host-fixture';
const realModel = extra.length === 1 && extra[0] === '--model';
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && (!extra.length || fault || realModel), 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-host-admin-host-'));
const state = path.join(root, 'state');
const channelDir = path.join(state, 'channel');
const workspace = path.join(state, 'workspace');
const memberWorkspace = path.join(state, 'users/100003/workspace');
const stubsDir = path.join(root, 'stubs');
const stubStateFile = path.join(root, 'service-state.json');
const stubCallsFile = path.join(root, 'sudo-calls.jsonl');
const execSandbox = path.join(root, 'exec-sandbox');
const pilot = path.join(root, 'pilot');
const codingRoot = path.join(pilot, 'coding-state');
const projectRoot = path.join(pilot, 'synthetic-project');
const fakeHome = path.join(pilot, 'fake-home');
const fakePeer = path.join(pilot, 'synthetic-peer');
const launcher = '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run';
const runtimeFile = path.join(state, 'openclaw.json');

for (const dir of [state, channelDir, path.join(state, 'media'), workspace, memberWorkspace, stubsDir, execSandbox, codingRoot, projectRoot, fakeHome]) {
  fs.mkdirSync(dir, {recursive: true});
}
git(projectRoot, 'init', '-b', 'main');
fs.writeFileSync(path.join(projectRoot, 'README.md'), 'fixture\n');
git(projectRoot, 'add', '.');
git(projectRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic coding repo');
fs.writeFileSync(fakePeer, '#!/bin/sh\nexit 0\n', {mode: 0o700});

const sudoStub = path.join(stubsDir, 'sudo-stub');
const systemctlStub = path.join(stubsDir, 'systemctl-stub');
fs.writeFileSync(stubStateFile, JSON.stringify({pid: 100, startCount: 1, active: 'active', sub: 'running'}), {mode: 0o600});

const quote = value => "'" + String(value).replaceAll("'", "'\\''") + "'";
fs.writeFileSync(systemctlStub, `#!/bin/sh
exec ${quote(process.execPath)} -e '
const fs = require("node:fs");
const args = process.argv.slice(1);
const statePath = ${JSON.stringify(stubStateFile)};
const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
if (args[0] === "show") {
  const unit = args[args.length - 1];
  if (unit !== "todeskd.service" && unit !== "other.service") process.exit(1);
  process.stdout.write(
    "LoadState=loaded\\n" +
    "ActiveState=" + state.active + "\\n" +
    "SubState=" + state.sub + "\\n" +
    "MainPID=" + state.pid + "\\n" +
    "ExecMainStartTimestamp=Start-" + state.startCount + "\\n" +
    "UnitFileState=enabled\\n"
  );
  process.exit(0);
}
if (args[0] === "restart") {
  state.pid += 1;
  state.startCount += 1;
  state.active = "active";
  state.sub = "running";
  fs.writeFileSync(statePath, JSON.stringify(state));
  process.exit(0);
}
process.exit(2);
' -- "$@"
`, {mode: 0o700});

fs.writeFileSync(sudoStub, `#!/bin/sh
exec ${quote(process.execPath)} -e '
const fs = require("node:fs");
const {execFileSync} = require("node:child_process");
const args = process.argv.slice(1);
fs.appendFileSync(${JSON.stringify(stubCallsFile)}, JSON.stringify({args, at: Date.now()}) + "\\n");
if (args[0] === "-n" && args[1] === "--" && args[2] === ${JSON.stringify(systemctlStub)}) {
  execFileSync(args[2], args.slice(3), {stdio: "inherit"});
  process.exit(0);
}
process.exit(1);
' -- "$@"
`, {mode: 0o700});

const owner = '100001';
const bot = '100002';
const member = '100003';
const token = randomBytes(24).toString('hex');
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(state, file), token, {mode: 0o600});
for (const dir of [workspace, memberWorkspace]) {
  fs.mkdirSync(path.join(dir, '..'), {recursive: true});
  fs.writeFileSync(path.join(dir, 'AGENTS.md'), dir === workspace ? '# Synthetic owner workspace\n' : '# kurumi-isolated-member-v1\n');
}

const report = {
  at: new Date().toISOString(),
  openclaw: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/openclaw/package.json'), 'utf8')).version,
  boundary: 'Isolated Gateway, loopback OneBot HTTP/WS, Landlock, and stubbed sudo/systemctl. No real sudo, systemd or QQ.',
  cognition: realModel ? 'configured-provider' : 'deterministic fixture',
  cases: [],
  requests: 0,
  primaryModel: 'fixture/fixture',
};

function unwrap(value) {
  for (let i = 0; i < 6; i++) {
    if (typeof value === 'string') {
      try { value = JSON.parse(value); } catch { return value; }
    } else if (value?.result && !value.task) {
      value = value.result;
    } else if (value?.content?.length === 1) {
      value = value.content[0].text;
    } else {
      break;
    }
  }
  return value;
}

let active, upstream;
const observeResults = observeToolResults();
function modelReply(body, tool, res, text = '宿主测试回复。') {
  const choice = tool ? {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_' + report.requests, type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}],
  } : {role: 'assistant', content: text};
  const finish = tool ? 'tool_calls' : 'stop';
  const usage = {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2};
  const common = {id: 'chatcmpl-host-admin', created: 1, model: 'fixture'};
  if (!body.stream) {
    return res.end(JSON.stringify({...common, object: 'chat.completion', choices: [{index: 0, message: choice, finish_reason: finish}], usage}));
  }
  res.setHeader('content-type', 'text/event-stream');
  const event = (delta, finish_reason) => 'data: ' + JSON.stringify({
    ...common, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}], usage,
  }) + '\n\n';
  const delta = tool ? {...choice, tool_calls: choice.tool_calls.map((call, index) => ({...call, index}))} : choice;
  res.end(event(delta, null) + event({}, finish) + 'data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const body = await readFixtureJson(req);
    res.setHeader('content-type', 'application/json');
    assert(++report.requests <= 90, 'Unexpected model request count');
    assert(active, 'Unexpected foreground model request');
    if (active.member) {
      const names = body.tools?.map(tool => tool.function?.name) ?? [];
      assert(!names.includes('kurumi_host_admin') && !names.includes('personal_confirmation'), 'Member tool catalog must not expose host_admin or confirmation');
    }
    if (realModel) {
      observeResults(body.messages ?? [], active.results);
      return await relayConfiguredModel(upstream, body, res);
    }
    if (active.observe) {
      const last = body.messages.findLast(message => message.role === 'tool');
      active.observe(unwrap(last?.content));
      active.observe = undefined;
    }
    const step = active.steps[active.next];
    if (!step) return modelReply(body, undefined, res, active.reply);
    if (step.searchOnly) {
      active.next++;
      active.observe = step.verify;
      return modelReply(body, ['tool_search', {query: step.name, limit: 1}], res);
    }
    if (!step.direct && !active.found) {
      active.found = true;
      active.observe = step.verifySearch;
      return modelReply(body, ['tool_search', {query: step.name, limit: 1}], res);
    }
    active.found = false;
    active.next++;
    active.observe = step.verify;
    const args = typeof step.args === 'function' ? step.args() : step.args;
    if (step.rawTool) return modelReply(body, [step.name, args], res);
    return modelReply(body, ['dispatch_action', {id: step.name, args}], res);
  } catch (error) {
    report.fixtureError = error.message;
    res.writeHead(400);
    res.end(JSON.stringify({error: {message: 'isolated_host_admin_fixture_failed'}}));
  }
});

server.listen(0, '127.0.0.1');
await once(server, 'listening');
const probe = net.createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = `127.0.0.1:${server.address().port}`;
const onebot = await createOneBotPeer({token, botId: bot, subjects: [owner, member]});
const {sends} = onebot;

const policy = ownerPolicy(owner);
policy.subjects.push({
  qq: member,
  kind: 'user',
  role: 'member',
  enabled: true,
  permissions: {'chat.use': true, 'qq.reply': true},
  mailRecipients: [],
});

const plugins = ['kurumi-qq', 'personal-confirmation', 'kurumi-host-admin', 'kurumi-coding'];
const hostAdminConfig = (target = 'todeskd.service') => ({
  sudoCommand: sudoStub,
  systemctlCommand: systemctlStub,
  timeoutMs: 5000,
  proposalTtlSeconds: 1800,
  actions: [{
    id: 'restart_todeskd',
    template: 'service.restart',
    target,
    label: '重启远程桌面服务',
    impact: '重启期间远程桌面连接会短暂断开并需重新连接。',
    leaseEligible: false,
  }],
});

const buildConfig = (target = 'todeskd.service') => compileAccessConfig(withHostControl({
  gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}, reload: {mode: 'off'}},
  discovery: {mdns: {mode: 'off'}},
  update: {checkOnStart: false},
  models: {
    catalogRefresh: {enabled: false},
    providers: {
      fixture: {
        baseUrl: `http://${endpoint}/v1`,
        apiKey: 'synthetic',
        api: 'openai-completions',
        models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: realModel ? 128000 : FIXTURE_CONTEXT_WINDOW, maxTokens: 1200, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
      },
    },
  },
  agents: {
    ownership: 'explicit',
    defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}, heartbeat: {every: '0m'}},
    entries: {
      main: {
        workspace,
        model: {primary: 'fixture/fixture'},
        tools: {
          profile: 'messaging',
          alsoAllow: ['personal_confirmation', 'kurumi_host_admin', 'kurumi_code', 'exec'],
          deny: ['read', 'write', 'edit', 'apply_patch', 'process', 'message', 'sessions_spawn'],
          exec: {host: 'gateway', mode: 'full', timeoutSeconds: 15, notifyOnExit: false},
          elevated: {enabled: false},
        },
      },
    },
  },
  channels: {
    'kurumi-qq': {
      enabled: true,
      httpUrl: onebot.httpUrl,
      wsUrl: onebot.wsUrl,
      httpTokenFile: path.join(state, 'http-token'),
      wsTokenFile: path.join(state, 'ws-token'),
      stateDir: channelDir,
      mediaRoot: path.join(state, 'media'),
      testIngress: false,
      dailySendLimit: 100,
      segmentDelayMs: 0,
    },
  },
  plugins: {
    allow: [...plugins],
    load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))},
    entries: {
      'kurumi-qq': {enabled: true},
      'kurumi-host-control': {
        enabled: true,
        config: {
          exec: {workdir: execSandbox, timeoutSeconds: 15, writeBoundary: {root: execSandbox, launcher}},
        },
      },
      'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}},
      'kurumi-host-admin': {enabled: true, config: hostAdminConfig(target)},
      'kurumi-coding': {
        enabled: true,
        config: {
          pilot: true,
          root: codingRoot,
          worktrees: path.join(pilot, 'worktrees'),
          dsh: {command: fakePeer, home: fakeHome, model: ['fixture', 'fixture']},
          projects: [{
            id: 'synthetic-project',
            root: projectRoot,
            branch: 'main',
            checks: [{name: 'true check', argv: ['/usr/bin/true']}],
          }],
          writeBoundary: {root: pilot, launcher},
        },
      },
    },
    slots: {memory: 'none'},
  },
  tools: {codeMode: false, deny: ['process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
  session: {dmScope: 'per-channel-peer'},
  cron: {enabled: false},
  logging: {file: path.join(state, 'runtime.log')},
}, repo), policy);

let child, stopCurrent, removeDisconnectHandler, liveConfig;
const call = (method, params = {}, timeout = 40000) => callGatewayFromCli(method,
  {config: liveConfig, url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params,
  {deviceIdentity: null, sharedStateMode: 'read-only'});

async function start(target = 'todeskd.service') {
  scenarioSignal.throwIfAborted();
  liveConfig = buildConfig(target);
  fs.writeFileSync(runtimeFile, JSON.stringify(liveConfig, null, 2) + '\n', {mode: 0o600});
  const fd = fs.openSync(path.join(state, 'gateway.log'), 'a', 0o600);
  try {
    child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run',
      '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
      cwd: state,
      detached: true,
      stdio: ['ignore', fd, fd],
      env: {
        PATH: process.env.PATH,
        HOME: state,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
        LANG: 'C.UTF-8',
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_STATE_DIR: state,
        OPENCLAW_CONFIG_PATH: runtimeFile,
        OPENCLAW_AGENT_DIR: path.join(state, 'agents/main/agent'),
      },
    });
  } finally { fs.closeSync(fd); }
  stopCurrent = undefined;
  removeDisconnectHandler = closeOnScenarioDisconnect(stop);
  let ready = false;
  for (let i = 0; i < 60; i++) {
    scenarioSignal.throwIfAborted();
    assert.equal(child.exitCode, null, 'Isolated Gateway exited during startup');
    try {
      if ((await call('kurumi-host-control.status', {}, 1200)).ready === true) { ready = true; break; }
    } catch { /* Gateway still starting. */ }
    await delay(300, undefined, {signal: scenarioSignal});
  }
  assert(ready, 'Isolated Gateway not ready');
  await waitForAcceptance(onebot.connected, 'OneBot socket');
}

function stop() {
  return stopCurrent ??= stopGateway();
}

async function stopGateway() {
  removeDisconnectHandler?.();
  if (!child || child.exitCode !== null || child.signalCode !== null) return true;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  let forced = false;
  const timer = setTimeout(() => {
    forced = true;
    try { process.kill(-child.pid, 'SIGKILL'); } catch {}
  }, 8000);
  try { await exited; } finally { clearTimeout(timer); }
  return !forced;
}

async function restart(target = 'todeskd.service') {
  if (!await stop()) throw Error('Failed to stop isolated Gateway');
  await start(target);
}

async function turn(from, text, steps, reply = '宿主测试回复。') {
  const startedAt = Date.now();
  active = {next: 0, steps, member: from === member, reply, results: []};
  const startLen = sends.length;
  const id = await onebot.send(onebot.message(from, text));
  await waitForOneBotTurn(channelDir, [id], {
    timeoutMs: realModel ? 120000 : 25000,
    check() {
      onebot.check();
      assert(!report.fixtureError, report.fixtureError);
    },
  });
  onebot.check();
  assert(!report.fixtureError, report.fixtureError);
  if (!realModel) {
    assert.equal(active.next, steps.length);
    assert.equal(active.observe, undefined, 'Last tool result not observed');
  }
  const {results} = active;
  active = undefined;
  const sent = sends.slice(startLen);
  assert(sent.length >= 1 && sent.every(message => message.accepted && String(message.user_id) === from));
  for (const entry of sent) {
    const receipt = readOneBotLedger(channelDir, db => db.prepare('SELECT status FROM outbound WHERE message_id=?').get(entry.messageId));
    assert.equal(receipt?.status, 'sent', 'OneBot receipt was not recorded');
  }
  const messageId = id.split(':').at(-1);
  if (realModel) {
    (report.turns ??= []).push(captureDialogueEvidence({root: state, owner: from, startedAt, finishedAt: Date.now(), messageIds: [messageId]}));
  }
  return {sent, messageId, results};
}

async function step(label, fn, phase = 'check') {
  scenarioProgress(label, 'started', phase);
  try {
    await fn();
    scenarioProgress(label, 'passed', phase);
    if (phase === 'check') report.cases.push({label, passed: true});
  } catch (error) {
    scenarioProgress(label, 'failed', phase);
    throw error;
  }
}

const readCalls = () => fs.existsSync(stubCallsFile)
  ? fs.readFileSync(stubCallsFile, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line))
  : [];

const readAudit = (sql, ...params) => {
  const db = new DatabaseSync(path.join(state, 'state/host-admin/actions.sqlite'), {readOnly: true});
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
};

let proposal, driftProposal;

async function modelScenario() {
  const get = ({results}, tool, identifiers) => {
    const row = findObservedToolResult(results, tool, identifiers);
    assert(row, 'Missing expected ' + tool + ' result for ' + identifiers.action);
    return row.value;
  };
  const hostTool = 'kurumi_host_admin';
  await step('natural request presents a frozen host operation without running it', async () => {
    const preview = await turn(owner, '请预览重启远程桌面服务的受控系统操作 restart_todeskd，完整呈现预览，等我确认后再执行。');
    proposal = get(preview, hostTool, {action: 'propose', actionId: 'restart_todeskd'});
    assert.equal(proposal.status, 'pending');
    assert.equal(proposal.beforeState.MainPID, '100');
    assert(proposal.presentationFacts.every(fact => preview.sent.map(textOfSend).join('\n').includes(fact)));
    assert(readAudit('SELECT presented_at_utc FROM confirmation_previews WHERE proposal_id=?', proposal.proposalId)?.presented_at_utc);
    assert.equal(readCalls().length, 0);
  });
  await step('next-turn confirmation runs the registered stub exactly once', async () => {
    const confirmation = await turn(owner, '确认，执行刚才预览的远程桌面服务重启。');
    const id = {proposalId: proposal.proposalId};
    assert(observedAuthorization(confirmation.results, {...proposal, domain: 'host_sudo'}), 'Missing authorization for the presented proposal');
    const result = get(confirmation, hostTool, {action: 'commit', ...id});
    assert.equal(result.status, 'succeeded');
    assert.equal(result.afterState.MainPID, '101');
    assert.equal(result.verification.active, true);
    assert.equal(readAudit('SELECT status FROM approval_grants WHERE proposal_id=?', proposal.proposalId)?.status, 'consumed');
    assert.deepEqual(readCalls().map(row => row.args), [['-n', '--', systemctlStub, 'restart', 'todeskd.service']]);
  });
  await step('read-only status returns the same executed receipt without another restart', async () => {
    const lookup = await turn(owner, `请只查询受控系统操作提案 ${proposal.proposalId} 的执行结果，不要再重启。`);
    const receipt = get(lookup, hostTool, {action: 'status', proposalId: proposal.proposalId});
    assert.equal(receipt.status, 'succeeded');
    assert.equal(receipt.afterState.MainPID, '101');
    assert.equal(receipt.currentState.MainPID, '101');
    assert.equal(readCalls().length, 1);
    report.proposalId = proposal.proposalId;
  });
}

async function fixtureScenario() {
  await step('owner lists configured host-admin actions and leaseEligible=false', async () => {
    await turn(owner, '看看有哪些受控系统操作', [{
      name: 'kurumi_host_admin',
      args: {action: 'list'},
      verify(result) {
        assert.equal(result.ok, true);
        assert.equal(result.actions.length, 1);
        assert.deepEqual({
          id: result.actions[0].id,
          template: result.actions[0].template,
          target: result.actions[0].target,
          leaseEligible: result.actions[0].leaseEligible,
        }, {
          id: 'restart_todeskd',
          template: 'service.restart',
          target: 'todeskd.service',
          leaseEligible: false,
        });
      },
    }]);
  });

  await step('propose delivers short human-readable QQ preview and rejects same-turn commit', async () => {
    const previewTurn = await turn(owner, '帮我重启远程桌面并直接执行', [
      {
        name: 'kurumi_host_admin',
        args: {action: 'propose', actionId: 'restart_todeskd'},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'pending');
          assert.equal(result.domain, 'host_sudo');
          assert.equal(result.beforeState.MainPID, '100');
          assert(result.previewText.length < 220, 'Preview must stay compact for mobile QQ');
          assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(result.previewText));
          assert(!/[a-f0-9]{32,}/iu.test(result.previewText));
          assert(!result.previewText.includes(stubsDir));
          proposal = result;
        },
      },
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'host_sudo', proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'proposal_not_presented'}),
      },
      {
        name: 'kurumi_host_admin',
        args: () => ({action: 'commit', proposalId: proposal.proposalId}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'approval_required'}),
      },
    ], '已生成预览，请确认是否继续。');

    const sentText = previewTurn.sent.map(textOfSend).join('\n');
    for (const fact of proposal.presentationFacts) assert(sentText.includes(fact), `Missing fact in QQ reply: ${fact}`);
    assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(sentText));
    assert(!/[a-f0-9]{32,}/iu.test(sentText));
    assert(readAudit('SELECT presented_at_utc FROM confirmation_previews WHERE proposal_id=?', proposal.proposalId)?.presented_at_utc);
    assert.equal(readCalls().length, 0);
  });

  await step('member cannot discover or invoke kurumi_host_admin or host_sudo confirmation', async () => {
    await turn(member, '我也试试系统重启和确认', [
      {
        name: 'kurumi_host_admin',
        searchOnly: true,
        verify: result => assert(!JSON.stringify(result).includes('"name":"kurumi_host_admin"')),
      },
      {
        name: 'kurumi_host_admin',
        args: {action: 'list'},
        direct: true,
        verify: result => assert.match(JSON.stringify(result), /unknown|not found|not available|capability_not_allowed|forbidden|not allowed/i),
      },
      {
        name: 'personal_confirmation',
        args: {action: 'list', domain: 'host_sudo'},
        direct: true,
        verify: result => assert.match(JSON.stringify(result), /unknown|not found|not available|capability_not_allowed|forbidden|not allowed/i),
      },
    ]);
    assert.equal(readCalls().length, 0);
  });

  await step('ordinary exec and coding delegation cannot elevate privileges or invoke host-admin stub', async () => {
    await turn(owner, '试试普通终端提权和编码工具', [
      {
        name: 'exec',
        args: {command: `${sudoStub} -n -- ${systemctlStub} restart todeskd.service`, elevated: true},
        verify: result => assert.match(JSON.stringify(result), /owner_exec_mode_not_allowed|denied|blocked/i),
      },
      {
        name: 'exec',
        direct: true,
        args: {command: 'grep ^NoNewPrivs /proc/self/status'},
        verify(result) {
          assert.match(JSON.stringify(result), /NoNewPrivs:(?:\\t|\s)+1/,
            `Expected NoNewPrivs: 1 in exec: ${JSON.stringify(result)}`);
        },
      },
      {
        name: 'exec',
        direct: true,
        args: {command: `${sudoStub} -n -- ${systemctlStub} restart todeskd.service`},
        verify(result) {
          assert.match(JSON.stringify(result), /Permission denied|EACCES|EROFS|failed|exited|error/i);
        },
      },
      {
        name: 'kurumi_code',
        args: {action: 'list'},
        verify(result) {
          assert.equal(result.projects[0].id, 'synthetic-project');
        },
      },
      {
        name: 'kurumi_code',
        args: {action: 'sudo'},
        direct: true,
        verify(result) {
          assert.match(JSON.stringify(result), /unmapped_tool|Validation failed|unknown/i);
        },
      },
    ]);
    assert.equal(readCalls().length, 0);
  });

  await step('confirmed commit executes fixed template, verifies PID change, and rejects replay', async () => {
    await turn(owner, '确认', [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'host_sudo', proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}),
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'authorized');
        },
      },
      {
        name: 'kurumi_host_admin',
        args: () => ({action: 'commit', proposalId: proposal.proposalId}),
        verify(result) {
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.status, 'succeeded');
          assert.equal(result.beforeState.MainPID, '100');
          assert.equal(result.afterState.MainPID, '101');
          assert.equal(result.verification.active, true);
          assert.equal(result.verification.pidChanged, true);
          assert.equal(result.feedback.action, 'host_admin.service.restart');
          assert.equal(result.feedback.status, 'succeeded');
        },
      },
      {
        name: 'kurumi_host_admin',
        args: () => ({action: 'commit', proposalId: proposal.proposalId}),
        direct: true,
        verify(result) {
          assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'host_admin_already_submitted'});
        },
      },
      {
        name: 'kurumi_host_admin',
        args: () => ({action: 'status', proposalId: proposal.proposalId}),
        direct: true,
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'succeeded');
          assert.equal(result.afterState.MainPID, '101');
          assert.equal(result.currentState.MainPID, '101');
        },
      },
    ], '远程桌面服务已重启，当前已恢复运行。');

    const calls = readCalls();
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0].args, ['-n', '--', systemctlStub, 'restart', 'todeskd.service']);
    assert.equal(readAudit('SELECT status FROM approval_grants WHERE proposal_id=?', proposal.proposalId).status, 'consumed');
  });

  await step('config target drift blocks commit after confirmation and reports stale status', async () => {
    const previewTurn = await turn(owner, '再生成一份重启预览', [{
      name: 'kurumi_host_admin',
      args: {action: 'propose', actionId: 'restart_todeskd'},
      verify(result) {
        assert.equal(result.ok, true);
        driftProposal = result;
      },
    }]);
    const sentText = previewTurn.sent.map(textOfSend).join('\n');
    for (const fact of driftProposal.presentationFacts) assert(sentText.includes(fact));

    await restart('other.service');
    await turn(owner, '确认', [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'host_sudo', proposalId: driftProposal.proposalId, payloadHash: driftProposal.payloadHash}),
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'authorized');
        },
      },
      {
        name: 'kurumi_host_admin',
        args: () => ({action: 'commit', proposalId: driftProposal.proposalId}),
        verify(result) {
          assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'host_admin_action_changed'});
        },
      },
      {
        name: 'kurumi_host_admin',
        args: () => ({action: 'status', proposalId: driftProposal.proposalId}),
        direct: true,
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'stale');
        },
      },
    ]);
    assert.equal(readCalls().length, 1);
  });

  await step('read-only log-query correlates trace-events and access-control audit records', async () => {
    const traceOut = JSON.parse(execFileSync(process.execPath, [
      path.join(repo, 'chatbot/scripts/log-query.mjs'),
      '--runtime-root', state,
      '--source', 'trace-events',
      '--since', '1h',
      '--proposal-id', proposal.proposalId,
      '--json',
    ], {encoding: 'utf8'}));
    const kinds = traceOut.events.map(ev => ev.kind);
    assert(kinds.includes('host_admin.proposed'));
    assert(kinds.includes('host_admin.executed'));
    const executed = traceOut.events.find(ev => ev.kind === 'host_admin.executed');
    assert.equal(executed.correlation.subjectId, owner);
    assert(typeof executed.correlation.runId === 'string' && executed.correlation.runId.length > 0);
    assert.equal(executed.data.status, 'succeeded');
    assert.equal(executed.data.afterState.MainPID, '101');

    const accessOut = JSON.parse(execFileSync(process.execPath, [
      path.join(repo, 'chatbot/scripts/log-query.mjs'),
      '--runtime-root', state,
      '--source', 'access-control',
      '--since', '1h',
      '--json',
    ], {encoding: 'utf8'}));
    assert(accessOut.events.some(ev => ev.data?.tool === 'kurumi_host_admin' && ev.data?.decision === 'allow'));
    assert(accessOut.events.some(ev => ev.data?.tool === 'exec' && ev.data?.decision === 'deny' && ev.data?.code === 'owner_exec_mode_not_allowed'));
    assert(!JSON.stringify(accessOut).includes(sudoStub));
  });

}

try {
  if (realModel) {
    await step('configure model for synthetic host conversation', () => {
      try {upstream = configuredModel(repo); report.primaryModel = upstream.primary;}
      catch {report.blocked = true; throw Error('Configured model or credential is unavailable');}
    }, 'environment');
  }
  await step('start isolated gateway with kurumi-host-admin', () => start('todeskd.service'), 'environment');
  if (fault) await step('fixture diagnostic failure', async () => {throw Error('synthetic host fixture failure');});
  await (realModel ? modelScenario() : fixtureScenario());
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  report.diagnosticsRoot = root;
  process.exitCode = 1;
} finally {
  scenarioProgress('stop isolated gateway', 'started', 'cleanup');
  const stopped = report.gatewayStopped = await stop();
  scenarioProgress('stop isolated gateway', stopped ? 'passed' : 'failed', 'cleanup');
  if (!stopped) {
    report.passed = false;
    report.error ??= 'Isolated Gateway did not stop gracefully';
    process.exitCode = 1;
  }
  await onebot.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  else report.diagnosticsRoot ??= root;
  report.fixtureCleaned = !fs.existsSync(root);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.fixtureError ?? report.error, evidence: out}));
}
