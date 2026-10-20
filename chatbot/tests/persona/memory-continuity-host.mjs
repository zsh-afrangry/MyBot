// Document 25 P2: real isolated OpenClaw + real kurumi-memory continuity plugin.
// Deterministic local model and simulated OneBot only; no production state, QQ, mail or paid API.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {personaFiles, applyPersonaFile} from '../../packages/access-control/workspaces.js';
import {ownerPolicy, memberRow, OWNER, MEMBER} from '../access-control/fixtures.mjs';
import {emptyState} from '../../plugins/kurumi-memory/continuity/model.js';
import {initializeContinuity, replaceNotice, openContinuityStore} from '../../plugins/kurumi-memory/continuity/store.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const outIndex = process.argv.indexOf('--out'), out = outIndex < 0 ? null : process.argv[outIndex + 1];
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Require a new absolute --out evidence file');
if (process.argv.includes('--live')) throw Error('Memory continuity host is deterministic; no live API');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-memory-host-'));
const token = randomBytes(24).toString('hex'), bot = '900001';
const report = {
  at: new Date().toISOString(), live: false, model: 'local/deterministic', cases: [], requests: 0,
  toolCalls: [], modelChecks: [], mockSends: 0,
  boundary: 'Real isolated OpenClaw and real kurumi-memory/kurumi-qq plugins; deterministic model and simulated OneBot. Temporary state only; no model provider, QQ, mail, production write or service restart.',
};
const policy = ownerPolicy(); policy.subjects.push(memberRow());
const fixtureRepo = path.join(root, 'source');
const sourceConfig = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'), 'utf8'));
const persona = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
for (const relative of ['config/persona.json', 'config/runtime.config.json', 'config/access-control.json', persona.roleFile,
  ...Object.values(persona.relationshipFiles), 'scripts/fusion/templates/AGENTS.md', 'scripts/fusion/templates/MEMBER_AGENTS.md']) {
  fs.mkdirSync(path.dirname(path.join(fixtureRepo, relative)), {recursive: true});
  fs.copyFileSync(path.join(repo, relative), path.join(fixtureRepo, relative));
}
fs.writeFileSync(path.join(fixtureRepo, 'config/access-control.json'), JSON.stringify(policy));

let activeTurn = null;
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages ?? [];
    assert(++report.requests <= 30, 'deterministic model request budget exhausted');
    const json = JSON.stringify(body);
    // Tool Search results can be projected as user-like messages by some
    // provider adapters. Anchor the fixture to the actual ingress text so
    // replayed tool results cannot reset the search/call state.
    const user = [...messages].reverse().find(message => {
      const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
      return message?.role === 'user' && /MEMORY_HOST_(?:SAVE|READ)/.test(content);
    }) ?? [...messages].reverse().find(message => message.role === 'user');
    const userText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
    const available = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
    const allAssistantCalls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
    const priorMemoryWrapperCall = allAssistantCalls.some(call => {
      if (call.function?.name !== 'tool_call') return false;
      try { return JSON.parse(call.function.arguments ?? '{}').id === 'kurumi_memory'; } catch { return false; }
    });
    const checks = {
      label: activeTurn?.label, owner: activeTurn?.qq === OWNER, userText,
      personalContext: json.includes('KURUMI_PERSONAL_MEMORY_V2'),
      savedFactInContext: json.includes('我喜欢绿茶'),
      // In compact Tool Search mode the direct name is intentionally hidden;
      // a prior exact tool_call proves the owner can reach the capability.
      memoryToolAvailable: available.includes('kurumi_memory') || priorMemoryWrapperCall,
      toolNames: available, containsSaveMarker: json.includes('MEMORY_HOST_SAVE'),
    };
    report.modelChecks.push(checks);
    const afterUser = messages.slice(messages.lastIndexOf(user) + 1);
    const businessCall = allAssistantCalls.some(call => ['kurumi_memory', 'tool_call'].includes(call.function?.name));
    const searchAlreadyRequested = allAssistantCalls.some(call => call.function?.name === 'tool_search');
    const shouldSave = json.includes('MEMORY_HOST_SAVE') && !businessCall;
    const saveArgs = {action: 'observe', expectedRevision: 0, facts: [{text: '我喜欢绿茶', evidence: '我喜欢绿茶', kind: 'preference'}]};
    let tool = shouldSave && !available.includes('kurumi_memory') && available.includes('tool_search') && !searchAlreadyRequested
      ? {id: 'memory-search-' + report.requests, type: 'function', function: {name: 'tool_search', arguments: JSON.stringify({query: 'kurumi_memory', limit: 1})}}
      : shouldSave && !available.includes('kurumi_memory') && available.includes('tool_call')
        ? {id: 'memory-call-wrapper-' + report.requests, type: 'function', function: {name: 'tool_call', arguments: JSON.stringify({id: 'kurumi_memory', args: saveArgs})}}
        : shouldSave && available.includes('kurumi_memory') ? {
      id: 'memory-call-' + report.requests, type: 'function', function: {name: 'kurumi_memory', arguments: JSON.stringify({
        ...saveArgs,
      })},
    } : null;
    if (tool) report.toolCalls.push({name: tool.function.name, arguments: JSON.parse(tool.function.arguments), label: activeTurn?.label});
    const message = tool ? {role: 'assistant', content: null, tool_calls: [tool]} : {role: 'assistant', content: 'MEMORY_HOST_FIXTURE_OK'};
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (body.stream) {
      const base = {id: 'chatcmpl-memory-host', object: 'chat.completion.chunk', created: 1, model: 'fixture'};
      res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: tool ? {role: 'assistant', tool_calls: [{...tool, index: 0}]} : message, finish_reason: null}]}) + '\n\n');
      res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: tool ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else res.end(JSON.stringify({id: 'chatcmpl-memory-host', object: 'chat.completion', choices: [{index: 0, message, finish_reason: tool ? 'tool_calls' : 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
  } catch (error) {res.writeHead(500); res.end(JSON.stringify({error: {message: 'memory_fixture_failed:' + error.message}}));}
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');

const onebot = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) {res.writeHead(401); res.end(); return;}
  let raw = ''; for await (const chunk of req) raw += chunk;
  const args = raw ? JSON.parse(raw) : {};
  if (req.url === '/send_private_msg') report.mockSends++;
  res.end(JSON.stringify({status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? {user_id: Number(bot)} : {}}));
});
onebot.listen(0, '127.0.0.1'); await once(onebot, 'listening');
const ws = new WebSocketServer({server: onebot});
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const gatewayPort = probe.address().port; await new Promise(resolve => probe.close(resolve));

const cfg = JSON.parse(JSON.stringify(sourceConfig)); delete cfg._managed;
cfg.gateway = {mode: 'local', port: gatewayPort, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}};
cfg.models = {providers: {'memory-fixture': {baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic', api: 'openai-completions',
  models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1200, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}};
const workspace = path.join(root, 'workspace');
cfg.agents = {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary: 'memory-fixture/fixture'}, heartbeat: {every: '0m'}, compaction: {enabled: false}}, entries: {
  main: {workspace, model: {primary: 'memory-fixture/fixture'}, tools: {profile: 'full', allow: ['kurumi_memory', 'session_status'], deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn']}},
  ['qq-user-' + MEMBER]: {workspace: path.join(root, 'users', MEMBER, 'workspace'), model: {primary: 'memory-fixture/fixture'}, tools: {profile: 'messaging', allow: ['session_status'], deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn', 'kurumi_memory']}},
}};
cfg.channels = {'kurumi-qq': {enabled: true, ownerId: OWNER, accessControl: policy, httpUrl: `http://127.0.0.1:${onebot.address().port}`, wsUrl: `ws://127.0.0.1:${onebot.address().port}`,
  httpTokenFile: path.join(root, 'http-token'), wsTokenFile: path.join(root, 'ws-token'), stateDir: path.join(root, 'channel'), mediaRoot: path.join(root, 'media'), testIngress: true, dailySendLimit: 100, segmentDelayMs: 0}};
cfg.plugins = {allow: ['kurumi-qq', 'kurumi-memory'], load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-qq'), path.join(repo, 'chatbot/plugins/kurumi-memory')]}, entries: {
  'kurumi-qq': {enabled: true}, 'kurumi-memory': {enabled: true, config: {continuity: {enabled: true, summaryTtlDays: 7, maxContextChars: 6000}, continuityPolicyAdapter: 'current-owner', continuityStoreAdapter: 'sqlite'}, hooks: {allowConversationAccess: true, allowPromptInjection: true}},
}, slots: {memory: 'none'}};
cfg.session = {dmScope: 'per-channel-peer'}; cfg.cron = {enabled: false}; cfg.logging = {file: path.join(root, 'runtime.log')};
cfg.tools = {deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}};
const compiled = compileAccessConfig(cfg, policy);
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(root, file), token, {mode: 0o600});
fs.mkdirSync(path.join(root, 'channel'), {recursive: true, mode: 0o700}); fs.mkdirSync(path.join(root, 'media'), {recursive: true, mode: 0o700});
for (const [file, content] of personaFiles(fixtureRepo, root).files) applyPersonaFile(file, content);
initializeContinuity(workspace, emptyState(OWNER)); replaceNotice(workspace);
fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(compiled), {mode: 0o600});

const gatewayLog = path.join(root, 'gateway.log'), fd = fs.openSync(gatewayLog, 'w', 0o600);
let child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
  cwd: repo, env: {...process.env, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_AGENT_DIR: path.join(root, 'agents/main/agent')}, stdio: ['ignore', fd, fd], detached: true,
}); fs.closeSync(fd);
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
const call = (method, params = {}, timeout = 100000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${gatewayPort}`, token, timeout: String(timeout), json: true}, params);
let messageId = 1;
async function turn(label, qq, text) {
  activeTurn = {label, qq};
  const result = await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(qq), message_id: ++messageId, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text}}]}});
  assert(result.ok, `inbound failed: ${label}`); return result;
}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {try {await call('health', {}, 1200); ready = true; break;} catch {if (child.exitCode !== null) throw Error('isolated_gateway_exited'); await new Promise(resolve => setTimeout(resolve, 300));}}
  assert(ready, 'isolated gateway did not become ready');
  const saved = await turn('owner-automatic-save', OWNER, 'MEMORY_HOST_SAVE 我喜欢绿茶');
  const afterSave = openContinuityStore({workspace, ownerId: OWNER, readonly: true}); let state;
  try {state = afterSave.read();} finally {afterSave.close();}
  assert.equal(state.facts.length, 1); assert.equal(state.facts[0].text, '我喜欢绿茶'); assert.equal(state.revision, 1);
  report.cases.push({label: 'owner-automatic-save', passed: true, captured: saved.captured?.length ?? 0});
  const resumed = await turn('owner-memory-injection', OWNER, 'MEMORY_HOST_READ');
  const ownerCheck = report.modelChecks.at(-1); assert(ownerCheck.personalContext && ownerCheck.savedFactInContext && ownerCheck.memoryToolAvailable);
  report.cases.push({label: 'owner-memory-injection', passed: true, context: {personal: ownerCheck.personalContext, fact: ownerCheck.savedFactInContext}});
  const reset = await call('sessions.reset', {key: `agent:main:kurumi-qq:direct:${OWNER}`, reason: 'new'}); assert.equal(reset.ok, true);
  await turn('owner-after-new', OWNER, 'MEMORY_HOST_READ'); const resetCheck = report.modelChecks.at(-1);
  assert(resetCheck.personalContext && resetCheck.savedFactInContext); report.cases.push({label: 'owner-after-new', passed: true});
  await turn('member-isolation', MEMBER, 'MEMORY_HOST_READ'); const memberCheck = report.modelChecks.at(-1);
  assert.equal(memberCheck.personalContext, false); assert.equal(memberCheck.savedFactInContext, false); assert.equal(memberCheck.memoryToolAvailable, false);
  report.cases.push({label: 'member-isolation', passed: true});
  report.passed = true;
} catch (error) {report.passed = false; report.error = error.message; report.diagnosticsRoot = root; process.exitCode = 1;}
finally {
  if (child?.exitCode === null) {child.kill('SIGTERM'); let timer; await Promise.race([once(child, 'exit'), new Promise(resolve => {timer = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {} resolve();}, 20000);})]); clearTimeout(timer);}
  for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve));
  await new Promise(resolve => onebot.close(resolve)); await new Promise(resolve => model.close(resolve));
  report.childStopped = child?.exitCode !== null || child?.signalCode !== null; report.mockSends = report.mockSends;
  fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, requests: report.requests, error: report.error, evidence: out}));
}
