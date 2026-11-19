// Isolated OpenClaw Gateway, deterministic loopback model, simulated OneBot HTTP/WS.
// Writes only its temporary source checkout and state, plus a new --out report.
// Uses synthetic QQ identities. No real QQ, paid model, production writes or restart.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
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
import {WebSocketServer} from 'ws';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {applyPersonaFile, personaFiles} from '../../../scripts/fusion/lib/persona-workspaces.mjs';
import {ownerPolicy} from './fixtures.mjs';
import {withHostControl} from './host-config.mjs';

const [flag, out, mode, category = 'member', ...extra] = process.argv.slice(2);
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out), 'Require a new absolute --out');
assert((mode === undefined || mode === '--category') && ['member', 'mail_recipient'].includes(category) && !extra.length);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-access-admin-host-'));
const state = path.join(root, 'state');
const source = path.join(root, 'source');
const policyFile = path.join(source, 'config/access-control.json');
const intentFile = path.join(source, 'config/runtime.config.json');
const runtimeFile = path.join(state, 'openclaw.json');
const owner = '100001', bot = '100002', member = '100003';
const token = randomBytes(24).toString('hex');
const readPolicy = () => JSON.parse(fs.readFileSync(policyFile, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const report = {openclaw: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/openclaw/package.json'))).version,
  boundary: 'Isolated Gateway, deterministic model and simulated OneBot. Synthetic source and state.', category, cases: [], requests: 0};

for (const dir of ['config', 'roles', 'scripts/fusion/templates']) fs.mkdirSync(path.join(source, dir), {recursive: true});
for (const dir of ['workspace', 'channel', 'media']) fs.mkdirSync(path.join(state, dir), {recursive: true});
writeJson(policyFile, ownerPolicy(owner));
fs.writeFileSync(path.join(source, 'roles/fixture.md'), 'Synthetic persona');
writeJson(path.join(source, 'config/persona.json'), {identityName: 'Fixture', roleFile: 'roles/fixture.md', userFile: 'Synthetic owner'});
fs.writeFileSync(path.join(source, 'scripts/fusion/templates/AGENTS.md'), '<!-- owner-exec-scope -->\nUse the registered typed tools.');
fs.copyFileSync(path.join(repo, 'scripts/fusion/templates/MEMBER_AGENTS.md'), path.join(source, 'scripts/fusion/templates/MEMBER_AGENTS.md'));
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(state, file), token, {mode: 0o600});

let active, proposal, child;
const sends = [];
function unwrap(value) {
  for (let i = 0; i < 6; i++) {
    if (typeof value === 'string') value = JSON.parse(value);
    else if (value?.result) value = value.result;
    else if (value?.content?.length === 1) value = value.content[0].text;
    else break;
  }
  return value;
}
function modelReply(body, tool, res) {
  const choice = tool ? {role: 'assistant', content: null, tool_calls: [{id: 'call_' + report.requests,
    type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}]}
    : {role: 'assistant', content: '宿主测试回复。'};
  const finish = tool ? 'tool_calls' : 'stop';
  const usage = {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2};
  const common = {id: 'chatcmpl-access-admin', created: 1, model: 'fixture'};
  if (!body.stream) return res.end(JSON.stringify({...common, object: 'chat.completion', choices: [{index: 0, message: choice, finish_reason: finish}], usage}));
  res.setHeader('content-type', 'text/event-stream');
  const event = (delta, finish_reason) => 'data: ' + JSON.stringify({...common, object: 'chat.completion.chunk',
    choices: [{index: 0, delta, finish_reason}], usage}) + '\n\n';
  const delta = tool ? {...choice, tool_calls: choice.tool_calls.map((call, index) => ({...call, index}))} : choice;
  res.end(event(delta, null) + event({}, finish) + 'data: [DONE]\n\n');
}
const server = http.createServer(async (req, res) => {
  try {
    let raw = '';
    for await (const bytes of req) raw += bytes;
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/chat/completions') {
      assert(active && ++report.requests <= 60, 'Unexpected model request');
      const body = JSON.parse(raw);
      if (active.member) {
        const names = body.tools?.map(tool => tool.function?.name) ?? [];
        assert(!names.includes('kurumi_access') && !names.includes('personal_confirmation'));
      }
      if (active.observe) {
        const last = body.messages.findLast(message => message.role === 'tool');
        active.observe(unwrap(last?.content));
        active.observe = undefined;
      }
      const step = active.steps[active.next];
      if (!step) return modelReply(body, undefined, res);
      if (!active.found) {
        active.found = true;
        return modelReply(body, ['tool_search', {query: step.name, limit: 1}], res);
      }
      active.found = false;
      active.next++;
      active.observe = step.verify;
      return modelReply(body, ['dispatch_action', {id: step.name, args: typeof step.args === 'function' ? step.args() : step.args}], res);
    }
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    let data = {};
    if (req.url === '/get_login_info') data = {user_id: Number(bot)};
    if (req.url === '/send_private_msg') {
      const args = JSON.parse(raw);
      assert([owner, member].includes(String(args.user_id)));
      sends.push(args);
      data = {message_id: 20000 + sends.length};
    }
    return res.end(JSON.stringify({status: 'ok', retcode: 0, data}));
  } catch (error) {
    report.fixtureError = error.message;
    res.writeHead(400);
    res.end(JSON.stringify({error: {message: 'isolated_access_fixture_failed'}}));
  }
});
const ws = new WebSocketServer({server});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const probe = net.createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = `127.0.0.1:${server.address().port}`;
const admin = 'kurumi-access-admin', confirmation = 'personal-confirmation';
const mail = 'kurumi-mail', mailRun = category === 'mail_recipient';
const plugins = ['kurumi-qq', admin, confirmation, ...(mailRun ? [mail] : [])];
const workspace = path.join(state, 'workspace');
const model = {primary: 'fixture/fixture'};
const config = withHostControl({
  gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
  models: {providers: {fixture: {baseUrl: `http://${endpoint}/v1`, apiKey: 'synthetic', api: 'openai-completions',
    models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1200,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}},
  agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model, heartbeat: {every: '0m'}},
    entries: {main: {workspace, model, tools: {profile: 'messaging',
      alsoAllow: ['personal_confirmation', 'kurumi_access', ...(mailRun ? ['email_draft', 'email_send'] : [])],
      deny: ['read', 'write', 'edit', 'apply_patch', 'exec', 'process', 'message', 'sessions_spawn']}}}},
  channels: {'kurumi-qq': {enabled: true, httpUrl: `http://${endpoint}`, wsUrl: `ws://${endpoint}`,
    httpTokenFile: path.join(state, 'http-token'), wsTokenFile: path.join(state, 'ws-token'),
    stateDir: path.join(state, 'channel'), mediaRoot: path.join(state, 'media'), testIngress: true, dailySendLimit: 100, segmentDelayMs: 0}},
  plugins: {allow: [...plugins], load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))}, entries: {
    'kurumi-qq': {enabled: true}, [admin]: {enabled: true, config: {sourceRoot: source,
      ...(mailRun ? {enabledCategories: [category]} : {})}},
    [confirmation]: {enabled: true, hooks: {allowConversationAccess: true}},
    ...(mailRun ? {[mail]: {enabled: true}} : {}),
  }, slots: {memory: 'none'}},
  tools: {codeMode: false, deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
  session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, logging: {file: path.join(state, 'runtime.log')},
}, repo);
writeJson(intentFile, config);
const call = (method, params = {}, timeout = 40000) => callGatewayFromCli(method,
  {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);

async function start() {
  for (const [file, contents] of personaFiles(source, state).files) applyPersonaFile(file, contents);
  writeJson(runtimeFile, compileAccessConfig(JSON.parse(fs.readFileSync(intentFile)), readPolicy()));
  const fd = fs.openSync(path.join(state, 'gateway.log'), 'a', 0o600);
  try {
    child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run',
      '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
      cwd: repo, detached: true, stdio: ['ignore', fd, fd], env: {PATH: process.env.PATH, HOME: process.env.HOME,
        LANG: 'C.UTF-8', OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: runtimeFile,
        OPENCLAW_AGENT_DIR: path.join(state, 'agents/main/agent')},
    });
  } finally { fs.closeSync(fd); }
  for (let i = 0; i < 60; i++) {
    assert.equal(child.exitCode, null, 'Isolated Gateway exited during startup');
    try { await call('health', {}, 1200); return; } catch { await delay(300); }
  }
  assert.fail('Isolated Gateway not ready');
}

async function stop() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, 'exit');
  child.kill('SIGTERM');
  const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 8000);
  try { await exited; } finally { clearTimeout(timer); }
}

let sequence = 100;
const inbound = (from, text) => call('kurumi-qq.testInbound', {event: {post_type: 'message', message_type: 'private',
  self_id: Number(bot), user_id: Number(from), message_id: ++sequence, time: Math.floor(Date.now() / 1000),
  message: [{type: 'text', data: {text}}]}});
async function turn(from, text, steps) {
  active = {next: 0, steps, member: from === member};
  const start = sends.length;
  const result = await inbound(from, text);
  assert(!report.fixtureError, report.fixtureError);
  assert(result.ok && result.modelDispatched, JSON.stringify(result));
  assert.equal(active.next, steps.length);
  assert.equal(active.observe, undefined, 'Last tool result not observed');
  active = undefined;
  const sent = sends.slice(start);
  assert(sent.length >= 1 && sent.every(message => String(message.user_id) === from));
  return {sent, sessionKey: result.sessionKey};
}
const adminTool = (args, verify) => ({name: 'kurumi_access', args, verify});
const confirm = verify => ({name: 'personal_confirmation', args: () => ({action: 'confirm', domain: 'access',
  proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}), verify});
const commit = verify => adminTool(() => ({action: 'commit', proposalId: proposal.proposalId}), verify);
const isError = code => result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code});
function readAudit(sql) {
  const db = new DatabaseSync(path.join(state, 'state/access-admin/changes.sqlite'), {readOnly: true});
  try { return db.prepare(sql).get(); } finally { db.close(); }
}

async function memberScenario() {
  const initial = readPolicy();
  const preview = await turn(owner, '登记合成成员并直接确认', [
    adminTool({action: 'list'}, result => assert(result.ok && result.inSync && result.source.length === 0)),
    adminTool({action: 'propose', change: {op: 'add', qq: member, grant: ['chat.use', 'qq.reply']}}, result => {
      assert(result.ok && result.status === 'pending');
      proposal = result;
    }),
    confirm(isError('proposal_not_presented')),
    commit(isError('approval_required')),
  ]);
  const sentText = preview.sent.flatMap(msg => msg.message).filter(segment => segment.type === 'text').map(segment => segment.data.text).join('\n');
  assert(sentText.includes(proposal.previewText), 'OneBot must receive all frozen facts');
  assert(readAudit('SELECT presented_at_utc FROM confirmation_previews').presented_at_utc);
  assert.deepEqual(readPolicy(), initial);
  report.cases.push('Frozen preview delivered and same-turn confirmation refused');

  await turn(owner, '确认', [
    confirm(result => assert(result.ok && result.status === 'authorized')),
    commit(result => assert(result.ok && result.sourceRevision === 2 && result.runtimeRevision === 1)),
    commit(isError('access_change_already_submitted')),
    adminTool({action: 'get', qq: member}, result => assert(result.ok && !result.inSync && result.source.qq === member && result.runtime === null)),
  ]);
  assert.deepEqual(readPolicy().subjects.slice(0, -1), initial.subjects);
  assert.equal(readAudit('SELECT status FROM approval_grants').status, 'consumed');
  report.cases.push('Later owner assent writes once and reports pending runtime sync');

  const before = {requests: report.requests, sends: sends.length};
  assert((await inbound(member, '同步前的测试')).ignored);
  assert.deepEqual({requests: report.requests, sends: sends.length}, before);
  report.cases.push('Runtime still denies the member before deployment');

  await stop();
  await start();
  await turn(owner, '查询已经同步的合成成员', [adminTool({action: 'get', qq: member}, result => {
    assert(result.ok && result.inSync);
    assert.deepEqual(result.runtime, result.source);
  })]);
  const memberResponse = await turn(member, '工作区准备后的测试', []);
  assert.equal(memberResponse.sessionKey, `agent:qq-user-${member}:kurumi-qq:direct:${member}`);
  assert(fs.existsSync(path.join(state, 'users', member, 'workspace', 'AGENTS.md')));
  report.cases.push('Member gets an isolated session and own reply after persona projection, compilation and restart');
}

async function mailScenario() {
  const base = owner + '@qq.com', recipient = 'new-recipient@example.test';
  const select = (action, fields = {}) => ({action, category, ...fields});
  const freeze = result => { assert(result.ok && result.status === 'pending'); proposal = result; };
  const ok = result => assert(result.ok);
  const draftArgs = {to: base, cc: recipient, subject: 'Synthetic draft', text: 'Loopback only'};
  const draft = verify => ({name: 'email_draft', args: draftArgs, verify});
  const show = async (change, verify = freeze) => {
    const preview = await turn(owner, '请变更合成收件人并直接确认', [
      adminTool(select('propose', {change}), verify), confirm(isError('proposal_not_presented')),
    ]);
    const text = preview.sent.flatMap(msg => msg.message).filter(segment => segment.type === 'text')
      .map(segment => segment.data.text).join('\n');
    assert(text.includes(proposal.previewText), 'OneBot must receive the frozen mail recipient change');
  };
  await turn(owner, '查看邮件收件名单', [adminTool(select('list'), result => {
    assert(result.ok && result.inSync);
    assert.deepEqual(result.runtime, [base]);
  })]);
  await show({op: 'add', key: recipient});
  await turn(owner, '确认', [
    confirm(ok), commit(result => assert(result.ok && result.activation === 'pending_sync')),
    draft(isError('recipient_not_allowed')),
  ]);
  assert.deepEqual(readPolicy().subjects[0].mailRecipients, [base, recipient]);
  report.cases.push('QQ preview and later confirmation write only the source; unsynced Cc remains refused');
  const added = proposal;

  await stop(); await start();
  let draftId;
  await turn(owner, '查看生效并准备草稿', [
    adminTool({action: 'status', proposalId: added.proposalId}, result => assert(result.ok && result.activation === 'active')),
    draft(result => { assert(result.ok && result.cc.includes(recipient)); draftId = result.draftId; }),
  ]);
  report.cases.push('Compiled mail policy permits the new address after deployment');
  await show({op: 'remove', key: recipient});
  await turn(owner, '确认', [confirm(ok), commit(ok)]);
  await stop(); await start();
  await turn(owner, '核对撤销后的草稿与发送校验', [
    {name: 'email_send', args: {draftId}, verify: result => assert(!result.sent && result.code === 'recipient_not_allowed')},
    draft(isError('recipient_not_allowed')),
    {name: 'email_draft', args: {...draftArgs, to: recipient, cc: []}, verify: isError('recipient_not_allowed')},
    adminTool(select('get', {key: recipient}), result => assert(result.ok && result.inSync && result.source === null && result.runtime === null)),
  ]);
  report.cases.push('Revocation rejects both To and Cc, including an older draft, without opening SMTP');
}

try {
  await start();
  if (mailRun) await mailScenario();
  else await memberScenario();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  report.diagnosticsRoot = root;
  process.exitCode = 1;
} finally {
  await stop();
  for (const client of ws.clients) client.terminate();
  await new Promise(resolve => ws.close(resolve));
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.fixtureError ?? report.error, evidence: out}));
}
