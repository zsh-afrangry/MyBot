// Isolated OpenClaw Gateway, deterministic loopback model, simulated OneBot HTTP/WS.
// Writes only its temporary source checkout and state, plus a new --out report.
// owner_tool starts the real KnowledgeMap API on a disposable SQLite database.
// Uses synthetic QQ identities and (for coding_project) a local ACP stub.
// No real QQ, paid model, DSH, production writes or production restart.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
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
import {git} from '../../plugins/kurumi-coding/workspaces.js';
import {applyPersonaFile, personaFiles} from '../../../scripts/fusion/lib/persona-workspaces.mjs';
import {createOneBotPeer, readOneBotLedger, textOfSend, waitForAcceptance, waitForOneBotTurn} from '../acceptance/onebot-peer.mjs';
import {startIsolatedKnowledgeMap} from '../knowledgemap/isolated-api.mjs';
import {ownerPolicy} from './fixtures.mjs';
import {withHostControl} from './host-config.mjs';

const [flag, out, mode, category = 'member', ...extra] = process.argv.slice(2);
assert(flag === '--out' && path.isAbsolute(out ?? '') && !fs.existsSync(out), 'Require a new absolute --out');
assert((mode === undefined || mode === '--category') && ['member', 'mail_recipient', 'owner_tool', 'exec_root', 'coding_project'].includes(category) && !extra.length);
const repo = fileURLToPath(new URL('../../../', import.meta.url));
assert(path.resolve(out).startsWith(path.resolve(repo, 'test-output') + path.sep), 'Use test-output for evidence');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-access-admin-host-'));
const state = path.join(root, 'state');
const channelDir = path.join(state, 'channel');
const source = path.join(root, 'source');
const policyFile = path.join(source, 'config/access-control.json');
const intentFile = path.join(source, 'config/runtime.config.json');
const runtimeFile = path.join(state, 'openclaw.json');
const owner = '100001', bot = '100002', member = '100003';
const toolRun = category === 'owner_tool', projectRun = category === 'coding_project';
const token = randomBytes(24).toString('hex');
const readPolicy = () => JSON.parse(fs.readFileSync(policyFile, 'utf8'));
const writeJson = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o600});
const report = {openclaw: JSON.parse(fs.readFileSync(path.join(repo, 'node_modules/openclaw/package.json'))).version,
  boundary: 'Isolated Gateway, deterministic model and simulated OneBot. Synthetic source and state.',
  category, cases: [], requests: 0, primaryModel: 'fixture/fixture'};

for (const dir of ['config', 'roles', 'scripts/fusion/templates']) fs.mkdirSync(path.join(source, dir), {recursive: true});
for (const dir of ['workspace', 'channel', 'media']) fs.mkdirSync(path.join(state, dir), {recursive: true});
const policy = ownerPolicy(owner);
if (toolRun) policy.subjects.push({qq: member, kind: 'user', role: 'member', enabled: true,
  permissions: {'chat.use': true, 'qq.reply': true}, mailRecipients: []});
writeJson(policyFile, policy);
fs.writeFileSync(path.join(source, 'roles/fixture.md'), 'Synthetic persona');
writeJson(path.join(source, 'config/persona.json'), {identityName: 'Fixture', roleFile: 'roles/fixture.md', userFile: 'Synthetic owner', agentsIntro: 'Fixture intro'});
fs.writeFileSync(path.join(source, 'scripts/fusion/templates/AGENTS.md'), '{{PERSONA_INTRO}}\n<!-- owner-exec-scope -->\nUse the registered typed tools.');
fs.copyFileSync(path.join(repo, 'scripts/fusion/templates/MEMBER_AGENTS.md'), path.join(source, 'scripts/fusion/templates/MEMBER_AGENTS.md'));
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(state, file), token, {mode: 0o600});

let active, proposal, child, completingTask, knowledgeMap, liveConfig;
const onebot = await createOneBotPeer({token, botId: bot, subjects: [owner, member]});
const {sends} = onebot;
function unwrap(value) {
  for (let i = 0; i < 6; i++) {
    if (typeof value === 'string') { try { value = JSON.parse(value); } catch { return value; } }
    else if (value?.result && !value.task) value = value.result;
    else if (value?.content?.length === 1) value = value.content[0].text;
    else break;
  }
  return value;
}
function modelReply(body, tool, res, text = '宿主测试回复。') {
  const choice = tool ? {role: 'assistant', content: null, tool_calls: [{id: 'call_' + report.requests,
    type: 'function', function: {name: tool[0], arguments: JSON.stringify(tool[1])}}]}
    : {role: 'assistant', content: text};
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
    if (req.url !== '/v1/chat/completions' || req.method !== 'POST') {res.writeHead(404).end(); return;}
    let raw = '';
    for await (const bytes of req) raw += bytes;
    res.setHeader('content-type', 'application/json');
    const body = JSON.parse(raw);
    assert(++report.requests <= (projectRun ? 125 : toolRun ? 90 : 60), 'Unexpected model request count');
    // Only the synthetic ACP gate can release the background notice, between foreground turns.
    if (!active && completingTask) return modelReply(body, undefined, res, '合成任务完成 ' + completingTask);
    assert(active, 'Unexpected foreground model request');
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
    return modelReply(body, ['dispatch_action', {id: step.name, args: typeof step.args === 'function' ? step.args() : step.args}], res);
  } catch (error) {
    report.fixtureError = error.message;
    res.writeHead(400);
    res.end(JSON.stringify({error: {message: 'isolated_access_fixture_failed'}}));
  }
});
server.listen(0, '127.0.0.1');
await once(server, 'listening');
const probe = net.createServer().listen(0, '127.0.0.1');
await once(probe, 'listening');
const port = probe.address().port;
await new Promise(resolve => probe.close(resolve));
const endpoint = `127.0.0.1:${server.address().port}`;
const admin = 'kurumi-access-admin', confirmation = 'personal-confirmation';
const mail = 'kurumi-mail', mailRun = category === 'mail_recipient', bills = 'kurumi-knowledgemap';
const execRun = category === 'exec_root', fixed = path.join(root, 'exec-fixed');
const base = path.join(root, 'ordinary'), extraRoot = path.join(base, '目录 A');
const launcher = '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run';
const coding = 'kurumi-coding', pilot = path.join(root, 'pilot'), codingRoot = path.join(pilot, 'coding-state');
const projectRoot = path.join(pilot, 'synthetic-project'), gates = path.join(pilot, 'gates');
const fakePeer = path.join(pilot, 'synthetic-peer'), fakeHome = path.join(pilot, 'fake-home');
const projectCheckProfiles = Object.fromEntries(['basic', 'other'].map(id => [id, [{name: id + ' check', argv: ['/usr/bin/true']}]]));
let projectHead;
if (execRun) {
  fs.mkdirSync(fixed);
  fs.mkdirSync(extraRoot, {recursive: true});
}
if (projectRun) {
  for (const dir of [projectRoot, gates, fakeHome]) fs.mkdirSync(dir, {recursive: true});
  git(projectRoot, 'init', '-b', 'main');
  fs.writeFileSync(path.join(projectRoot, 'value.mjs'), 'export const value = 1;\n');
  git(projectRoot, 'add', '.');
  git(projectRoot, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'Synthetic project');
  projectHead = git(projectRoot, 'rev-parse', 'HEAD').trim();
  const quote = value => "'" + value.replaceAll("'", "'\\''") + "'";
  fs.writeFileSync(fakePeer, '#!/bin/bash\nexec ' + [process.execPath,
    path.join(repo, 'chatbot/tests/coding/acp-peer.mjs'), '--project-registry-fixture', gates].map(quote).join(' ') + ' "$@"\n', {mode: 0o700});
}
const plugins = ['kurumi-qq', admin, confirmation, ...(mailRun ? [mail] : []), ...(toolRun ? [bills] : []), ...(projectRun ? [coding] : [])];
const workspace = path.join(state, 'workspace');
const model = {primary: 'fixture/fixture'};
const config = withHostControl({
  gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
  discovery: {mdns: {mode: 'off'}}, update: {checkOnStart: false},
  models: {catalogRefresh: {enabled: false}, providers: {fixture: {baseUrl: `http://${endpoint}/v1`, apiKey: 'synthetic', api: 'openai-completions',
    models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1200,
      cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}},
  agents: {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model, heartbeat: {every: '0m'}},
    entries: {main: {workspace, model, tools: {profile: 'messaging',
      alsoAllow: ['personal_confirmation', 'kurumi_access', ...(mailRun ? ['email_draft', 'email_send'] : []), ...(execRun ? ['exec'] : []),
        ...(projectRun ? ['kurumi_code'] : [])],
      deny: ['read', 'write', 'edit', 'apply_patch', ...(!execRun ? ['exec'] : []), 'process', 'message', 'sessions_spawn'],
      ...(execRun ? {exec: {host: 'gateway', mode: 'full', timeoutSeconds: 10, notifyOnExit: false}} : {}),
    }}}},
  channels: {'kurumi-qq': {enabled: true, httpUrl: onebot.httpUrl, wsUrl: onebot.wsUrl,
    httpTokenFile: path.join(state, 'http-token'), wsTokenFile: path.join(state, 'ws-token'),
    stateDir: channelDir, mediaRoot: path.join(state, 'media'), testIngress: !toolRun, dailySendLimit: 100, segmentDelayMs: 0}},
  plugins: {allow: [...plugins], load: {paths: plugins.map(id => path.join(repo, 'chatbot/plugins', id))}, entries: {
    'kurumi-qq': {enabled: true, ...(execRun ? {config: {
      exec: {workdir: fixed, timeoutSeconds: 10, writeBoundary: {root: fixed, launcher}},
    }} : {})}, [admin]: {enabled: true, config: {sourceRoot: source,
      ...(category !== 'member' ? {enabledCategories: [category]} : {}),
      ...(execRun ? {execDirectoryBases: [base]} : {}), ...(projectRun ? {projectCheckProfiles} : {})}},
    [confirmation]: {enabled: true, hooks: {allowConversationAccess: true}},
    ...(mailRun ? {[mail]: {enabled: true}} : {}),
    ...(projectRun ? {[coding]: {enabled: true, config: {pilot: true, root: codingRoot, worktrees: path.join(pilot, 'worktrees'),
      dsh: {command: fakePeer, home: fakeHome, model: ['fixture', 'fixture']}, projects: [],
      writeBoundary: {root: pilot, launcher}}}} : {}),
  }, slots: {memory: 'none'}},
  tools: {codeMode: false, deny: [...(!execRun ? ['exec'] : []), 'process', 'message', 'sessions_spawn'],
    web: {search: {enabled: false}, fetch: {enabled: false}}},
  session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, logging: {file: path.join(state, 'runtime.log')},
}, repo);
const call = (method, params = {}, timeout = 40000) => callGatewayFromCli(method,
  {config: liveConfig, url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params,
  {deviceIdentity: null, sharedStateMode: 'read-only'});

async function start() {
  for (const [file, contents] of personaFiles(source, state).files) applyPersonaFile(file, contents);
  liveConfig = compileAccessConfig(JSON.parse(fs.readFileSync(intentFile)), readPolicy());
  writeJson(runtimeFile, liveConfig);
  const fd = fs.openSync(path.join(state, 'gateway.log'), 'a', 0o600);
  try {
    child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run',
      '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
      cwd: toolRun ? state : repo, detached: true, stdio: ['ignore', fd, fd], env: {PATH: process.env.PATH, HOME: toolRun ? state : process.env.HOME,
        OPENCLAW_EXEC_SHELL_SNAPSHOT: '0',
        LANG: 'C.UTF-8', OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: state, OPENCLAW_CONFIG_PATH: runtimeFile,
        OPENCLAW_AGENT_DIR: path.join(state, 'agents/main/agent')},
    });
  } finally { fs.closeSync(fd); }
  let ready = false;
  for (let i = 0; i < 60; i++) {
    assert.equal(child.exitCode, null, 'Isolated Gateway exited during startup');
    try { await call('health', {}, 1200); ready = true; break; } catch { await delay(300); }
  }
  assert(ready, 'Isolated Gateway not ready');
  if (toolRun) await waitForAcceptance(onebot.connected, 'OneBot socket');
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
  let sessionKey;
  if (toolRun) {
    const id = await onebot.send(onebot.message(from, text));
    await waitForOneBotTurn(channelDir, [id], {timeoutMs: 20000, check() {
      onebot.check(); assert(!report.fixtureError, report.fixtureError);
    }});
  } else {
    const result = await inbound(from, text);
    assert(result.ok && result.modelDispatched, JSON.stringify(result));
    sessionKey = result.sessionKey;
  }
  onebot.check();
  assert(!report.fixtureError, report.fixtureError);
  assert.equal(active.next, steps.length);
  assert.equal(active.observe, undefined, 'Last tool result not observed');
  active = undefined;
  const sent = sends.slice(start);
  assert(sent.length >= 1 && sent.every(message => message.accepted && String(message.user_id) === from));
  if (toolRun) for (const entry of sent) {
    const receipt = readOneBotLedger(channelDir, db => db.prepare('SELECT status FROM outbound WHERE message_id=?').get(entry.messageId));
    assert.equal(receipt?.status, 'sent', 'OneBot receipt was not recorded');
  }
  return {sent, sessionKey};
}
const adminTool = (args, verify) => ({name: 'kurumi_access', args, verify});
const confirm = verify => ({name: 'personal_confirmation', args: () => ({action: 'confirm', domain: 'access',
  proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}), verify});
const commit = verify => adminTool(() => ({action: 'commit', proposalId: proposal.proposalId}), verify);
const isError = code => result => assert.deepEqual({ok: result.ok, code: result.code}, {ok: false, code});
function readAudit(sql, ...params) {
  const db = new DatabaseSync(path.join(state, 'state/access-admin/changes.sqlite'), {readOnly: true});
  try { return db.prepare(sql).get(...params); } finally { db.close(); }
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

  await turn(owner, '预览移除测试成员', [adminTool({action: 'propose', change: {op: 'remove', qq: member}}, result => {
    assert(result.ok && result.status === 'pending'); proposal = result;
  })]);
  await turn(owner, '确认', [
    confirm(result => assert(result.ok)), commit(result => assert(result.ok && result.sourceRevision === 3)),
  ]);
  await stop(); await start();
  const revoked = {requests: report.requests, sends: sends.length};
  assert((await inbound(member, '同步撤权后的测试')).ignored);
  assert.deepEqual({requests: report.requests, sends: sends.length}, revoked);
  assert(fs.existsSync(path.join(state, 'users', member, 'workspace', 'AGENTS.md')));
  report.cases.push('Revocation removes access on restart and preserves the member workspace');
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

async function toolScenario() {
  const name = 'knowledge_bills_get';
  const seeded = await knowledgeMap.web('bills/', 'POST', {expense_date: '2026-10-17', amount: '36.80', note: '白名单验收账单'});
  assert(Number.isSafeInteger(seeded.id) && seeded.version === 1 && seeded.amount === '36.80');
  const readIntent = () => JSON.parse(fs.readFileSync(intentFile));
  const originalIntent = readIntent(), grantedIntent = structuredClone(originalIntent);
  grantedIntent.agents.entries.main.tools.alsoAllow.push(name);
  const select = (action, fields = {}) => ({action, category, ...fields});
  const ok = result => assert.equal(result.ok, true, JSON.stringify(result));
  const entry = (source, runtime) => adminTool(select('get', {key: name}), result => {
    ok(result);
    assert.deepEqual({source: result.source, runtime: result.runtime, inSync: result.inSync, available: result.available.includes(name)},
      {source, runtime, inSync: source === runtime, available: runtime === name});
  });
  const status = (id, activation) => adminTool({action: 'status', proposalId: id}, result => {
    ok(result);
    assert.equal(result.activation, activation);
  });
  const appears = result => JSON.stringify(result).includes('"name":"' + name + '"');
  const notVisible = {name, searchOnly: true, verify: result => assert(!appears(result), 'Bill tool should be hidden')};
  const query = {action: 'list', query: seeded.note};
  const denied = {name, args: query, direct: true, verify: result => {
    assert.match(JSON.stringify(result), /not found|not available|unknown|unavailable|forbidden|not allowed/i);
  }};
  const queried = {name, args: query, verifySearch: result => assert(appears(result), 'Bill tool should be visible'), verify: result => {
    ok(result);
    assert.equal(result.total, 1);
    const [{id, version, note, amount}] = result.items;
    assert.deepEqual({id, version, note, amount},
      {id: seeded.id, version: seeded.version, note: seeded.note, amount: seeded.amount});
    active.reply = '账单「' + note + '」金额 ' + amount + ' 元。';
  }};
  const assertReply = ({sent}) => {
    assert(sent.map(textOfSend).join('\n').includes('账单「' + seeded.note + '」金额 ' + seeded.amount + ' 元。'));
  };
  const traceFile = path.join(state, 'state/knowledgemap/trace.jsonl');
  const reads = count => {
    const records = fs.existsSync(traceFile) ? fs.readFileSync(traceFile, 'utf8').trim().split('\n').map(line => JSON.parse(line)) : [];
    assert.equal(records.length, count, 'Unexpected KnowledgeMap bridge request count');
    for (const record of records) {
      assert.deepEqual({method: record.data.method, path: record.data.path, status: record.data.status},
        {method: 'GET', path: '/api/assistant/bills', status: 200});
    }
    report.knowledgeMapReads = count;
  };
  const show = async (op, sameTurn = false) => {
    const before = readIntent();
    const preview = await turn(owner, (op === 'add' ? '加上' : '移除') + '主人工具白名单里的账单查询工具，先给我看预览。', [
      adminTool(select('propose', {change: {op, key: name}}), result => {
        ok(result);
        assert(result.status === 'pending' && result.previewText.includes(name));
        proposal = result;
      }),
      ...(sameTurn ? [confirm(isError('confirmation_not_explicit')), commit(isError('approval_required'))] : []),
    ]);
    assert(preview.sent.map(textOfSend).join('\n').includes(proposal.previewText), 'OneBot must receive the frozen tool change');
    const receipt = readAudit('SELECT presented_at_utc, presentation_message_id FROM confirmation_previews WHERE proposal_id=?', proposal.proposalId);
    assert(receipt.presented_at_utc && preview.sent.some(message => message.messageId === receipt.presentation_message_id));
    assert.deepEqual(readIntent(), before);
    assert.equal(readAudit('SELECT COUNT(*) AS count FROM approval_grants WHERE proposal_id=?', proposal.proposalId).count, 0);
    return proposal.proposalId;
  };
  const write = (...steps) => turn(owner, '确认', [
    confirm(result => {ok(result); assert.equal(result.status, 'authorized');}),
    commit(result => {ok(result); assert.equal(result.activation, 'pending_sync');}),
    commit(isError('access_change_already_submitted')),
    ...steps,
  ]);
  await assert.rejects(call('kurumi-qq.testInbound', {}, 3000), /unknown method|not found/iu);
  const billMessage = '查一下备注为「' + seeded.note + '」的那笔账单金额。';
  await turn(owner, billMessage, [
    entry(null, null), notVisible, denied,
    adminTool(select('propose', {change: {op: 'add', key: 'exec'}}), isError('owner_tool_unavailable')),
  ]);
  reads(0);
  report.cases.push('Before allowlisting, the bill tool is hidden and denied; a host-denied tool cannot be added');

  const addition = await show('add', true);
  report.cases.push('A frozen preview reaches OneBot; same-turn assent and commit do not write or issue a grant');
  await write(entry(name, null));
  assert.deepEqual(readIntent(), grantedIntent);
  await turn(owner, billMessage, [notVisible, denied]);
  reads(0);
  report.cases.push('Later assent writes only one source entry; the unsynced runtime still denies the bill tool');

  await stop(); await start();
  assertReply(await turn(owner, billMessage, [status(addition, 'active'), entry(name, name), queried]));
  reads(1);
  report.cases.push('After synchronization and restart, the owner reads the exact website fixture bill through the real API and receives it on OneBot');
  await turn(member, billMessage, [notVisible, denied]);
  reads(1);
  report.cases.push('An admitted member cannot discover or run the owner bill tool and causes no business request');

  const removal = await show('remove');
  await write(entry(null, name));
  assert.deepEqual(readIntent(), originalIntent);
  assertReply(await turn(owner, billMessage, [status(removal, 'pending_sync'), queried]));
  reads(2);
  report.cases.push('Confirmed removal restores the source; the unsynced running instance still permits the read');

  await stop(); await start();
  await turn(owner, billMessage, [status(removal, 'active'), entry(null, null), notVisible, denied]);
  reads(2);
  assert.deepEqual(await knowledgeMap.web('bills/' + seeded.id), seeded);
  assert.equal(readAudit("SELECT COUNT(*) AS count FROM approval_grants WHERE status='consumed'").count, 2);
  report.cases.push('After the removal is synchronized, the tool is hidden and denied while the bill and administration are intact');
}

async function execScenario() {
  const select = (action, fields = {}) => ({action, category, ...fields});
  const ok = result => assert.equal(result.ok, true, JSON.stringify(result));
  const show = op => turn(owner, '预览合成可写目录变更', [adminTool(select('propose', {change: {op, key: extraRoot}}), result => {
    ok(result); assert(result.previewText.includes(extraRoot)); proposal = result;
  })]);
  const file = path.join(extraRoot, 'canary.txt');
  const probe = workdir => ({name: 'exec', args: {workdir, command: 'printf fixture > canary.txt'}, verify() {}});
  const forbidden = verify => ({name: 'exec',
    args: {workdir: extraRoot, command: `printf fixture > "${path.join(source, 'should-not-exist')}"`}, verify});

  await turn(owner, '查询可登记范围并拒绝受管配置目录', [
    adminTool(select('list'), result => { ok(result); assert.deepEqual(result.approvedBases, [base]); }),
    adminTool(select('propose', {change: {op: 'add', key: source}}), isError('exec_directory_protected')),
  ]);
  await show('add');
  await turn(owner, '确认', [confirm(ok), commit(ok), probe(extraRoot)]);
  assert(!fs.existsSync(file));
  report.cases.push('Outside approved bases is refused and a newly written source entry does not yet allow writing');
  await stop(); await start();
  assert(fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8').includes(extraRoot));
  await turn(owner, '验证运行中的目录限制', [probe(extraRoot), forbidden(result => assert(/denied|permitted/i.test(JSON.stringify(result))))]);
  assert.equal(fs.readFileSync(file, 'utf8'), 'fixture');
  assert(!fs.existsSync(path.join(source, 'should-not-exist')));
  report.cases.push('Persona projects the new scope; real isolated exec writes in the added root and refuses the source tree');
  await show('remove');
  await turn(owner, '确认', [confirm(ok), commit(ok)]);
  await stop(); await start();
  assert(!fs.readFileSync(path.join(workspace, 'AGENTS.md'), 'utf8').includes(extraRoot));
  fs.renameSync(file, path.join(extraRoot, 'preserved.txt'));
  await turn(owner, '核对撤销不删除资料并验固定根', [probe(extraRoot), probe(fixed)]);
  assert(!fs.existsSync(file));
  assert.equal(fs.readFileSync(path.join(extraRoot, 'preserved.txt'), 'utf8'), 'fixture');
  assert.equal(fs.readFileSync(path.join(fixed, 'canary.txt'), 'utf8'), 'fixture');
  report.cases.push('Removal revokes new writes after sync; prior files and the fixed root are preserved');
}

async function projectScenario() {
  const key = 'synthetic-project', select = (action, fields = {}) => ({action, category, ...fields});
  const ok = result => assert.equal(result.ok, true, JSON.stringify(result));
  const code = (args, verify) => ({name: 'kurumi_code', args, verify});
  const denied = reason => result => assert(JSON.stringify(result).includes(reason), JSON.stringify(result));
  const startTask = verify => code({action: 'start', projectId: key, task: 'Run the synthetic check.'}, verify);
  const show = async change => {
    const preview = await turn(owner, '预览合成编码项目变更', [adminTool(select('propose', {change}), result => {
      ok(result); assert.equal(result.status, 'pending'); proposal = result;
    })]);
    const sentText = preview.sent.flatMap(msg => msg.message).filter(segment => segment.type === 'text')
      .map(segment => segment.data.text).join('\n');
    assert(sentText.includes(proposal.previewText));
  };
  const write = (...steps) => turn(owner, '确认', [
    confirm(ok), commit(result => { ok(result); assert.equal(result.activation, 'pending_sync'); }), ...steps,
  ]);
  const projectList = result => assert.deepEqual(result.projects, []);
  await turn(owner, '检查空的项目名单', [
    code({action: 'list'}, projectList),
    adminTool(select('propose', {change: {op: 'add', key, root: projectRoot, kind: 'git', branch: 'main',
      checkProfile: 'invented'}}), isError('coding_check_profile_not_approved')),
  ]);
  await show({op: 'add', key, root: projectRoot, kind: 'git', branch: 'main', checkProfile: 'basic'});
  await write(startTask(denied('unknown_coding_project')));
  report.cases.push('Confirmed addition uses a known check profile and cannot start before sync');

  await stop(); await start();
  let taskId, candidate;
  await turn(owner, '先跑测试任务并尝试移除进行中的项目', [
    startTask(result => { assert(result.id, JSON.stringify(result)); taskId = result.id; }),
    adminTool(select('propose', {change: {op: 'remove', key}}), isError('coding_project_tasks_unsettled')),
  ]);
  const db = new DatabaseSync(path.join(codingRoot, 'coding.sqlite'), {readOnly: true});
  try {
    completingTask = taskId;
    fs.writeFileSync(path.join(gates, 'start'), '');
    for (let i = 0; i < 160; i++) {
      const task = JSON.parse(db.prepare('SELECT facts FROM coding_tasks WHERE id=?').get(taskId).facts);
      const facts = db.prepare('SELECT facts FROM coding_results WHERE task_id=? AND round_id=?').get(taskId, task.executionRoundId);
      if (facts && JSON.parse(facts.facts).finishedAt && ['platform_accepted', 'generation_failed', 'unknown'].includes(task.delivery?.state)) {
        assert.equal(task.state, 'ready', JSON.stringify({state: task.state, reason: task.reason}));
        assert.equal(task.delivery.state, 'platform_accepted', task.delivery.code);
        break;
      }
      if (i === 159) assert.fail('Synthetic coding task did not settle');
      await delay(50);
    }
  } finally { completingTask = undefined; db.close(); }
  await turn(owner, '生成旧合入候选', [code({action: 'preview', taskId}, result => {
    ok(result); candidate = result.proposalId;
  })]);
  const continueTask = reason => code({action: 'continue', taskId, task: 'Continue fixture.'}, denied(reason));
  const mergeTask = reason => code({action: 'merge', taskId, proposalId: candidate}, denied(reason));
  await show({op: 'update', key, checkProfile: 'other'});
  await write(continueTask('coding_project_pending_sync'), mergeTask('coding_project_pending_sync'));
  report.cases.push('While a task is active the project cannot be removed; source updates stop old execution until sync');

  await stop(); await start();
  const historical = result => assert(result.id === taskId && result.state === 'ready' && result.projectActive === false);
  await turn(owner, '确认新检查和旧任务记录', [
    adminTool(select('get', {key}), result => { ok(result); assert(result.inSync && result.runtime.checkProfile === 'other'); }),
    code({action: 'status', taskId}, historical),
    code({action: 'result', taskId}, result => { historical(result.task); assert(result.result.page.text.includes('fixture execution start')); }),
    continueTask('coding_project_registration_changed'), mergeTask('coding_project_registration_changed'),
  ]);
  const history = new DatabaseSync(path.join(codingRoot, 'coding.sqlite'), {readOnly: true});
  try {
    assert.equal(history.prepare('SELECT status FROM confirmation_proposals WHERE proposal_id=?').get(candidate).status, 'cancelled');
  } finally { history.close(); }
  report.cases.push('Synced updates retire old execution and cancel the old merge candidate while preserving the historical result');

  await show({op: 'remove', key});
  await write(startTask(denied('coding_project_pending_sync')));
  await stop(); await start();
  await turn(owner, '验证最后一个项目撤销后记录仍能查', [
    code({action: 'list'}, projectList), code({action: 'status', taskId}, historical),
    startTask(denied('unknown_coding_project')), continueTask('unknown_coding_project'), mergeTask('unknown_coding_project'),
  ]);
  assert.equal(git(projectRoot, 'rev-parse', 'HEAD').trim(), projectHead);
  assert.equal(fs.readFileSync(path.join(projectRoot, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  report.cases.push('An empty registry starts normally, preserves historical files, and rejects new execution and merge');
}

try {
  if (toolRun) {
    report.boundary = 'Real isolated Gateway and KnowledgeMap FastAPI/SQLite; loopback OneBot WebSocket/HTTP and deterministic model.';
    report.uncovered = ['real model semantics', 'real QQ platform', 'production configuration activation or KnowledgeMap MySQL'];
    try { knowledgeMap = await startIsolatedKnowledgeMap(root); }
    catch (error) { report.blocked = true; throw error; }
    config.plugins.entries[bills] = {enabled: true, config: knowledgeMap.config};
  }
  writeJson(intentFile, config);
  report.configSha256 = createHash('sha256').update(fs.readFileSync(intentFile)).digest('hex');
  await start();
  if (mailRun) await mailScenario();
  else if (toolRun) await toolScenario();
  else if (execRun) await execScenario();
  else if (projectRun) await projectScenario();
  else await memberScenario();
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = error.message;
  report.diagnosticsRoot = root;
  process.exitCode = 1;
} finally {
  await stop();
  await onebot.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  if (knowledgeMap && !await knowledgeMap.close()) {
    report.passed = false;
    report.error ??= 'KnowledgeMap API did not stop cleanly';
    process.exitCode = 1;
  }
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  report.fixtureCleaned = !fs.existsSync(root);
  fs.mkdirSync(path.dirname(out), {recursive: true});
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx', mode: 0o600});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, error: report.fixtureError ?? report.error, evidence: out}));
}
