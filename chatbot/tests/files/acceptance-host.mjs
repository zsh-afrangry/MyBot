// Isolated OpenClaw Gateway acceptance for kurumi-files and @kurumi/scoped-lease (docs/37 Stage 2A).
// Uses local deterministic model, loopback OneBot WebSocket/HTTP, and real Landlock exec.
// Never touches user ~/下载, ~/文档, ~/kurumi-space, real QQ, or paid models; writes only disposable state and --out.
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

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && !extra.length, 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-files-host-'));
const state = path.join(root, 'state');
const channelDir = path.join(state, 'channel');
const workspace = path.join(state, 'workspace');
const memberWorkspace = path.join(state, 'users/100003/workspace');
const fakeHome = path.join(root, 'fake-home');
const kurumiSpace = path.join(fakeHome, 'kurumi-space');
const desktop = path.join(fakeHome, '桌面');
const downloads = path.join(fakeHome, '下载');
const documents = path.join(fakeHome, '文档');
const miniconda = path.join(fakeHome, 'miniconda3', 'envs', 'base');
const xwechatDir = path.join(fakeHome, '.xwechat');
const keyringsDir = path.join(fakeHome, '.local', 'share', 'keyrings');
const repoRo = path.join(fakeHome, 'repository');
const sshDir = path.join(fakeHome, '.ssh');
const execSandbox = path.join(root, 'exec-sandbox');
const execWorkdir = path.join(execSandbox, 'source');
const launcher = '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run';
const runtimeFile = path.join(state, 'openclaw.json');

for (const dir of [
  state,
  channelDir,
  path.join(state, 'media'),
  workspace,
  memberWorkspace,
  kurumiSpace,
  desktop,
  downloads,
  documents,
  miniconda,
  xwechatDir,
  keyringsDir,
  repoRo,
  sshDir,
  execSandbox,
  execWorkdir,
]) {
  fs.mkdirSync(dir, {recursive: true});
}

fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE_SSH_KEY_SENTINEL');
fs.writeFileSync(path.join(xwechatDir, 'session.db'), 'PRIVATE_XWECHAT_SENTINEL');
fs.writeFileSync(path.join(keyringsDir, 'login.keyring'), 'PRIVATE_KEYRING_SENTINEL');
fs.writeFileSync(path.join(fakeHome, '.bashrc'), 'export PATH=$PATH\n');
fs.writeFileSync(path.join(miniconda, 'pkg.py'), 'CONDA_TOOL_NEEDLE=1\n');
fs.writeFileSync(path.join(desktop, 'desk-note.txt'), 'DESK_NEEDLE_OK\n');
fs.writeFileSync(path.join(downloads, '.env.local'), 'SECRET_ENV_SENTINEL=1\n');
fs.writeFileSync(path.join(repoRo, 'README.md'), 'repository-readonly-content\n');
fs.symlinkSync(path.join(sshDir, 'id_ed25519'), path.join(downloads, 'escape-to-ssh'));

const PRIVATE_SENTINEL = 'PRIVATE_FILE_CONTENT_DO_NOT_LEAK_IN_LOGS';
const cleanupDir = path.join(downloads, 'cleanup-batch');
fs.mkdirSync(cleanupDir);
fs.writeFileSync(path.join(cleanupDir, 'old1.log'), `first log ${PRIVATE_SENTINEL}\n`);
fs.writeFileSync(path.join(cleanupDir, 'old2.log'), 'second log line\n');

const batchDel1 = path.join(downloads, 'leased-1.tmp');
const batchDel2 = path.join(downloads, 'leased-2.tmp');
const docProtected = path.join(documents, 'keep-doc.txt');
fs.writeFileSync(batchDel1, 'tmp-a');
fs.writeFileSync(batchDel2, 'tmp-b');
fs.writeFileSync(docProtected, 'must-remain-untouched');

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
  boundary: 'Isolated Gateway, deterministic loopback model, simulated OneBot HTTP/WS, Landlock exec without 下载/文档 write roots, kurumi-files + scoped-lease.',
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

let active;
function modelReply(body, tool, res, text = '宿主测试回复。') {
  const choice = tool ? {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_' + report.requests, type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}],
  } : {role: 'assistant', content: text};
  const finish = tool ? 'tool_calls' : 'stop';
  const usage = {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2};
  const common = {id: 'chatcmpl-host-files', created: 1, model: 'fixture'};
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
    const chunks = [];
    for await (const bytes of req) chunks.push(bytes);
    res.setHeader('content-type', 'application/json');
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert(++report.requests <= 140, 'Unexpected model request count');
    assert(active, 'Unexpected foreground model request');
    if (active.member) {
      const names = body.tools?.map(tool => tool.function?.name) ?? [];
      assert(
        !names.includes('kurumi_files') && !names.includes('kurumi_lease') && !names.includes('personal_confirmation'),
        'Member tool catalog must not expose files, lease, or confirmation',
      );
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
    res.end(JSON.stringify({error: {message: 'isolated_host_files_fixture_failed'}}));
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

const plugins = ['kurumi-qq', 'personal-confirmation', 'kurumi-files'];
const buildConfig = () => compileAccessConfig(withHostControl({
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
        models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1200, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}],
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
          alsoAllow: ['personal_confirmation', 'kurumi_files', 'kurumi_lease', 'exec'],
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
          // Stage 2A migration: 下载 and 文档 are intentionally excluded from exec writeBoundary.
          exec: {workdir: execWorkdir, timeoutSeconds: 15, writeBoundary: {root: execSandbox, launcher}},
        },
      },
      'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}},
      'kurumi-files': {
        enabled: true,
        config: {
          homeDir: fakeHome,
          defaultWorkspace: kurumiSpace,
          t0Roots: [{path: kurumiSpace, label: 'Kurumi 草稿区'}],
          t1Roots: [{path: fakeHome, label: '主目录一般工作区'}],
          t2Roots: [{path: repoRo, label: '仓库只读区', readOnly: true, allowLease: false}],
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

async function start() {
  scenarioSignal.throwIfAborted();
  liveConfig = buildConfig();
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

async function turn(from, text, steps, reply = '宿主测试回复。') {
  active = {next: 0, steps, member: from === member, reply};
  const startLen = sends.length;
  const id = await onebot.send(onebot.message(from, text));
  await waitForOneBotTurn(channelDir, [id], {
    timeoutMs: 25000,
    check() {
      onebot.check();
      assert(!report.fixtureError, report.fixtureError);
    },
  });
  onebot.check();
  assert(!report.fixtureError, report.fixtureError);
  assert.equal(active.next, steps.length);
  assert.equal(active.observe, undefined, 'Last tool result not observed');
  active = undefined;
  const sent = sends.slice(startLen);
  assert(sent.length >= 1 && sent.every(message => message.accepted && String(message.user_id) === from));
  for (const entry of sent) {
    const receipt = readOneBotLedger(channelDir, db => db.prepare('SELECT status FROM outbound WHERE message_id=?').get(entry.messageId));
    assert.equal(receipt?.status, 'sent', 'OneBot receipt was not recorded');
  }
  return {sent, messageId: id.split(':').at(-1)};
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

const readFilesAudit = (sql, ...params) => {
  const db = new DatabaseSync(path.join(state, 'state/files/files.sqlite'), {readOnly: true});
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
};
const readLeaseAudit = (sql, ...params) => {
  const db = new DatabaseSync(path.join(state, 'state/scoped-lease/leases.sqlite'), {readOnly: true});
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
};

let editSnapshotId, deleteSnapshotId, cleanupProposal, leaseProposal, activeLeaseId;

try {
  await step('start isolated gateway with kurumi-files and migrated exec fence', start, 'environment');

  await step('migrated exec keeps pilot workdir writable while refusing 下载 and 文档 writes', async () => {
    await turn(owner, '试试普通命令写入沙箱与下载目录', [
      {
        name: 'exec',
        args: {command: 'printf OK > pilot.txt && cat pilot.txt'},
        verify: result => assert.match(JSON.stringify(result), /OK/),
      },
      {
        name: 'exec',
        direct: true,
        args: {command: 'pwd', workdir: downloads},
        verify: result => assert.match(JSON.stringify(result), /owner_exec_workdir_outside_boundary/),
      },
      {
        name: 'exec',
        direct: true,
        args: {command: `touch '${path.join(downloads, 'blocked-by-fence.txt')}'`},
        verify: result => assert.match(JSON.stringify(result), /Permission denied|EACCES|EROFS|failed|exited|error/i),
      },
    ]);
    assert.equal(fs.readFileSync(path.join(execWorkdir, 'pilot.txt'), 'utf8'), 'OK');
    assert(!fs.existsSync(path.join(downloads, 'blocked-by-fence.txt')));
  });

  await step('kurumi_files performs T0/T1 single-file CRUD with automatic snapshots and verified restore', async () => {
    const spaceFile = path.join(kurumiSpace, 'draft.md');
    const dlFile = path.join(downloads, 'note.txt');
    const deskFile = path.join(desktop, 'stage2b.txt');
    await turn(owner, '在草稿区和主目录一般工作区读写并还原测试文件', [
      {
        name: 'kurumi_files',
        args: {action: 'roots'},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.defaultWorkspace, kurumiSpace);
          assert.equal(result.t1Roots.length, 1);
          assert.equal(result.t1Roots[0].path, fakeHome);
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: spaceFile, content: 'draft-v1', mode: 'create'},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.tier, 'T0');
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: deskFile, content: 'desktop-v1', mode: 'create'},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.tier, 'T1');
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'search', path: fakeHome, query: 'NEEDLE'},
        verify(result) {
          assert.equal(result.ok, true);
          assert.deepEqual(result.matches.map(m => m.path), [path.join(desktop, 'desk-note.txt')]);
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: dlFile, content: `初始版本 ${PRIVATE_SENTINEL}`, mode: 'create'},
        verify: result => assert.equal(result.tier, 'T1'),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'edit', path: dlFile, oldText: '初始版本', newText: '修改版本'},
        verify(result) {
          assert.equal(result.ok, true);
          assert(result.snapshotId);
          editSnapshotId = result.snapshotId;
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'delete', path: dlFile},
        verify(result) {
          assert.equal(result.ok, true);
          assert(result.snapshotId);
          deleteSnapshotId = result.snapshotId;
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: () => ({action: 'restore', snapshotId: editSnapshotId}),
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.path, dlFile);
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read', path: dlFile},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.content, `初始版本 ${PRIVATE_SENTINEL}`);
        },
      },
    ]);
    assert(editSnapshotId && deleteSnapshotId && editSnapshotId !== deleteSnapshotId);
  });

  await step('T2 read-only, dotfiles, toolchains, T3 redlines, and symlink escapes are rejected', async () => {
    await turn(owner, '试试读取只读仓以及敏感路径和软链逃逸', [
      {
        name: 'kurumi_files',
        args: {action: 'read', path: path.join(repoRo, 'README.md')},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.content, 'repository-readonly-content\n');
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: path.join(repoRo, 'hack.txt'), content: 'no'},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_t2_readonly_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: path.join(fakeHome, '.evil-rc'), content: 'no'},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_t2_readonly_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: path.join(miniconda, 'evil.py'), content: 'no'},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_t2_readonly_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read', path: path.join(xwechatDir, 'session.db')},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_redline_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read', path: path.join(keyringsDir, 'login.keyring')},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_redline_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read', path: path.join(state, 'openclaw.json')},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_redline_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read', path: path.join(downloads, '.env.local')},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_redline_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read', path: path.join(downloads, 'escape-to-ssh')},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_redline_denied'}),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'write', path: path.join(downloads, 'escape-to-ssh'), content: 'x', mode: 'overwrite'},
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_symlink_not_allowed'}),
      },
    ]);
  });

  await step('cleanup_dir uses host_files natural confirmation with compact preview and rejects replay', async () => {
    const pvTurn = await turn(owner, '帮我把 cleanup-batch 目录清掉并直接执行', [
      {
        name: 'kurumi_files',
        args: {action: 'propose', operation: 'cleanup_dir', path: cleanupDir, includeRoot: true},
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'pending');
          assert.equal(result.domain, 'host_files');
          assert.equal(result.itemCount, 3);
          assert(result.previewText.length < 240);
          assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(result.previewText));
          assert(!/[a-f0-9]{32,}/iu.test(result.previewText));
          cleanupProposal = result;
        },
      },
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'host_files', proposalId: cleanupProposal.proposalId, payloadHash: cleanupProposal.payloadHash}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'proposal_not_presented'}),
      },
      {
        name: 'kurumi_files',
        args: () => ({action: 'commit', proposalId: cleanupProposal.proposalId}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'approval_required'}),
      },
    ], '已整理清理清单并展示，确认后再执行。');

    const sentText = pvTurn.sent.map(textOfSend).join('\n');
    for (const fact of cleanupProposal.presentationFacts) assert(sentText.includes(fact), `Missing fact ${JSON.stringify(fact)} in sentText: ${JSON.stringify(sentText)}`);
    assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(sentText));
    assert(readFilesAudit('SELECT presented_at_utc FROM confirmation_previews WHERE proposal_id=?', cleanupProposal.proposalId)?.presented_at_utc);
    assert(fs.existsSync(cleanupDir));

    await turn(owner, '确认', [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'host_files', proposalId: cleanupProposal.proposalId, payloadHash: cleanupProposal.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'kurumi_files',
        args: () => ({action: 'commit', proposalId: cleanupProposal.proposalId}),
        verify(result) {
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.snapshotsCreated, 2);
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: () => ({action: 'commit', proposalId: cleanupProposal.proposalId}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'files_proposal_already_submitted'}),
      },
    ]);
    assert(!fs.existsSync(cleanupDir));
  });

  await step('scoped_lease activates after confirmation, bounds apply_leased, and revokes immediately', async () => {
    const lpTurn = await turn(owner, '申请一个下载目录批删与写入租约', [{
      name: 'kurumi_lease',
      args: {
        action: 'propose',
        label: '整理下载目录临时文件',
        actions: ['files.batch_delete', 'files.write'],
        roots: [downloads],
        maxOps: 4,
        maxBytes: 16384,
        ttlSeconds: 600,
      },
      verify(result) {
        assert.equal(result.ok, true);
        assert.equal(result.domain, 'scoped_lease');
        assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(result.previewText));
        leaseProposal = result;
      },
    }], '已生成任务租约预览，请确认后激活。');

    const sentText = lpTurn.sent.map(textOfSend).join('\n');
    for (const fact of leaseProposal.presentationFacts) assert(sentText.includes(fact));
    assert(readLeaseAudit('SELECT presented_at_utc FROM confirmation_previews WHERE proposal_id=?', leaseProposal.proposalId)?.presented_at_utc);

    await turn(owner, '确认', [
      {
        name: 'personal_confirmation',
        args: () => ({action: 'confirm', domain: 'scoped_lease', proposalId: leaseProposal.proposalId, payloadHash: leaseProposal.payloadHash}),
        verify: result => assert.equal(result.ok, true),
      },
      {
        name: 'kurumi_lease',
        args: () => ({action: 'commit', proposalId: leaseProposal.proposalId}),
        verify(result) {
          assert.equal(result.ok, true);
          assert.equal(result.status, 'active');
          activeLeaseId = result.leaseId;
        },
      },
      {
        name: 'kurumi_files',
        args: () => ({action: 'apply_leased', leaseId: activeLeaseId, operation: 'batch_delete', paths: [batchDel1, batchDel2]}),
        verify(result) {
          assert.equal(result.ok, true, JSON.stringify(result));
          assert.equal(result.snapshotsCreated, 2);
          assert.equal(result.lease.usedOps, 2);
          assert.equal(result.lease.remainingOps, 2);
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: () => ({action: 'apply_leased', leaseId: activeLeaseId, operation: 'batch_delete', paths: [docProtected]}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'lease_scope_violation'}),
      },
      {
        name: 'kurumi_lease',
        args: () => ({action: 'revoke', leaseId: activeLeaseId, reason: 'done'}),
        verify: result => assert.equal(result.state, 'revoked'),
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: () => ({action: 'apply_leased', leaseId: activeLeaseId, operation: 'write', path: path.join(downloads, 'after-revoke.txt'), content: 'x'}),
        verify: result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code: 'lease_revoked'}),
      },
    ]);
    assert(!fs.existsSync(batchDel1) && !fs.existsSync(batchDel2));
    assert(fs.existsSync(docProtected));
  });

  await step('member cannot discover or invoke kurumi_files, kurumi_lease, or their confirmations', async () => {
    await turn(member, '我也试试查看文件和租约', [
      {
        name: 'kurumi_files',
        searchOnly: true,
        verify: result => assert(!JSON.stringify(result).includes('"name":"kurumi_files"')),
      },
      {
        name: 'kurumi_files',
        args: {action: 'roots'},
        direct: true,
        verify: result => assert.match(JSON.stringify(result), /unknown|not found|not available|capability_not_allowed|forbidden|not allowed/i),
      },
      {
        name: 'kurumi_lease',
        args: {action: 'list'},
        direct: true,
        verify: result => assert.match(JSON.stringify(result), /unknown|not found|not available|capability_not_allowed|forbidden|not allowed/i),
      },
      {
        name: 'personal_confirmation',
        args: {action: 'list', domain: 'host_files'},
        direct: true,
        verify: result => assert.match(JSON.stringify(result), /unknown|not found|not available|capability_not_allowed|forbidden|not allowed/i),
      },
      {
        name: 'personal_confirmation',
        args: {action: 'list', domain: 'scoped_lease'},
        direct: true,
        verify: result => assert.match(JSON.stringify(result), /unknown|not found|not available|capability_not_allowed|forbidden|not allowed/i),
      },
    ]);
  });

  await step('log-query correlates files and lease trace events plus access audit without leaking content', async () => {
    const traceOut = JSON.parse(execFileSync(process.execPath, [
      path.join(repo, 'chatbot/scripts/log-query.mjs'),
      '--runtime-root', state,
      '--source', 'trace-events',
      '--since', '1h',
      '--json',
    ], {encoding: 'utf8'}));
    const kinds = new Set(traceOut.events.map(ev => ev.kind));
    for (const expected of [
      'files.op', 'files.proposed', 'files.committed', 'files.leased_applied',
      'lease.proposed', 'lease.activated', 'lease.revoked',
    ]) {
      assert(kinds.has(expected), `Missing trace event kind: ${expected}`);
    }
    assert(!JSON.stringify(traceOut).includes(PRIVATE_SENTINEL));

    const accessOut = JSON.parse(execFileSync(process.execPath, [
      path.join(repo, 'chatbot/scripts/log-query.mjs'),
      '--runtime-root', state,
      '--source', 'access-control',
      '--since', '1h',
      '--json',
    ], {encoding: 'utf8'}));
    assert(accessOut.events.some(ev => ev.data?.tool === 'kurumi_files' && ev.data?.decision === 'allow'));
    assert(accessOut.events.some(ev => ev.data?.tool === 'kurumi_lease' && ev.data?.decision === 'allow'));
    assert(accessOut.events.some(ev => ev.data?.tool === 'exec' && ev.data?.decision === 'deny' && ev.data?.code === 'owner_exec_workdir_outside_boundary'));
  });

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  report.diagnosticsRoot = root;
  process.exitCode = 1;
} finally {
  scenarioProgress('stop isolated gateway', 'started', 'cleanup');
  const stopped = await stop();
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
  report.fixtureCleaned = !fs.existsSync(root);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.fixtureError ?? report.error, evidence: out}));
}
