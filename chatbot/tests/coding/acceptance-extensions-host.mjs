// Isolated OpenClaw Gateway acceptance for Doc 37 Stage 3A (external Git), 3B (selfMaintenance), and 4 (backend adapters).
// Uses local deterministic model, loopback OneBot, local bare remote + synthetic repos, real Landlock, and headless CLI adapter.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {git} from '../../plugins/kurumi-coding/workspaces.js';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy, memberRow} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {createOneBotPeer, readOneBotLedger, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !path.isAbsolute(out ?? '') || fs.existsSync(out)) {
  throw Error('Require a new absolute --out');
}
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-coding-ext-host-'));
const state = path.join(root, 'state');
const boundary = path.join(root, 'boundary');
const externalRepo = path.join(root, 'external-repo');
const bareOrigin = path.join(root, 'origin.git');
const selfRepo = path.join(root, 'synthetic-kurumi-fusion');
const fakeRuntimeCanary = path.join(root, 'fake-openclaw-fusion');
const dshHome = path.join(root, 'dsh-home');
for (const dir of [state, boundary, externalRepo, selfRepo, fakeRuntimeCanary, dshHome]) {
  fs.mkdirSync(dir, {recursive: true, mode: 0o700});
}

// Stage 3A fixture: external real Git repository with bare origin remote and local dirty/untracked files.
git(root, 'init', '--bare', bareOrigin);
git(externalRepo, 'init', '-b', 'master');
fs.writeFileSync(path.join(externalRepo, 'app.mjs'), 'export const version = 1;\n');
fs.writeFileSync(path.join(externalRepo, 'local-dirty.txt'), 'keep clean\n');
git(externalRepo, 'add', '.');
git(externalRepo, '-c', 'user.name=Ext', '-c', 'user.email=ext@localhost', 'commit', '-m', 'ext init');
git(externalRepo, 'remote', 'add', 'origin', bareOrigin);
fs.writeFileSync(path.join(externalRepo, 'local-dirty.txt'), 'user unstaged dirty\n');
fs.writeFileSync(path.join(externalRepo, 'untracked.note'), 'untracked preserved\n');

// Stage 3B fixture: synthetic kurumi-fusion self-maintenance repo + fake .openclaw-fusion canary.
fs.writeFileSync(path.join(fakeRuntimeCanary, 'openclaw.json'), '{"runtime":"untouched"}\n');
fs.mkdirSync(path.join(selfRepo, 'config'), {recursive: true});
fs.mkdirSync(path.join(selfRepo, 'src'), {recursive: true});
fs.writeFileSync(path.join(selfRepo, 'config/access-control.json'), '{"subjects":[]}\n');
fs.writeFileSync(path.join(selfRepo, 'src/core.mjs'), 'export const factor = 2;\n');
git(selfRepo, 'init', '-b', 'main');
git(selfRepo, 'add', '.');
git(selfRepo, '-c', 'user.name=Maint', '-c', 'user.email=maint@localhost', 'commit', '-m', 'self init');
const selfBaseline = git(selfRepo, 'rev-parse', 'HEAD').trim();

const extCheck = path.join(boundary, 'ext-check.mjs');
fs.writeFileSync(extCheck, `
  import assert from 'node:assert/strict';
  import fs from 'node:fs';
  import path from 'node:path';
  import {pathToFileURL} from 'node:url';
  const mod = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE, 'app.mjs')));
  assert.equal(mod.version, 2);
  let denied = false;
  try { fs.writeFileSync(${JSON.stringify(path.join(externalRepo, 'escape.txt'))}, 'x'); }
  catch (e) { denied = ['EACCES', 'EPERM', 'EROFS'].includes(e.code); }
  assert.equal(denied, true);
`);

const selfCheck = path.join(boundary, 'self-check.mjs');
fs.writeFileSync(selfCheck, `
  import assert from 'node:assert/strict';
  import path from 'node:path';
  import {pathToFileURL} from 'node:url';
  const mod = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE, 'src/core.mjs')));
  assert.equal(mod.factor, 10);
`);

// Stage 4 headless CLI adapter binary outside writeBoundary.
const cliAdapterJs = path.join(root, 'fake-claude-cli.cjs');
const cliAdapterBin = path.join(root, 'fake-claude-cli.sh');
const cliBody = `
  const fs = require('fs'), path = require('path');
  let prompt = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', d => prompt += d);
  process.stdin.on('end', () => {
    // Attempt direct writes to externalRepo & runtime canary — kernel Landlock MUST block.
    for (const target of [${JSON.stringify(path.join(externalRepo, 'hack.txt'))}, ${JSON.stringify(path.join(fakeRuntimeCanary, 'openclaw.json'))}]) {
      try { fs.writeFileSync(target, 'pwn'); process.exit(8); } catch {}
    }
    if (prompt.includes('EXT_UPDATE')) {
      fs.writeFileSync(path.join(process.cwd(), 'app.mjs'), ${JSON.stringify('export const version = 2;\n')});
      process.stdout.write(${JSON.stringify('EXT_CLI_DONE\n')});
    } else if (prompt.includes('SELF_BAD_DIFF')) {
      fs.writeFileSync(path.join(process.cwd(), 'src/core.mjs'), ${JSON.stringify('export const factor = 10;\n')});
      fs.writeFileSync(path.join(process.cwd(), 'config/access-control.json'), ${JSON.stringify('{"hack":true}\n')});
      process.stdout.write(${JSON.stringify('SELF_BAD_DONE\n')});
    } else if (prompt.includes('SELF_GOOD_DIFF')) {
      fs.writeFileSync(path.join(process.cwd(), 'src/core.mjs'), ${JSON.stringify('export const factor = 10;\n')});
      process.stdout.write(${JSON.stringify('SELF_GOOD_DONE\n')});
    }
  });
`;
fs.writeFileSync(cliAdapterJs, cliBody, {mode: 0o600});
fs.writeFileSync(cliAdapterBin, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(cliAdapterJs)} "$@"\n`, {mode: 0o700});

const owner = '100001';
const bot = '100002';
const member = '100003';
const token = randomBytes(24).toString('hex');
const tokenFile = path.join(root, 'onebot-token');
fs.writeFileSync(tokenFile, token, {mode: 0o600});

const onebot = await createOneBotPeer({token, botId: bot, subjects: [owner, member]});
const {sends} = onebot;
const report = {at: new Date().toISOString(), boundary: 'Isolated Gateway, external real Git, self-maintenance gate, CLI adapter under Landlock.', cases: []};

let active, requestSeq = 0;
const model = http.createServer(async (req, res) => {
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages ?? [];
    const text = c => typeof c === 'string' ? c : (c ?? []).map(v => v.text ?? '').join('\n');
    const lastUser = messages.findLast(m => m.role === 'user');
    const userText = text(lastUser?.content);

    const sendChoice = msg => {
      const base = {id: 'ext-fg', created: 1, model: 'fixture'};
      const finish_reason = msg.tool_calls ? 'tool_calls' : 'stop';
      if (!body.stream) {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({...base, object: 'chat.completion', choices: [{index: 0, message: msg, finish_reason}]}));
        return;
      }
      const delta = msg.tool_calls ? {...msg, tool_calls: msg.tool_calls.map((tool, index) => ({...tool, index}))} : msg;
      const chunk = (value, reason) => 'data: ' + JSON.stringify({...base, object: 'chat.completion.chunk', choices: [{index: 0, delta: value, finish_reason: reason}]}) + '\n\n';
      res.setHeader('content-type', 'text/event-stream');
      res.end(chunk(delta, null) + chunk({}, finish_reason) + 'data: [DONE]\n\n');
    };

    // Background completion notice run: reply concisely.
    if (messages.some(m => text(m.content).includes('以下是绑定当前用户的业务结果')) && !active) {
      return sendChoice({role: 'assistant', content: '后台完成通知：' + userText.slice(0, 80)});
    }

    assert(active, `No active foreground turn (roles=${messages.map(m => m.role).join(',')}, last=${userText.slice(0, 200)})`);
    if (active.observe) {
      const lastTool = messages.findLast(m => m.role === 'tool');
      let parsed = lastTool?.content;
      try { parsed = JSON.parse(parsed); } catch {}
      active.observe(parsed);
      active.observe = undefined;
    }
    const step = active.steps[active.next];
    const msg = step
      ? {role: 'assistant', content: null, tool_calls: [{id: 'c_' + ++requestSeq, type: 'function', function: {name: step.name, arguments: JSON.stringify(typeof step.args === 'function' ? step.args() : step.args)}}]}
      : {role: 'assistant', content: active.reply ?? '完成。'};
    if (step) {
      active.next++;
      active.observe = step.verify;
    }
    sendChoice(msg);
  } catch (error) {
    report.fixtureError = error.message;
    res.writeHead(400).end(error.message);
  }
});

model.listen(0, '127.0.0.1');
await once(model, 'listening');
const modelAddr = '127.0.0.1:' + model.address().port;

const policy = ownerPolicy(owner);
policy.subjects.push(memberRow(member));

const launcher = '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run';
const codingConfig = {
  pilot: true,
  writeBoundary: {root: boundary, launcher},
  root: path.join(boundary, 'state'),
  worktrees: path.join(boundary, 'worktrees'),
  dsh: {command: cliAdapterBin, home: dshHome, model: ['fixture', 'fixture']},
  backends: {
    'claude-code': {driver: 'cli', command: cliAdapterBin, args: ['--headless'], promptMode: 'stdin', model: 'sonnet'},
  },
  projects: [
    {id: 'ext-repo', root: externalRepo, branch: 'master', externalRoot: true, allowRemote: true, checks: [{name: 'ext check', argv: [process.execPath, extCheck]}]},
    {id: 'self-maint', root: selfRepo, branch: 'main', externalRoot: true, selfMaintenance: true, checks: [{name: 'self check', argv: [process.execPath, selfCheck]}]},
  ],
};

const cfg = withHostControl(compileAccessConfig({
  agents: {
    ownership: 'explicit',
    defaults: {workspace: path.join(state, 'workspace'), heartbeat: {every: '0m'}, systemAgent: {agentId: 'main'}, model: {primary: 'fixture/fixture'}},
    entries: {main: {workspace: path.join(state, 'workspace'), tools: {alsoAllow: ['kurumi_code', 'personal_confirmation']}}},
  },
  models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: `http://${modelAddr}/v1`, apiKey: 'synthetic', api: 'openai-completions',
    models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 262144, maxTokens: 1000}]}}},
  plugins: {
    allow: ['kurumi-coding', 'kurumi-qq', 'personal-confirmation'],
    load: {paths: ['kurumi-coding', 'kurumi-qq', 'personal-confirmation'].map(p => path.join(repo, 'chatbot/plugins', p))},
    entries: {
      'kurumi-coding': {enabled: true, config: codingConfig},
      'kurumi-qq': {enabled: true},
      'personal-confirmation': {enabled: true, hooks: {allowConversationAccess: true}},
    },
    slots: {memory: 'none'},
  },
  channels: {
    'kurumi-qq': {enabled: true, httpUrl: onebot.httpUrl, wsUrl: onebot.wsUrl, httpTokenFile: tokenFile, wsTokenFile: tokenFile,
      stateDir: path.join(state, 'channel'), mediaRoot: path.join(state, 'media'), testIngress: false, segmentDelayMs: 0},
  },
  session: {dmScope: 'per-channel-peer'},
  cron: {enabled: false},
  update: {checkOnStart: false},
  tools: {toolSearch: false, codeMode: false, web: {search: {enabled: false}, fetch: {enabled: false}}},
  logging: {file: path.join(state, 'runtime.log')},
}, policy), repo);

fs.mkdirSync(cfg.agents.defaults.workspace, {recursive: true});
const coding = await (async () => {
  const host = await startIsolatedGateway({repo, root: state, token, configure: () => cfg});
  return host;
})();

async function qqTurn(from, text, steps, reply = '完成。') {
  active = {next: 0, calls: 0, steps, reply};
  const startLen = sends.length;
  const id = await onebot.send(onebot.message(from, text));
  await waitForOneBotTurn(path.join(state, 'channel'), [id], {
    timeoutMs: 25000,
    check() { onebot.check(); assert(!report.fixtureError, report.fixtureError); },
  });
  assert.equal(active.next, steps.length);
  active = undefined;
  return sends.slice(startLen);
}

try {
  await coding.ready();
  await waitForAcceptance(onebot.connected, 'OneBot socket');

  let extTaskId, extPreview, selfTaskId, selfPreview;

  // Stage 4 + 3A: list backends -> start claude-code on externalRepo -> preview -> confirm -> merge --ff-only.
  await qqTurn(owner, '列出编码后端并在外部仓库用 claude-code 更新版本号', [
    {
      name: 'kurumi_code',
      args: {action: 'list'},
      verify(r) {
        assert(r.backends.includes('claude-code'));
        assert(r.backendDetails.some(b => b.id === 'claude-code' && b.driver === 'cli'));
        assert(r.projects.some(p => p.id === 'ext-repo'));
        assert(r.projects.some(p => p.id === 'self-maint'));
      },
    },
    {
      name: 'kurumi_code',
      args: {action: 'start', projectId: 'ext-repo', backend: 'claude-code', title: '外部版本升级', task: 'EXT_UPDATE'},
      verify(r) {
        assert.equal(r.backend, 'claude-code');
        extTaskId = r.id;
      },
    },
  ], '已在外部仓库启动 claude-code 任务。');

  await waitForAcceptance(() => {
    const entry = sends.find(s => textOfSend(s).includes(extTaskId.slice(0, 8)));
    return entry;
  }, 'ext-repo task ready notification');

  const pvExtTurn = await qqTurn(owner, '预览外部仓库改动', [
    {
      name: 'kurumi_code',
      args: () => ({action: 'preview', taskId: extTaskId}),
      verify(r) {
        assert.equal(r.status, 'pending');
        assert.match(r.previewText, /不包含push/);
        extPreview = r;
      },
    },
  ], '外部改动预览已就绪，确认后合入。');
  assert(pvExtTurn.map(textOfSend).join('\n').includes(extPreview.presentationFacts[0].slice(0, 20)));

  await qqTurn(owner, '确认', [
    {
      name: 'personal_confirmation',
      args: () => ({action: 'confirm', domain: 'coding', proposalId: extPreview.proposalId, payloadHash: extPreview.payloadHash}),
      verify: r => assert.equal(r.ok, true),
    },
    {
      name: 'kurumi_code',
      args: () => ({action: 'merge', taskId: extTaskId, proposalId: extPreview.proposalId}),
      verify: r => assert.equal(r.state, 'merged'),
    },
  ], '外部仓库已本地合入。');

  assert.match(fs.readFileSync(path.join(externalRepo, 'app.mjs'), 'utf8'), /version = 2/);
  assert.equal(fs.readFileSync(path.join(externalRepo, 'local-dirty.txt'), 'utf8'), 'user unstaged dirty\n');
  assert.equal(fs.readFileSync(path.join(externalRepo, 'untracked.note'), 'utf8'), 'untracked preserved\n');
  assert.equal(git(bareOrigin, 'for-each-ref').trim(), '');
  report.cases.push({name: 'stage3a_stage4_external_git_and_cli_adapter', passed: true});

  // Stage 3B: self-maintenance rejects protected config/access-control edit, then accepts safe edit.
  await qqTurn(owner, '启动自维护敏感路径防护测试', [{
    name: 'kurumi_code',
    args: {action: 'start', projectId: 'self-maint', backend: 'claude-code', title: '自维护越界检查', task: 'SELF_BAD_DIFF'},
    verify(r) { selfTaskId = r.id; },
  }]);
  await waitForAcceptance(() => sends.find(s => textOfSend(s).includes(selfTaskId.slice(0, 8))), 'self-maint bad task ready');

  await qqTurn(owner, '尝试预览含敏感配置修改的候选', [{
    name: 'kurumi_code',
    args: () => ({action: 'preview', taskId: selfTaskId}),
    verify: r => assert.match(JSON.stringify(r), /self_maintenance_protected_diff/),
  }]);

  let selfGoodId;
  await qqTurn(owner, '启动安全自维护测试任务', [{
    name: 'kurumi_code',
    args: {action: 'start', projectId: 'self-maint', backend: 'claude-code', title: '安全代码更新', task: 'SELF_GOOD_DIFF'},
    verify(r) { selfGoodId = r.id; },
  }]);
  await waitForAcceptance(() => sends.find(s => textOfSend(s).includes(selfGoodId.slice(0, 8))), 'self-maint good task ready');

  await qqTurn(owner, '预览安全自维护候选', [{
    name: 'kurumi_code',
    args: () => ({action: 'preview', taskId: selfGoodId}),
    verify(r) {
      assert.match(r.previewText, /不写\.openclaw-fusion、不自动重启服务/);
      selfPreview = r;
    },
  }], '安全自维护候选已预览。');

  await qqTurn(owner, '确认', [
    {
      name: 'personal_confirmation',
      args: () => ({action: 'confirm', domain: 'coding', proposalId: selfPreview.proposalId, payloadHash: selfPreview.payloadHash}),
      verify: r => assert.equal(r.ok, true),
    },
    {
      name: 'kurumi_code',
      args: () => ({action: 'merge', taskId: selfGoodId, proposalId: selfPreview.proposalId}),
      verify: r => assert.equal(r.state, 'merged'),
    },
  ], '安全自维护修改已合入。');

  assert.notEqual(git(selfRepo, 'rev-parse', 'HEAD').trim(), selfBaseline);
  assert.equal(fs.readFileSync(path.join(fakeRuntimeCanary, 'openclaw.json'), 'utf8'), '{"runtime":"untouched"}\n');
  assert.equal(Boolean(readOneBotLedger(path.join(state, 'channel'), db => db.prepare("SELECT count(*) as c FROM outbound WHERE status='sent'").get()).c), true);
  report.cases.push({name: 'stage3b_self_maintenance_gateway_gate', passed: true});

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  report.diagnosticsRoot = root;
  process.exitCode = 1;
} finally {
  report.gracefulStop = await coding.close();
  model.closeAllConnections();
  await Promise.all([onebot.close(), new Promise(resolve => model.close(resolve))]);
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error ?? report.fixtureError}));
}
