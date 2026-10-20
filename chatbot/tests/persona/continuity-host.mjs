// docs/25 P2: hook identities, reset, manual compaction and restart in isolated OpenClaw.
// Hook observations are synthetic metadata only; memory activation is not part of this probe.
// Local deterministic model only; the optional --live flag is rejected before any I/O.
// Evidence: explicit new --out JSON in docs/verification/persona-memory-2026-10-19/p2/.
// Completed receipts and boundaries: docs/verification/persona-memory-2026-10-19/p2/README.md
// Temporary state and synthetic conversations only; no real QQ/mail, production writes or service restart.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash, randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {personaFiles, applyPersonaFile} from '../../packages/access-control/workspaces.js';
import {ownerPolicy, memberRow, OWNER, MEMBER, OTHER} from '../access-control/fixtures.mjs';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const index = process.argv.indexOf('--out'), out = index < 0 ? null : process.argv[index + 1];
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Require a new absolute --out evidence file');
if (process.argv.includes('--live')) throw Error('Lifecycle probe is deterministic; no live API');
const live = false;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-continuity-host-'));
const token = randomBytes(24).toString('hex'), bot = '900001';
const source = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'), 'utf8'));
const modelId = source.agents.entries.main.model.primary.split('/').at(-1);
const report = {
  at: new Date().toISOString(), live, model: 'local/deterministic',
  boundary: 'Real isolated OpenClaw, deterministic local model and simulated OneBot. Temporary state and explicit evidence only; no model provider calls, no QQ network, no mail, no production writes or production service restart.',
  cases: [], promptChecks: [], hookObservations: [], requests: 0, compactionRequests: 0, gatewayStarts: 0,
  usage: {promptTokens: 0, completionTokens: 0},
};
const hash = value => createHash('sha256').update(value).digest('hex');
const core = fs.readFileSync(path.join(repo, 'roles/世凪.md'), 'utf8');
let activeCase, child, sequence = 1;
const fake = ownerPolicy(); fake.subjects.push(memberRow(), memberRow(OTHER));
const fixtureRepo = path.join(root, 'source');
const persona = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
for (const relative of ['config/persona.json', 'config/runtime.config.json', persona.roleFile,
  ...Object.values(persona.relationshipFiles), 'scripts/fusion/templates/AGENTS.md', 'scripts/fusion/templates/MEMBER_AGENTS.md']) {
  fs.mkdirSync(path.dirname(path.join(fixtureRepo, relative)), {recursive: true});
  fs.copyFileSync(path.join(repo, relative), path.join(fixtureRepo, relative));
}
fs.writeFileSync(path.join(fixtureRepo, 'config/access-control.json'), JSON.stringify(fake));
for (const [file, content] of personaFiles(fixtureRepo, root).files) applyPersonaFile(file, content);
fs.writeFileSync(path.join(root, 'workspace/MEMORY.md'), 'OWNER_PRIVATE_PERSONA_SENTINEL');
const hookLog = path.join(root, 'hook-events.jsonl');
const pluginRoot = path.join(root, 'hook-probe'); fs.mkdirSync(pluginRoot);
fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({name:'kurumi-continuity-probe',type:'module',openclaw:{extensions:['./index.js']}}));
fs.writeFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), JSON.stringify({id:'kurumi-continuity-probe',name:'P2 temporary hook probe',activation:{onStartup:true},configSchema:{type:'object',additionalProperties:false}}));
fs.writeFileSync(path.join(pluginRoot, 'index.js'), `import fs from 'node:fs';
const destination = ${JSON.stringify(hookLog)};
const emit = (hook,event,ctx={}) => fs.appendFileSync(destination,JSON.stringify({hook,agentId:ctx.agentId,sessionKey:ctx.sessionKey??event.sessionKey,sessionId:ctx.sessionId??event.sessionId,runId:ctx.runId??event.runId,workspaceDir:ctx.workspaceDir,channel:ctx.channel,messageProvider:ctx.messageProvider,accountId:ctx.accountId,senderId:ctx.senderId,trigger:ctx.trigger,hasToolAuthority:!!ctx.toolAuthority,allowsSessionStatus:ctx.toolAuthority?.allows('session_status'),currentUserMessageId:event.currentUserMessageId,hasCurrentUserMessage:typeof event.currentUserMessage==='string',messageCount:event.messages?.length??event.messageCount,compactedCount:event.compactedCount,success:event.success,reason:event.reason})+'\\n');
export default {id:'kurumi-continuity-probe',register(api){
 api.on('before_prompt_build',(event,ctx)=>{emit('before_prompt_build',event,ctx);ctx.toolAuthority.assertActive();return {prependContext:'CONTINUITY_HOOK_CONTEXT_SENTINEL'};},{requiresToolAuthority:true});
 for(const hook of ['agent_end','before_compaction','after_compaction','before_reset','session_start','session_end'])api.on(hook,(event,ctx)=>emit(hook,event,ctx));
 api.on('reply_dispatch',event=>emit('reply_dispatch',event,{agentId:undefined,sessionKey:event.ctx?.SessionKey,sessionId:event.ctx?.SessionId,senderId:event.ctx?.SenderId}));
}};
`);


const model = http.createServer(async (req, res) => {
  try {
    assert(activeCase, 'unexpected background model request');
    assert(++report.requests <= 24, 'model request budget exhausted');
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw);
    const rendered = JSON.stringify(body);
    const system = body.messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => typeof message.content === 'string' ? message.content : JSON.stringify(message.content)).join('\n');
    const summarizing = activeCase.compaction === true;
    let answer = {role: 'assistant', content: summarizing
      ? '## Summary\nCONTINUITY_COMPACTED_SENTINEL\nThis is an isolated synthetic conversation. No real preferences or personal facts were saved.'
      : 'PERSONA_HOST_FIXTURE_OK'};
    if (summarizing) {
      report.compactionRequests++;
      assert(!body.tools?.length, 'summarizer unexpectedly received business tools');
    } else {
    const check = {
      case: activeCase.label, owner: activeCase.qq === OWNER, chars: system.length,
      sha256: hash(system), fullCore: system.includes(core.trimEnd()),
      ownerRelationship: system.includes('persona-relationship-owner-v1'),
      memberRelationship: system.includes('persona-relationship-member-v1'),
      ownerPrivateMemory: system.includes('OWNER_PRIVATE_PERSONA_SENTINEL'),
      refreshed: system.includes('persona-refresh-sentinel-v1'),
      promptHookInjected: rendered.includes('CONTINUITY_HOOK_CONTEXT_SENTINEL'),
      ownerPreResetHistory: rendered.includes('OWNER_HISTORY_BEFORE_NEW'),
      memberPreResetHistory: rendered.includes('MEMBER_HISTORY_BEFORE_NEW'),
      compactedSummary: rendered.includes('CONTINUITY_COMPACTED_SENTINEL'),
      toolNames: (body.tools ?? []).map(tool => tool.function?.name),
    };
    report.promptChecks.push(check);
    assert(check.fullCore, 'shared persona was missing or truncated');
    assert(check.promptHookInjected, 'authorized prompt hook was not invoked');
    assert.equal(check.ownerRelationship, check.owner, 'relationship crossed identity');
    assert.equal(check.memberRelationship, !check.owner, 'member relationship missing');
    assert.equal(check.ownerPrivateMemory, check.owner, 'owner memory crossed identity');
    assert(!(check.owner ? check.memberPreResetHistory : check.ownerPreResetHistory), 'conversation history crossed identity');
    if (activeCase.afterReset) assert(!(check.owner ? check.ownerPreResetHistory : check.memberPreResetHistory), 'pre-reset history survived in model input');
    if (activeCase.summary) assert(check.compactedSummary, 'completed compaction summary missing from actual model input');
    if (activeCase.refresh) assert(check.refreshed, 'long-lived session used stale persona');
    }
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (body.stream) {
      const base = {id: 'chatcmpl-persona', object: 'chat.completion.chunk', created: 1, model: modelId};
      res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {role: 'assistant', content: answer.content}, finish_reason: null}]}) + '\n\n');
      res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else res.end(JSON.stringify({id: 'chatcmpl-persona', object: 'chat.completion', choices: [{index: 0, message: answer, finish_reason: 'stop'}], usage: {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2}}));
  } catch (error) {
    report.modelError = error.message;
    res.writeHead(500); res.end(JSON.stringify({error: {message: 'isolated_persona_acceptance_failed'}}));
  }
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const onebot = http.createServer(async (req, res) => {
  assert.equal(req.headers.authorization, 'Bearer ' + token);
  if (req.url === '/send_private_msg' || req.url === '/upload_private_file') {
    report.unexpectedPlatformWrite = req.url; res.writeHead(500); res.end(); return;
  }
  res.end(JSON.stringify({status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? {user_id: Number(bot)} : {}}));
});
onebot.listen(0, '127.0.0.1'); await once(onebot, 'listening');
const ws = new WebSocketServer({server: onebot});
const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
let cfg = {
  gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
  models: {providers: {'persona-test': {baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic', api: 'openai-completions',
    models: [{id: modelId, name: modelId, reasoning: false, input: ['text'], contextWindow: 64000, maxTokens: 1200, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}},
  agents: {ownership: 'explicit', defaults: {workspace: path.join(root, 'workspace'), systemAgent: {agentId: 'main'}, model: {primary: `persona-test/${modelId}`}, heartbeat: {every: '0m'},
    compaction: {enabled: false, mode: 'default', keepRecentTokens: 128, memoryFlush: {enabled: false}}},
    entries: {main: {workspace: path.join(root, 'workspace'), model: {primary: `persona-test/${modelId}`}, tools: {profile: 'full', allow: ['session_status'], deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn']}}}},
  channels: {'kurumi-qq': {enabled: true, httpUrl: `http://127.0.0.1:${onebot.address().port}`, wsUrl: `ws://127.0.0.1:${onebot.address().port}`,
    httpTokenFile: path.join(root, 'http-token'), wsTokenFile: path.join(root, 'ws-token'), stateDir: path.join(root, 'channel'), mediaRoot: path.join(root, 'media'), testIngress: true, dailySendLimit: 100, segmentDelayMs: 0}},
  plugins: {allow: ['kurumi-qq','kurumi-continuity-probe'], load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-qq'),pluginRoot]}, entries: {'kurumi-qq': {enabled: true},'kurumi-continuity-probe':{enabled:true,hooks:{allowConversationAccess:true}}}, slots: {memory: 'none'}},
  session: {dmScope: 'per-channel-peer'}, cron: {enabled: false}, logging: {file: path.join(root, 'runtime.log')},
  tools: {deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}},
};
cfg = compileAccessConfig(cfg, fake);
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(root, file), token, {mode: 0o600});
fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(cfg), {mode: 0o600});
function startGateway() {
  const fd = fs.openSync(path.join(root, 'gateway.log'), 'a', 0o600);
  child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
    cwd: repo, env: {...process.env, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_AGENT_DIR: path.join(root, 'agents/main/agent')},
    stdio: ['ignore', fd, fd], detached: true,
  }); fs.closeSync(fd); report.gatewayStarts++;
}
async function stopGateway() {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM'); let timer;
  await Promise.race([once(child, 'exit'), new Promise(resolve => {timer = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {} resolve();}, 15000);})]); clearTimeout(timer);
}
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
const call = (method, params = {}, timeout = 100000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
async function turn(label, qq, text, options = {}) {
  activeCase = {label, qq, ...options};
  const before = report.requests;
  const result = await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(qq), message_id: ++sequence,
    time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text}}]}});
  assert(result.ok, 'isolated inbound failed');
  assert(report.requests > before, 'no actual model request');
  const reply = (result.captured ?? []).map(item => item.text ?? item.payload?.text ?? '').filter(Boolean).join('\n');
  const row = {label, identity: qq === OWNER ? 'owner' : 'member', prompt: text, reply, passed: false}; report.cases.push(row);
  assert(reply.includes('PERSONA_HOST_FIXTURE_OK'), 'deterministic reply missing');
  assert(!report.modelError, report.modelError); row.passed = true;
  console.log(JSON.stringify({case: label, passed: true, live}));
}
async function waitReady() {
  let ready = false;
  for (let n = 0; n < 100; n++) {
    try { await call('health', {}, 1200); ready = true; break; }
    catch { if (child.exitCode !== null) throw Error('isolated_gateway_exited'); await new Promise(resolve => setTimeout(resolve, 400)); }
  }
  assert(ready, 'isolated_gateway_not_ready');
}
try {
  startGateway(); await waitReady();
  await turn('owner-first-turn', OWNER, '测试本人新回合 OWNER_HISTORY_BEFORE_NEW');
  await turn('member-first-turn', MEMBER, '测试成员新回合 MEMBER_HISTORY_BEFORE_NEW');
  await turn('owner-continuation', OWNER, '继续本人对话');
  await turn('other-member-turn', OTHER, '测试另一成员');
  const reset = async qq => {
    activeCase = {label: 'reset-command', qq};
    assert((await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(qq), message_id: ++sequence,
      message: [{type: 'text', data: {text: '/new'}}]}})).ok);
  };
  await reset(MEMBER);
  await turn('member-after-new', MEMBER, '测试成员重开会话', {afterReset: true});
  fs.appendFileSync(path.join(root, 'users', MEMBER, 'workspace/SOUL.md'), '\n<!-- persona-refresh-sentinel-v1 -->\n');
  await turn('member-prompt-refresh', MEMBER, '测试同会话提示词刷新', {refresh: true, afterReset: true});
  await reset(OWNER);
  await turn('owner-after-new', OWNER, '测试本人重开会话', {afterReset: true});
  await turn('owner-resumed-turn', OWNER, '测试本人继续', {afterReset: true});
  await turn('owner-before-compaction', OWNER, '隔离压缩测试。' + '仅为合成测试填充上下文，不是用户真实经历。'.repeat(180), {afterReset: true});
  activeCase = {label: 'manual-compaction', qq: OWNER, compaction: true};
  report.compaction = await call('sessions.compact', {key: `agent:main:kurumi-qq:direct:${OWNER}`});
  assert.equal(report.compaction.ok, true, 'manual compaction RPC failed');
  assert.equal(report.compaction.compacted, true, 'manual compaction was a no-op');
  assert(report.compactionRequests > 0, 'no deterministic summarizer request');
  await turn('owner-after-compaction', OWNER, '测试压缩后继续', {afterReset: true, summary: true});
  await stopGateway(); startGateway(); await waitReady();
  await turn('owner-after-restart', OWNER, '测试宿主重启后继续', {afterReset: true, summary: true});
  await turn('member-after-restart', MEMBER, '测试成员重启后继续', {afterReset: true, refresh: true});
  assert(!report.unexpectedPlatformWrite);
  report.hookObservations = fs.readFileSync(hookLog,'utf8').trim().split('\n').map(line=>JSON.parse(line));
  const prompts=report.hookObservations.filter(row=>row.hook==='before_prompt_build');
  assert.equal(prompts.length,12); assert(prompts.every(row=>row.hasToolAuthority&&row.allowsSessionStatus&&row.agentId&&row.sessionId&&row.runId));
  for (const qq of [OWNER, MEMBER]) {
    const events = report.hookObservations.filter(row=>row.sessionKey?.endsWith(`:direct:${qq}`));
    assert(events.some(row=>row.hook==='before_reset'&&row.reason==='new'), 'new reset observation missing');
    assert(events.some(row=>row.hook==='session_end'&&row.reason==='new'), 'new session end missing');
  }
  assert(report.hookObservations.some(row=>row.hook==='before_compaction'), 'before-compaction hook missing');
  assert(report.hookObservations.some(row=>row.hook==='after_compaction'), 'after-compaction hook missing');
  report.passed = true;
} catch (error) {
  report.passed = false; report.error = error.message; report.diagnosticsRoot = root; process.exitCode = 1;
} finally {
  await stopGateway();
  for (const client of ws.clients) client.terminate();
  await new Promise(resolve => ws.close(resolve));
  onebot.closeAllConnections(); model.closeAllConnections();
  await Promise.all([new Promise(resolve => onebot.close(resolve)), new Promise(resolve => model.close(resolve))]);
  report.childStopped = !child || child.exitCode !== null || child.signalCode !== null;
  if (!report.hookObservations.length && fs.existsSync(hookLog)) report.hookObservations = fs.readFileSync(hookLog,'utf8').trim().split('\n').filter(Boolean).map(line=>JSON.parse(line));
  report.sourceHashes = {persona: hash(fs.readFileSync(path.join(repo, 'config/persona.json'))), soul: hash(core)};
  fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, JSON.stringify(report, null, 2));
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({passed: report.passed, live, cases: report.cases.length, requests: report.requests, error: report.error, evidence: out}));
}
