// Document 25 P2 / E1: real isolated OpenClaw host auto-compaction with the real kurumi-memory and kurumi-qq plugins.
// Deterministic local model only (--live is rejected); simulated OneBot; synthetic conversations and temporary state only.
// Variants: A production-like (slots.memory none), A2 = A + memoryFlush.enabled=false, A3 memory-core control,
// B transcript-bytes trigger, C malformed summary in production default mode (characterised: no quality guard),
// C2 malformed summary with compaction.mode=safeguard (quality guard must retry, then cancel and keep history).
// Writes only the explicit new --out evidence file; no real QQ/mail, production write or production service restart.
// --keep-root keeps the temporary state directory of passing variants for log inspection.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {createHash, randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {personaFiles, applyPersonaFile} from '../../packages/access-control/workspaces.js';
import {ownerPolicy, memberRow, OWNER, MEMBER} from '../access-control/fixtures.mjs';
import {emptyState} from '../../plugins/kurumi-memory/continuity/model.js';
import {initializeContinuity, replaceNotice, openContinuityStore} from '../../plugins/kurumi-memory/continuity/store.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const arg = name => {const index = process.argv.indexOf(name); return index < 0 ? null : process.argv[index + 1];};
if (process.argv.includes('--live')) throw Error('Compaction host test is deterministic; no live API');
const out = arg('--out');
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Require a new absolute --out evidence file');
const VARIANTS = {
  A: {memorySlot: 'none', trigger: 'tokens', restart: true},
  A2: {memorySlot: 'none', trigger: 'tokens', flushDisabled: true},
  A3: {memorySlot: 'memory-core', trigger: 'tokens', control: true},
  B: {memorySlot: 'none', trigger: 'bytes'},
  C: {memorySlot: 'none', trigger: 'tokens', malformedSummary: true},
  // Warm-up turns give the safeguard real history to summarise; with only the seed turn the fill turn becomes a
  // split turn and the malformed text lands in the split-turn section, which the quality audit does not judge.
  C2: {memorySlot: 'none', trigger: 'tokens', malformedSummary: true, safeguard: true, warmup: true},
};
const selected = arg('--variant') ? [arg('--variant')] : Object.keys(VARIANTS);
assert(selected.every(name => VARIANTS[name]), 'unknown --variant');

const token = randomBytes(24).toString('hex'), bot = '900001';
const SESSION_KEY = `agent:main:kurumi-qq:direct:${OWNER}`, SEED = '我喜欢喝乌龙茶';
const SENTINEL = 'AUTO_COMPACTED_SENTINEL', MALFORMED = 'MALFORMED_SUMMARY_SENTINEL';
const MEMORY_BLOCK = 'KURUMI_PERSONAL_MEMORY_V2（JSON资料';
const WINDOW = 32768, FILL_USAGE = 30000, BUDGET = 30, PAD_BYTES = 24576;
const report = {
  at: new Date().toISOString(), model: 'local/deterministic', contextWindow: WINDOW, preflightThreshold: WINDOW - Math.min(20000, WINDOW / 4),
  fillUsage: FILL_USAGE, variants: [],
  boundary: 'Real isolated OpenClaw 2026.9.7 with real kurumi-memory/kurumi-qq plugins, deterministic local model and simulated OneBot. Synthetic conversations, one synthetic seeded preference and temporary state only; no real QQ, mail, paid API, production write or production service restart.',
};
const policy = ownerPolicy(); policy.subjects.push(memberRow());
const sourceConfig = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'), 'utf8'));
const persona = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
const textOf = content => typeof content === 'string' ? content : JSON.stringify(content ?? '');
function seededState() {
  const at = '2026-10-01T00:00:00.000Z', state = emptyState(OWNER, 1);
  state.facts.push({id: createHash('sha256').update('compaction-host-seed').digest('hex').slice(0, 12), text: SEED, kind: 'preference', createdAt: at, updatedAt: at,
    source: {origin: 'legacy_explicit', messageId: 'fixture-seed', sessionKey: SESSION_KEY, sessionId: 'fixture-session', runId: 'fixture-run', at,
      rawHash: createHash('sha256').update(SEED).digest('hex'), evidence: SEED}});
  return state;
}
// Identifier shapes the safeguard audit treats as exact; extra hits are harmless, missing ones fail the audit.
const identifiersIn = text => [...new Set(text.match(/https?:\/\/[^\s"'\\]+|\b\d{6,}\b|\b[A-Fa-f0-9]{8,}\b/gu) ?? [])].slice(0, 40);
function summaryFor(body, variant) {
  const conversation = (body.messages ?? []).filter(message => !['system', 'developer'].includes(message.role)).map(message => textOf(message.content)).join('\n');
  if (variant.malformedSummary) return `${MALFORMED}\nfree-form summary without the required section headings`;
  const latest = conversation.match(/Latest unresolved user request[^\n]*\n+([^\n]{1,400})/u)?.[1]?.trim();
  const asks = [...conversation.matchAll(/COMPACT_HOST_[A-Z_]+\s*([^\n"\\]{0,120})/gu)].map(match => match[1].trim()).filter(Boolean);
  const missing = [...conversation.matchAll(/missing_identifiers:([^)\s]+)/gu)].flatMap(match => match[1].split(','));
  return [
    '## Decisions', `${SENTINEL}: synthetic owner conversation for host compaction evidence.`, ...asks.slice(-6).map(text => `- user said: ${text}`),
    '## Open TODOs', 'None.', '## Constraints/Rules', 'Synthetic fixture; no real data.',
    '## Pending user asks', ...(latest ? [`Latest user request context: ${JSON.stringify(latest)}`] : ['None.']),
    '## Exact identifiers', ...new Set([...identifiersIn(conversation), ...missing]),
  ].join('\n');
}
let ctx = null;
function stream(res, body, message, usage) {
  res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
  if (!body.stream) {res.end(JSON.stringify({id: 'chatcmpl-compaction', object: 'chat.completion', choices: [{index: 0, message, finish_reason: 'stop'}], usage})); return;}
  const base = {id: 'chatcmpl-compaction', object: 'chat.completion.chunk', created: 1, model: 'fixture'};
  res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: message, finish_reason: null}]}) + '\n\n');
  res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: 'stop'}], usage}) + '\n\n');
  res.end('data: [DONE]\n\n');
}
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages ?? [], rendered = JSON.stringify(body);
    assert(ctx?.turn, 'unexpected background model request');
    assert(++ctx.row.requests <= BUDGET, 'model request budget exhausted');
    const system = messages.filter(message => ['system', 'developer'].includes(message.role)).map(message => textOf(message.content)).join('\n');
    const lastUser = textOf([...messages].reverse().find(message => message.role === 'user')?.content);
    const tools = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
    const kind = /Pre-compaction memory flush/u.test(lastUser) || /Pre-compaction memory flush turn/u.test(system) ? 'flush' : tools.length ? 'reply' : 'summary';
    ctx.row.requestKinds.push({turn: ctx.turn.label, kind});
    const small = {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2};
    if (kind === 'flush') {
      ctx.row.flushRequests.push({turn: ctx.turn.label, toolNames: tools});
      stream(res, body, {role: 'assistant', content: 'NO_REPLY'}, small); return;
    }
    if (kind === 'summary') {
      const feedback = rendered.match(/Previous summary failed quality checks \(([^)]{0,400})\)/u)?.[1] ?? null;
      ctx.row.summaryRequests.push({turn: ctx.turn.label, feedback, systemHead: system.slice(0, 160)});
      stream(res, body, {role: 'assistant', content: summaryFor(body, ctx.variant)}, small); return;
    }
    const prompt = ctx.turn.usage ?? 1;
    // The persona system text names the marker too; only the injected prependContext block counts as personal context.
    const memoryText = messages.filter(message => message.role === 'user').map(message => textOf(message.content)).filter(text => text.includes(MEMORY_BLOCK)).at(-1) ?? '';
    const memoryAt = memoryText.indexOf(MEMORY_BLOCK);
    ctx.row.promptChecks.push({
      turn: ctx.turn.label, owner: ctx.turn.qq === OWNER, toolNames: tools,
      personalContext: memoryAt >= 0, seededFact: memoryText.slice(memoryAt).includes(SEED),
      summarySentinel: rendered.includes(SENTINEL), malformedSentinel: rendered.includes(MALFORMED),
      seedHistory: rendered.includes('COMPACT_HOST_SEED'), kurumiMemoryTool: tools.includes('kurumi_memory'),
    });
    stream(res, body, {role: 'assistant', content: 'COMPACT_HOST_OK ' + ctx.turn.label}, {prompt_tokens: prompt, completion_tokens: 1, total_tokens: prompt + 1});
  } catch (error) {ctx && (ctx.row.modelError ??= error.message); res.writeHead(500); res.end(JSON.stringify({error: {message: 'compaction_fixture_failed'}}));}
});
model.listen(0, '127.0.0.1'); await once(model, 'listening');
const onebot = http.createServer(async (req, res) => {
  if (req.headers.authorization !== 'Bearer ' + token) {res.writeHead(401); res.end(); return;}
  for await (const _ of req);
  if (req.url === '/send_private_msg' || req.url === '/upload_private_file') {if (ctx) ctx.row.platformWrites.push(req.url); res.writeHead(500); res.end(); return;}
  res.end(JSON.stringify({status: 'ok', retcode: 0, data: req.url === '/get_login_info' ? {user_id: Number(bot)} : {}}));
});
onebot.listen(0, '127.0.0.1'); await once(onebot, 'listening');
const ws = new WebSocketServer({server: onebot});
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');

function writeProbe(root, hookLog) {
  const pluginRoot = path.join(root, 'compaction-probe'); fs.mkdirSync(pluginRoot);
  fs.writeFileSync(path.join(pluginRoot, 'package.json'), JSON.stringify({name: 'kurumi-compaction-probe', type: 'module', openclaw: {extensions: ['./index.js']}}));
  fs.writeFileSync(path.join(pluginRoot, 'openclaw.plugin.json'), JSON.stringify({id: 'kurumi-compaction-probe', name: 'E1 temporary compaction probe', activation: {onStartup: true}, configSchema: {type: 'object', additionalProperties: false}}));
  // Only primitive metadata is recorded; message bodies never reach the evidence file.
  fs.writeFileSync(path.join(pluginRoot, 'index.js'), `import fs from 'node:fs';
const destination = ${JSON.stringify(hookLog)};
const flat = value => Object.fromEntries(Object.entries(value ?? {}).filter(([key, item]) => ['number','boolean'].includes(typeof item) || (typeof item === 'string' && !/text|content|prompt|message|summary/i.test(key))).map(([key, item]) => [key, typeof item === 'string' ? item.slice(0, 120) : item]));
const emit = (hook, event, ctx = {}) => fs.appendFileSync(destination, JSON.stringify({hook, ...flat(event), ctx: flat(ctx), messageCount: event?.messages?.length ?? event?.messageCount})+'\\n');
export default {id:'kurumi-compaction-probe',register(api){
 for (const hook of ['before_prompt_build','before_compaction','after_compaction','agent_end']) api.on(hook,(event,ctx)=>{emit(hook,event,ctx);});
}};
`);
  return pluginRoot;
}
async function freePort() {const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening'); const port = probe.address().port; await new Promise(resolve => probe.close(resolve)); return port;}
function buildConfig(root, variant, port, probeRoot) {
  const cfg = JSON.parse(JSON.stringify(sourceConfig)); delete cfg._managed;
  const workspace = path.join(root, 'workspace'), primary = 'compaction-fixture/fixture';
  const prodMain = sourceConfig.agents.entries.main.tools;
  const compaction = {
    ...(variant.flushDisabled ? {memoryFlush: {enabled: false}} : {}),
    // C2: estimated (not reported) tokens decide the kept tail, so a small keepRecentTokens makes the warm-up turns summarisable.
    ...(variant.safeguard ? {mode: 'safeguard', keepRecentTokens: 2000} : {}),
    // B: tiny usage, so only transcript bytes can trigger; a small keepRecentTokens leaves something to summarize.
    ...(variant.trigger === 'bytes' ? {maxActiveTranscriptBytes: PAD_BYTES, keepRecentTokens: 2000} : {}),
  };
  cfg.gateway = {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}};
  cfg.models = {providers: {'compaction-fixture': {baseUrl: `http://127.0.0.1:${model.address().port}/v1`, apiKey: 'synthetic', api: 'openai-completions',
    models: [{id: 'fixture', name: 'fixture', reasoning: false, input: ['text'], contextWindow: WINDOW, maxTokens: 1200, cost: {input: 0, output: 0, cacheRead: 0, cacheWrite: 0}}]}}};
  cfg.agents = {ownership: 'explicit', defaults: {workspace, systemAgent: {agentId: 'main'}, model: {primary}, heartbeat: {every: '0m'}, ...(Object.keys(compaction).length ? {compaction} : {})}, entries: {
    main: {workspace, model: {primary}, tools: {profile: 'messaging', alsoAllow: ['kurumi_memory', 'session_status'], deny: prodMain.deny}},
    ['qq-user-' + MEMBER]: {workspace: path.join(root, 'users', MEMBER, 'workspace'), model: {primary}, tools: {profile: 'messaging', allow: ['session_status'], deny: [...prodMain.deny, 'kurumi_memory']}},
  }};
  cfg.channels = {'kurumi-qq': {enabled: true, ownerId: OWNER, accessControl: policy, httpUrl: `http://127.0.0.1:${onebot.address().port}`, wsUrl: `ws://127.0.0.1:${onebot.address().port}`,
    httpTokenFile: path.join(root, 'http-token'), wsTokenFile: path.join(root, 'ws-token'), stateDir: path.join(root, 'channel'), mediaRoot: path.join(root, 'media'), testIngress: true, dailySendLimit: 100, segmentDelayMs: 0}};
  const memoryCore = variant.memorySlot === 'memory-core';
  cfg.plugins = {allow: ['kurumi-qq', 'kurumi-memory', 'kurumi-compaction-probe', ...(memoryCore ? ['memory-core'] : [])],
    load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-qq'), path.join(repo, 'chatbot/plugins/kurumi-memory'), probeRoot]}, entries: {
      'kurumi-qq': {enabled: true}, 'kurumi-memory': structuredClone(sourceConfig.plugins.entries['kurumi-memory']),
      'kurumi-compaction-probe': {enabled: true, hooks: {allowConversationAccess: true}}, ...(memoryCore ? {'memory-core': {enabled: true}} : {}),
    }, slots: {memory: variant.memorySlot}};
  cfg.session = {dmScope: 'per-channel-peer'}; cfg.cron = {enabled: false};
  cfg.logging = {file: path.join(root, 'runtime.log'), level: 'debug'};
  cfg.tools = {deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}};
  return {cfg: compileAccessConfig(cfg, policy), workspace};
}
function startGateway(root, port) {
  const fd = fs.openSync(path.join(root, 'gateway.log'), 'a', 0o600);
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
    cwd: repo, env: {...process.env, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_AGENT_DIR: path.join(root, 'agents/main/agent')}, stdio: ['ignore', fd, fd], detached: true,
  }); fs.closeSync(fd); return child;
}
async function stopGateway(child) {
  if (child?.exitCode !== null || child?.signalCode !== null) return;
  child.kill('SIGTERM'); let timer;
  await Promise.race([once(child, 'exit'), new Promise(resolve => {timer = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {} resolve();}, 15000);})]); clearTimeout(timer);
}
function logLines(root) {
  const lines = [];
  for (const file of ['gateway.log', 'runtime.log']) {
    const full = path.join(root, file); if (!fs.existsSync(full)) continue;
    for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
      let text = line; try {const parsed = JSON.parse(line); text = parsed?.[0]?.message ?? parsed?.message ?? parsed?.[0] ?? line;} catch {}
      text = String(typeof text === 'string' ? text : JSON.stringify(text));
      // Routine per-turn "check:" lines are counted, not kept; decisions and failures are kept verbatim.
      if (/preflightCompaction check:|memoryFlush check:/u.test(text)) {lines.checks = (lines.checks ?? 0) + 1; continue;}
      if (/preflightCompaction triggered|memoryFlush|memory.flush|safeguard|quality|auto-compaction|compaction (?:failed|succeeded|cancel)|cancelling compaction|transcript_bytes/iu.test(text)) lines.push(`${file}: ${text.split(token).join('<token>').slice(0, 400)}`);
    }
  }
  return lines;
}
const readHooks = file => fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
function memoryState(workspace) {const store = openContinuityStore({workspace, ownerId: OWNER, readonly: true}); try {return store.read();} finally {store.close();}}
// kurumi-memory only injects for RawBody <= 2000 chars (inbound.js), so each pad stays below that.
const pad = index => `COMPACT_HOST_PAD 第${index}段填充：` + '这是用于测试的合成书签填充文字。'.repeat(110);
function turnsFor(variant) {
  if (variant.trigger === 'bytes') return [
    {label: 'owner-seed', qq: OWNER, text: 'COMPACT_HOST_SEED 你好，这是压缩测试的第一句。'},
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map(index => ({label: `owner-pad-${index}`, qq: OWNER, text: pad(index)})),
    {label: 'owner-after-pad', qq: OWNER, text: 'COMPACT_HOST_AFTER 你还记得我们刚才在聊什么吗？'},
  ];
  return [
    {label: 'owner-seed', qq: OWNER, text: 'COMPACT_HOST_SEED 你好，这是压缩测试的第一句。'},
    ...(variant.warmup ? [1, 2, 3, 4, 5, 6].map(index => ({label: `owner-warm-${index}`, qq: OWNER, text: `COMPACT_HOST_WARM 第${index}句：继续聊书签收纳的小事。` + '这是用于测试的合成书签填充文字。'.repeat(80)})) : []),
    {label: 'owner-fill', qq: OWNER, text: 'COMPACT_HOST_FILL 请继续陪我聊聊书签收纳。', usage: FILL_USAGE},
    {label: 'owner-after-threshold', qq: OWNER, text: 'COMPACT_HOST_AFTER 你还记得我们刚才在聊什么吗？'},
    {label: 'owner-after-compaction', qq: OWNER, text: 'COMPACT_HOST_NEXT 那我平时喜欢喝什么茶？'},
    {label: 'member-turn', qq: MEMBER, text: 'COMPACT_HOST_MEMBER 你知道我平时喜欢喝什么茶吗？'},
  ];
}
async function runVariant(name) {
  const variant = VARIANTS[name], root = fs.mkdtempSync(path.join(os.tmpdir(), `kurumi-compaction-${name}-`));
  const row = {variant: name, config: variant, requests: 0, requestKinds: [], summaryRequests: [], flushRequests: [], promptChecks: [], replies: [], platformWrites: []};
  const hookLog = path.join(root, 'hook-events.jsonl'), port = await freePort();
  const fixtureRepo = path.join(root, 'source');
  for (const relative of ['config/persona.json', 'config/runtime.config.json', persona.roleFile, ...Object.values(persona.relationshipFiles),
    'scripts/fusion/templates/AGENTS.md', 'scripts/fusion/templates/MEMBER_AGENTS.md']) {
    fs.mkdirSync(path.dirname(path.join(fixtureRepo, relative)), {recursive: true}); fs.copyFileSync(path.join(repo, relative), path.join(fixtureRepo, relative));
  }
  fs.writeFileSync(path.join(fixtureRepo, 'config/access-control.json'), JSON.stringify(policy));
  const {cfg, workspace} = buildConfig(root, variant, port, writeProbe(root, hookLog));
  for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(root, file), token, {mode: 0o600});
  for (const dir of ['channel', 'media']) fs.mkdirSync(path.join(root, dir), {recursive: true, mode: 0o700});
  for (const [file, content] of personaFiles(fixtureRepo, root).files) applyPersonaFile(file, content);
  initializeContinuity(workspace, seededState()); replaceNotice(workspace);
  const before = memoryState(workspace);
  fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(cfg), {mode: 0o600});
  const call = (method, params = {}, timeout = 120000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
  const ready = async child => {
    for (let i = 0; i < 100; i++) {try {await call('health', {}, 1200); return;} catch {if (child.exitCode !== null) throw Error('isolated_gateway_exited'); await new Promise(resolve => setTimeout(resolve, 300));}}
    throw Error('isolated gateway did not become ready');
  };
  let child = startGateway(root, port), messageId = 1;
  ctx = {variant, row, turn: null};
  const turn = async spec => {
    ctx.turn = spec;
    try {
      const result = await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(spec.qq), message_id: ++messageId, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text: spec.text}}]}});
      const reply = (result.captured ?? []).map(item => item.text ?? item.payload?.text ?? '').filter(Boolean).join('\n');
      row.replies.push({turn: spec.label, ok: result.ok === true, delivered: reply.includes('COMPACT_HOST_OK')});
      assert(result.ok, `inbound failed: ${spec.label}`);
    } finally {ctx.turn = null;}
  };
  try {
    await ready(child);
    for (const spec of turnsFor(variant)) await turn(spec);
    if (variant.restart) {
      await stopGateway(child); child = startGateway(root, port); await ready(child);
      await turn({label: 'owner-after-restart', qq: OWNER, text: 'COMPACT_HOST_RESTART 重启后你还记得我们聊过什么吗？'});
    }
    row.healthAfter = (await call('health', {}, 5000))?.ok ?? true;
    row.hooks = readHooks(hookLog).filter(hook => hook.hook !== 'before_prompt_build' || hook.ctx?.sessionKey === SESSION_KEY);
    const after = memoryState(workspace);
    row.memory = {revisionBefore: before.revision, revisionAfter: after.revision, factsUnchanged: JSON.stringify(after.facts) === JSON.stringify(before.facts)};
    assert(!row.modelError, row.modelError); assert.deepEqual(row.platformWrites, [], 'unexpected platform write');
    assert(row.memory.factsUnchanged && after.revision === before.revision, 'compaction changed personal memory');
    const owner = row.promptChecks.filter(check => check.owner), member = row.promptChecks.filter(check => !check.owner);
    assert(owner.length && owner.every(check => check.personalContext && check.seededFact), 'owner personal memory missing from some model input');
    assert(member.every(check => !check.personalContext && !check.seededFact && !check.kurumiMemoryTool), 'personal memory crossed to member');
    const compacted = row.hooks.filter(hook => hook.hook === 'after_compaction');
    row.observed = {
      summaryAttempts: row.summaryRequests.length, flushRequests: row.flushRequests.length,
      beforeCompaction: row.hooks.filter(hook => hook.hook === 'before_compaction').length, afterCompaction: compacted.length,
      ownerSessionIds: [...new Set(row.hooks.filter(hook => hook.hook === 'before_prompt_build').map(hook => hook.ctx?.sessionId))],
      summaryInLaterInput: owner.some(check => check.summarySentinel), allRepliesDelivered: row.replies.every(reply => reply.delivered),
      bytesTriggerLogged: logLines(root).some(line => /transcript_bytes/u.test(line)),
    };
    if (variant.malformedSummary && variant.safeguard) {
      assert(row.summaryRequests.some(request => request.feedback), 'quality guard did not retry the malformed summary with feedback');
      assert(owner.every(check => !check.malformedSentinel && !check.summarySentinel), 'cancelled summary reached model input');
      assert(owner.at(-1).seedHistory, 'history was lost after cancelled compaction');
      // Finding: once the guard cancels, preflight fails on every later owner turn and no reply request is made.
      const later = row.replies.filter(reply => reply.turn.startsWith('owner-after'));
      row.safeguardFinding = later.length && later.every(reply => !reply.delivered) ? 'owner_turns_unanswered_after_guard_cancel' : 'owner_turns_answered_after_guard_cancel';
    } else if (variant.malformedSummary) {
      // Production default mode (no compaction.provider/mode): no quality guard, so the free-form summary is accepted.
      assert(row.summaryRequests.length >= 1, 'host auto-compaction did not request a summary');
      assert(row.summaryRequests.every(request => !request.feedback), 'default mode unexpectedly ran the quality guard');
      row.defaultModeFinding = owner.at(-1).malformedSentinel ? 'malformed_summary_accepted_without_quality_guard' : 'malformed_summary_not_in_later_input';
    } else {
      assert(row.summaryRequests.length >= 1, 'host auto-compaction did not request a summary');
      assert(owner.at(-1).summarySentinel, 'compaction summary missing from later owner model input');
    }
    if (!variant.safeguard) assert(row.observed.allRepliesDelivered, 'some turn got no model reply');
    if (!variant.control) assert.equal(row.flushRequests.length, 0, 'memory flush ran although no memory-slot plugin is loaded');
    else {
      // memory-core plans a flush, but the main agent's messaging profile leaves it no write tool, so it fails before any model call.
      const flushLog = logLines(root).join('\n');
      row.controlFinding = row.flushRequests.length ? 'flush_requested_with_memory_core'
        : /memory flush failed[^\n]*No callable tools remain/u.test(flushLog) && /no write tool survived/u.test(flushLog) ? 'flush_dispatched_but_no_write_tool_under_messaging_profile'
        : 'inconclusive_no_flush_with_memory_core';
    }
    row.passed = true;
  } catch (error) {row.passed = false; row.error = error.message; row.diagnosticsRoot = root;}
  finally {
    ctx = null; await stopGateway(child);
    row.hooks ??= readHooks(hookLog);
    const lines = logLines(root); row.routineCheckLines = lines.checks ?? 0; row.logLines = lines.slice(0, 60);
    row.childStopped = child.exitCode !== null || child.signalCode !== null;
    if (row.passed && !process.argv.includes('--keep-root')) fs.rmSync(root, {recursive: true, force: true});
    else row.diagnosticsRoot = root;
  }
  return row;
}
try {
  for (const name of selected) report.variants.push(await runVariant(name));
} finally {
  for (const client of ws.clients) client.terminate(); await new Promise(resolve => ws.close(resolve));
  await new Promise(resolve => onebot.close(resolve)); await new Promise(resolve => model.close(resolve));
  report.passed = report.variants.length === selected.length && report.variants.every(row => row.passed);
  if (!report.passed) process.exitCode = 1;
  fs.mkdirSync(path.dirname(out), {recursive: true}); fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({passed: report.passed, variants: report.variants.map(row => ({variant: row.variant, passed: row.passed, error: row.error, ...row.observed, control: row.controlFinding, defaultMode: row.defaultModeFinding, safeguard: row.safeguardFinding})), evidence: out}));
}
