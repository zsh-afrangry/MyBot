// Isolated OpenClaw Gateway acceptance for Stage 1: kurumi_files(read_structured) & owner QQ workspace file staging.
// Uses deterministic loopback model, loopback OneBot HTTP/WS, and disposable directories.
import {FIXTURE_CONTEXT_WINDOW, readFixtureJson} from '../acceptance/fixture-model.mjs';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {ownerPolicy} from '../access-control/fixtures.mjs';
import {withHostControl} from '../access-control/host-config.mjs';
import {fixtureOfficeXlsxUrl} from '../acceptance/fixtures/office-fetch.mjs';
import {startIsolatedGateway} from '../acceptance/isolated-gateway.mjs';
import {createOneBotPeer, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {scenarioProgress} from '../acceptance/scenario-lifecycle.mjs';

const [flag, out, ...extra] = process.argv.slice(2);
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out) && !extra.length, 'Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-office-host-'));
const state = path.join(root, 'state');
const channelDir = path.join(state, 'channel');
const workspace = path.join(state, 'workspace');
const memberWorkspace = path.join(state, 'users', '100003', 'workspace');
const fakeHome = path.join(root, 'fake-home');
const kurumiSpace = path.join(fakeHome, 'kurumi-space');
const downloads = path.join(fakeHome, '下载');
const sshDir = path.join(fakeHome, '.ssh');
const execWorkdir = path.join(root, 'exec-sandbox', 'source');
const tokenFile = path.join(state, 'onebot-token');
const token = randomBytes(24).toString('hex');

for (const d of [state, channelDir, path.join(state, 'media'), workspace, memberWorkspace, kurumiSpace, downloads, sshDir, execWorkdir]) {
  fs.mkdirSync(d, {recursive: true});
}
fs.writeFileSync(tokenFile, token, {mode: 0o600});
fs.writeFileSync(path.join(workspace, 'AGENTS.md'), '# Synthetic owner workspace\n');
fs.writeFileSync(path.join(memberWorkspace, 'AGENTS.md'), '# kurumi-isolated-member-v1\n');
fs.writeFileSync(path.join(downloads, 'local-bills.csv'), '日期,备注,金额\n2026-11-01,本地表格,23.50\n');
fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE_SSH_KEY_SENTINEL');
fs.symlinkSync(path.join(sshDir, 'id_ed25519'), path.join(downloads, 'escape.csv'));

const owner = '100001';
const bot = '100002';
const member = '100003';
const report = {
  at: new Date().toISOString(),
  openclaw: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/openclaw/package.json'), 'utf8')).version,
  boundary: 'Isolated Gateway, deterministic loopback model, loopback OneBot, substituted QQ file download bytes.',
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
function modelReply(body, tool, res, text = '办公文档验收完成。') {
  const choice = tool ? {
    role: 'assistant',
    content: null,
    tool_calls: [{id: 'call_' + report.requests, type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}],
  } : {role: 'assistant', content: text};
  const finish = tool ? 'tool_calls' : 'stop';
  const common = {id: 'chatcmpl-office', created: 1, model: 'fixture'};
  if (!body.stream) {
    return res.end(JSON.stringify({...common, object: 'chat.completion', choices: [{index: 0, message: choice, finish_reason: finish}]}));
  }
  res.setHeader('content-type', 'text/event-stream');
  const event = (delta, finish_reason) => 'data: ' + JSON.stringify({
    ...common, object: 'chat.completion.chunk', choices: [{index: 0, delta, finish_reason}],
  }) + '\n\n';
  const delta = tool ? {...choice, tool_calls: choice.tool_calls.map((c, idx) => ({...c, index: idx}))} : choice;
  res.end(event(delta, null) + event({}, finish) + 'data: [DONE]\n\n');
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') { res.writeHead(404).end(); return; }
    const body = await readFixtureJson(req);
    res.setHeader('content-type', 'application/json');
    assert(++report.requests <= 60, 'Unexpected model request budget exceeded');
    assert(active, 'Unexpected model request');
    if (active.memberNotice) {
      const names = body.tools?.map(tool => tool.function?.name) ?? [];
      assert(!names.includes('kurumi_files'), 'Member notice must not expose kurumi_files');
    }
    if (active.observe) {
      const last = body.messages.findLast(m => m.role === 'tool');
      active.observe(unwrap(last?.content));
      active.observe = undefined;
    }
    const step = active.steps[active.next];
    if (!step) return modelReply(body, undefined, res, active.reply);
    if (!step.direct && !active.found) {
      active.found = true;
      return modelReply(body, ['tool_search', {query: step.name, limit: 1}], res);
    }
    active.found = false;
    active.next++;
    active.observe = step.verify;
    const args = typeof step.args === 'function' ? step.args(body) : step.args;
    return modelReply(body, ['dispatch_action', {id: step.name, args}], res);
  } catch (error) {
    report.fixtureError = error.message;
    res.writeHead(400).end(JSON.stringify({error: {message: 'office_host_fixture_failed'}}));
  }
});

let gateway, peer;
try {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');

  let memberFileLookups = 0;
  peer = await createOneBotPeer({
    token,
    botId: bot,
    subjects: [owner, member],
    methods: {
      get_private_file_url({user_id, file_id}) {
        if (String(user_id) === member) {
          memberFileLookups++;
          throw Error('Member xlsx must not be looked up');
        }
        assert.equal(String(user_id), owner);
        assert.equal(file_id, 'office-xlsx-1');
        return {url: fixtureOfficeXlsxUrl};
      },
    },
  });

  const policy = ownerPolicy(owner);
  policy.subjects.push({
    qq: member,
    kind: 'user',
    role: 'member',
    enabled: true,
    permissions: {'chat.use': true, 'qq.reply': true},
    mailRecipients: [],
  });

  const plugins = ['kurumi-qq', 'kurumi-files'];
  const cfg = compileAccessConfig(withHostControl({
    models: {
      catalogRefresh: {enabled: false},
      providers: {
        fixture: {
          baseUrl: `http://127.0.0.1:${server.address().port}/v1`,
          apiKey: 'synthetic',
          api: 'openai-completions',
          models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: FIXTURE_CONTEXT_WINDOW, maxTokens: 1200}],
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
            alsoAllow: ['kurumi_files'],
            deny: ['read', 'write', 'edit', 'apply_patch', 'process', 'message', 'sessions_spawn'],
          },
        },
      },
    },
    channels: {
      'kurumi-qq': {
        enabled: true,
        httpUrl: peer.httpUrl,
        wsUrl: peer.wsUrl,
        httpTokenFile: tokenFile,
        wsTokenFile: tokenFile,
        stateDir: channelDir,
        mediaRoot: path.join(state, 'media'),
        testIngress: false,
        dailySendLimit: 100,
        segmentDelayMs: 0,
      },
    },
    plugins: {
      allow: plugins,
      load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))},
      entries: {
        'kurumi-qq': {enabled: true},
        'kurumi-files': {
          enabled: true,
          config: {
            homeDir: fakeHome,
            defaultWorkspace: kurumiSpace,
            t0Roots: [{path: kurumiSpace, label: '工作区'}],
            t1Roots: [{path: fakeHome, label: '主目录'}],
          },
        },
      },
      slots: {memory: 'none'},
    },
    tools: {codeMode: false, deny: ['process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
    session: {dmScope: 'per-channel-peer'},
    cron: {enabled: false},
    update: {checkOnStart: false},
    logging: {file: path.join(state, 'runtime.log')},
  }, repo), policy);

  gateway = await startIsolatedGateway({
    repo,
    root: state,
    token,
    configure: () => cfg,
    preload: new URL('../acceptance/fixtures/office-fetch.mjs', import.meta.url).href,
  });
  await gateway.ready();
  await waitForAcceptance(peer.connected, 'office OneBot socket');
  scenarioProgress('gateway-ready');

  // Case 1: Owner sends .xlsx over QQ -> staged to kurumi-space/qq-inbox -> read_structured reads OFFICE_HOST_NEEDLE.
  let stagedXlsxPath;
  active = {
    next: 0,
    reply: '已读取 QQ 发来的表格。',
    steps: [
      {
        name: 'kurumi_files',
        args: body => {
          const userMsg = body.messages.findLast(m => m.role === 'user'
            && JSON.stringify(m.content).includes('qq_attachment_results'));
          assert(userMsg, 'Missing staged attachment metadata');
          const rawText = typeof userMsg.content === 'string'
            ? userMsg.content
            : userMsg.content.map(part => part.text ?? '').join('\n');
          const match = rawText.match(/<qq_attachment_results>(.*?)<\/qq_attachment_results>/s);
          assert(match, 'Missing staged attachment metadata');
          const arr = JSON.parse(match[1]);
          stagedXlsxPath = arr[0].path;
          assert.equal(arr[0].status, 'staged_to_workspace');
          assert(stagedXlsxPath.startsWith(path.join(kurumiSpace, 'qq-inbox') + '/'));
          return {action: 'read_structured', path: stagedXlsxPath};
        },
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.format, 'xlsx');
          assert.equal(result.rows[0].values['科目'], 'OFFICE_HOST_NEEDLE');
          assert.equal(result.rows[0].values['金额'], 42.5);
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read_structured', path: path.join(downloads, 'local-bills.csv')},
        verify: result => {
          assert.equal(result.ok, true);
          assert.equal(result.format, 'csv');
          assert.equal(result.rows[0].values['备注'], '本地表格');
        },
      },
      {
        name: 'kurumi_files',
        direct: true,
        args: {action: 'read_structured', path: path.join(downloads, 'escape.csv')},
        verify: result => {
          assert.equal(result.ok, false);
          assert.equal(result.code, 'files_redline_denied');
        },
      },
    ],
  };

  const before1 = peer.sends.length;
  const ev1 = peer.message(owner, [
    {type: 'text', data: {text: '帮我看看这个表格和本地表格'}},
    {type: 'file', data: {name: '本月测试.xlsx', file_id: 'office-xlsx-1'}},
  ]);
  const msg1 = await peer.send(ev1);
  await waitForOneBotTurn(channelDir, [msg1]);
  assert(peer.sends.slice(before1).some(s => textOfSend(s).includes('已读取 QQ 发来的表格')));
  assert(!report.fixtureError, report.fixtureError);
  report.cases.push('owner_qq_xlsx_staging_and_read_structured_and_redline_guard');

  // Case 2: Member sends .xlsx -> rejected via isolated notice without file lookup or business dispatch.
  active = {next: 0, steps: [], memberNotice: true, reply: '成员仅支持上传 PDF 文档，暂不支持 xlsx。'};
  const before2 = peer.sends.length;
  const ev2 = peer.message(member, [{type: 'file', data: {name: 'member-bills.xlsx', file_id: 'member-xlsx-1'}}]);
  const msg2 = await peer.send(ev2);
  await waitForOneBotTurn(channelDir, [msg2]);
  assert.equal(memberFileLookups, 0);
  const memberReply = peer.sends.slice(before2).find(s => String(s.user_id) === member);
  assert(memberReply && memberReply.accepted, 'Member unsupported-type notice must be sent');
  assert(textOfSend(memberReply).includes('PDF'));
  report.cases.push('member_xlsx_rejected_before_download');

  // Verify trace-events.jsonl has both qq.workspace_file_receive and files.read_structured without cell/filename leaks
  const traceRaw = fs.readFileSync(path.join(channelDir, 'trace-events.jsonl'), 'utf8');
  assert(traceRaw.includes('qq.workspace_file_receive'));
  assert(traceRaw.includes('files.read_structured'));
  assert(!traceRaw.includes('OFFICE_HOST_NEEDLE'));
  assert(!traceRaw.includes('本月测试'));

  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = report.fixtureError ?? error.message;
} finally {
  report.gatewayStopped = await gateway?.close() ?? null;
  if (report.gatewayStopped === false) {
    report.passed = false;
    report.error ??= 'Isolated Gateway did not stop gracefully';
  }
  server.closeAllConnections();
  await Promise.all([peer?.close(), new Promise(resolve => server.close(resolve))]);
  report.configSha256 = gateway?.configSha256;
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  else { report.diagnosticsRoot = root; process.exitCode = 1; }
  report.fixtureCleaned = !fs.existsSync(root);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.error, evidence: out}));
}
