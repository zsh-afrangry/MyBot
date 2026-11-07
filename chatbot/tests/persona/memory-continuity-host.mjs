// Document 25 P2: real isolated OpenClaw + real kurumi-memory continuity plugin.
// Default deterministic local model; --live uses the configured official DeepSeek with bounded requests.
// Simulated OneBot, synthetic data and temporary state only; no production writes, real QQ/mail or production restart.
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
import {RecordApplication as RecordStore,openRecordContinuityStore} from '../../plugins/kurumi-memory/system/application.js';
import {migrateMemoryV3} from '../../plugins/kurumi-memory/system/migration.js';
import {emptyState} from '../../plugins/kurumi-memory/continuity/model.js';
import {initializeContinuity, replaceNotice, openContinuityStore} from '../../plugins/kurumi-memory/continuity/store.js';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const outIndex = process.argv.indexOf('--out'), out = outIndex < 0 ? null : process.argv[outIndex + 1];
if (!out || !path.isAbsolute(out) || fs.existsSync(out)) throw Error('Require a new absolute --out evidence file');
const live = process.argv.includes('--live'), v3=process.argv.includes('--v3');
const openMemory=v3?openRecordContinuityStore:openContinuityStore;
const allowModelRepair=process.argv.includes('--allow-model-repair'),v3ToolsOnly=process.argv.includes('--v3-tools-only');
if(v3ToolsOnly && !v3)throw Error('--v3-tools-only requires --v3');
const providerIndex=process.argv.indexOf('--provider-fixture');
const providerFixture=providerIndex<0?null:process.argv[providerIndex+1];
if(providerFixture&&(live||!path.isAbsolute(providerFixture)||JSON.parse(fs.readFileSync(providerFixture+'/openclaw.plugin.json')).id!=='deepseek'))throw Error('Provider fixture requires the official DeepSeek plugin path and deterministic mode');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-memory-host-'));
const token = randomBytes(24).toString('hex'), bot = '900001';
const report = {
  at: new Date().toISOString(), live, v3, allowModelRepair, v3ToolsOnly, providerFixture:Boolean(providerFixture), model: 'local/deterministic', cases: [], requests: 0, maxRequests: 40,
  toolCalls: [], toolErrors: [], modelChecks: [], mockSends: 0, usage: {promptTokens: 0, completionTokens: 0},
  boundary: 'Real isolated OpenClaw and real kurumi-memory/kurumi-qq plugins; deterministic model by default, optional official DeepSeek with --live, simulated OneBot. Synthetic conversations and temporary state only; no real QQ, mail, production write or production service restart.',
};
const policy = ownerPolicy(); policy.subjects.push(memberRow());
const fixtureRepo = path.join(root, 'source');
const sourceConfig = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json'), 'utf8'));
const primary = sourceConfig.agents.entries.main.model.primary, [providerId, modelId] = primary.split('/');
const provider = sourceConfig.models.providers[providerId];
let credential;
if (live) {
  assert.equal(new URL(provider.baseUrl).hostname, 'api.deepseek.com');
  credential = JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json', 'utf8'))[provider.apiKey.id];
  assert.equal(typeof credential, 'string'); assert(credential.length > 0); report.model = primary;
}
const persona = JSON.parse(fs.readFileSync(path.join(repo, 'config/persona.json'), 'utf8'));
for (const relative of ['config/persona.json', 'config/runtime.config.json', 'config/access-control.json', persona.roleFile,
  ...Object.values(persona.relationshipFiles), 'scripts/fusion/templates/AGENTS.md', 'scripts/fusion/templates/MEMBER_AGENTS.md']) {
  fs.mkdirSync(path.dirname(path.join(fixtureRepo, relative)), {recursive: true});
  fs.copyFileSync(path.join(repo, relative), path.join(fixtureRepo, relative));
}
fs.writeFileSync(path.join(fixtureRepo, 'config/access-control.json'), JSON.stringify(policy));

let activeTurn = null;
const blue = '我的合成书签是蓝色的', green = '我的合成书签是绿色的';
const textOf = content => typeof content === 'string' ? content : JSON.stringify(content ?? '');
function unwrap(value) {
  for (let depth = 0; depth < 8; depth++) {
    if (typeof value === 'string') {try {value = JSON.parse(value);} catch {return value;}}
    else if (value?.result) value = value.result;
    else if (Array.isArray(value?.content)) value = value.content.filter(p => p.type === 'text').map(p => p.text ?? '').join('\n');
    else return value;
  }
  return value;
}
const model = http.createServer(async (req, res) => {
  try {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages ?? [];
    if(providerFixture)assert.equal(body.model,'deepseek-flash','Preserve the configured production model id');
    assert(activeTurn, 'unexpected background model request');
    assert(++report.requests <= report.maxRequests, 'model request budget exhausted');
    const json = JSON.stringify(body);
    // Tool Search results can be projected as user-like messages by some
    // provider adapters. Anchor the fixture to the actual ingress text so
    // replayed tool results cannot reset the search/call state.
    const user = [...messages].reverse().find(message => {
      const content = typeof message?.content === 'string' ? message.content : JSON.stringify(message?.content ?? '');
      return message?.role === 'user' && (live
        ? content.trimEnd().endsWith(activeTurn.text) || content.includes(`\n\n${activeTurn.text}\n\nRuntime:`)
        : /MEMORY_HOST_[A-Z_]+/.test(content));
    }) ?? [...messages].reverse().find(message => message.role === 'user');
    const userText = typeof user?.content === 'string' ? user.content : JSON.stringify(user?.content ?? '');
    const available = (body.tools ?? []).map(tool => tool.function?.name).filter(Boolean);
    const allAssistantCalls = messages.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
    const priorMemoryWrapperCall = allAssistantCalls.some(call => {
      if (call.function?.name !== 'dispatch_action') return false;
      try { return JSON.parse(call.function.arguments ?? '{}').id === 'kurumi_memory'; } catch { return false; }
    });
    const checks = {
      label: activeTurn?.label, owner: activeTurn?.qq === OWNER, userText,
      personalContext: json.includes('KURUMI_PERSONAL_MEMORY_V2'),
      savedFactInContext: json.includes('喜欢绿茶'),
      blueInContext: json.includes(blue), greenInContext: json.includes(green),
      // In compact Tool Search mode the direct name is intentionally hidden;
      // a prior exact tool_call proves the owner can reach the capability.
      memoryToolAvailable: available.includes('kurumi_memory') || priorMemoryWrapperCall,
      toolNames: available, containsSaveMarker: json.includes('MEMORY_HOST_SAVE'),
    };
    report.modelChecks.push(checks);
    const afterUser = messages.slice(messages.lastIndexOf(user) + 1);
    const turnCalls = afterUser.filter(message => message.role === 'assistant').flatMap(message => message.tool_calls ?? []);
    const results = afterUser.filter(message => message.role === 'tool').map(message => unwrap(message.content));
    for (const result of results) if (result?.status === 'error' || typeof result?.error === 'string') {
      if (!report.toolErrors.some(row => row.label === activeTurn.label && row.error === result.error)) report.toolErrors.push({label: activeTurn.label, error: result.error});
    }
    const listed = results.findLast(result => result?.ok === true && Array.isArray(result.entries));
    const memoryCalls = turnCalls.flatMap(call => {
      const args = JSON.parse(call.function?.arguments ?? '{}');
      return call.function?.name === 'kurumi_memory' ? [args]
        : call.function?.name === 'dispatch_action' && String(args.id).split(':').at(-1) === 'kurumi_memory' ? [args.args] : [];
    });
    const described = results.find(result => result?.name === 'kurumi_memory' && result.parameters);
    if (described) {
      assert.match(described.parameters.properties.text.description, /upsert/);
      assert.match(described.parameters.properties.facts.description, /observe/);
      report.contractVisible = true;
    }
    const businessCall = allAssistantCalls.some(call => ['kurumi_memory', 'dispatch_action'].includes(call.function?.name));
    const searchAlreadyRequested = allAssistantCalls.some(call => call.function?.name === 'tool_search');
    const shouldSave = json.includes('MEMORY_HOST_SAVE') && !businessCall;
    const saveArgs = {action: 'observe', expectedRevision: 0, facts: [{text: '我喜欢绿茶', evidence: '我喜欢绿茶', kind: 'preference'}]};
    let tool = shouldSave && !available.includes('kurumi_memory') && available.includes('tool_search') && !searchAlreadyRequested
      ? {id: 'memory-search-' + report.requests, type: 'function', function: {name: 'tool_search', arguments: JSON.stringify({query: 'kurumi_memory', limit: 1})}}
      : shouldSave && !available.includes('kurumi_memory') && available.includes('dispatch_action')
        ? {id: 'memory-call-wrapper-' + report.requests, type: 'function', function: {name: 'dispatch_action', arguments: JSON.stringify({id: 'kurumi_memory', args: saveArgs})}}
        : shouldSave && available.includes('kurumi_memory') ? {
      id: 'memory-call-' + report.requests, type: 'function', function: {name: 'kurumi_memory', arguments: JSON.stringify({
        ...saveArgs,
      })},
    } : null;
    const makeCall = (name, args) => ({id: 'contract-' + report.requests, type: 'function', function: {name, arguments: JSON.stringify(args)}});
    const memoryCall = args => available.includes('kurumi_memory') ? makeCall('kurumi_memory', args) : makeCall('dispatch_action', {id: 'kurumi_memory', args});
    if (!live && ['owner-explicit-save','owner-correction','owner-forget','owner-question-delete'].includes(activeTurn.label)) {
      const writes = memoryCalls.filter(args => ['upsert','delete'].includes(args.action));
      tool = null;
      if (!listed) tool = memoryCall({action: 'list'});
      else if (activeTurn.label === 'owner-explicit-save' && !turnCalls.some(call => call.function?.name === 'tool_describe')) tool = makeCall('tool_describe', {id: 'kurumi_memory'});
      else if (activeTurn.label === 'owner-explicit-save' && !writes.length) {
        // Deliberately reproduce the production mistake; only the deterministic branch uses this plan.
        tool = memoryCall({action: 'upsert', expectedRevision: listed.revision, facts: [{text: blue, evidence: blue}]});
      } else if (activeTurn.label === 'owner-explicit-save' && writes.length === 1) {
        assert(json.includes('action=upsert') && json.includes('未提交'), 'actionable error not returned to model');
        const store = openMemory({workspace, ownerId: OWNER, readonly: true});
        try {const state = store.read(); assert.equal(state.revision, listed.revision); assert(!state.facts.some(f => f.text === blue));} finally {store.close();}
        report.malformedAttemptDidNotCommit = true;
        tool = memoryCall({action: 'upsert', expectedRevision: listed.revision, text: blue, evidence: blue});
      } else if (activeTurn.label !== 'owner-explicit-save' && !writes.length) {
        const entry = listed.entries.find(entry => entry.text === (activeTurn.label === 'owner-correction' ? blue : green));
        assert(entry, 'actual target not returned by list');
        tool = memoryCall(activeTurn.label === 'owner-correction'
          ? {action: 'upsert', expectedRevision: listed.revision, id: entry.id, text: green, evidence: green}
          : {action: 'delete', expectedRevision: listed.revision, id: entry.id, evidence: activeTurn.text});
      }
    }
    if (!live && ['owner-batch-seed','owner-batch-forget'].includes(activeTurn.label)) {
      tool = null;
      if (!listed) tool = memoryCall({action:'list'});
      else if (!memoryCalls.some(args => ['observe','delete'].includes(args.action))) {
        tool = memoryCall(activeTurn.label === 'owner-batch-seed'
          ? {action:'observe',expectedRevision:listed.revision,facts:['我喜欢合成红茶','我喜欢合成白茶'].map(text=>({text,evidence:text}))}
          : {action:'delete',expectedRevision:listed.revision,ids:listed.entries.filter(e=>/合成[红白]茶/u.test(e.text)).map(e=>e.id),evidence:activeTurn.text});
      }
    }
    if(!live && ['owner-v3-thread','owner-v3-raw'].includes(activeTurn.label)){
      const name=activeTurn.label==='owner-v3-thread'?'kurumi_memory_records':'kurumi_memory_raw';
      const called=turnCalls.some(call=>{if(call.function?.name===name)return true;try{const a=JSON.parse(call.function?.arguments??'{}');return call.function?.name==='dispatch_action' && String(a.id).split(':').at(-1)===name;}catch{return false;}});
      const rawId=[...json.matchAll(/本次可信原文引用：([a-f0-9]{64})/g)].at(-1)?.[1];
      const args=name==='kurumi_memory_raw'?{action:'search',query:'合成答辩'}:{action:'write',expectedVersion:0,record:{kind:'thread',about:'owner',basis:'stated',text:'主人合成答辩在2026年11月20日15点',sources:[{rawId}],attrs:{due:'2026-11-20T07:00:00Z'}}};
      tool=called?null:available.includes(name)?makeCall(name,args):makeCall('dispatch_action',{id:name,args});
    }
    let message = tool ? {role: 'assistant', content: null, tool_calls: [tool]} : {role: 'assistant', content: 'MEMORY_HOST_FIXTURE_OK'};
    let usage = {prompt_tokens: 1, completion_tokens: 1, total_tokens: 2};
    if (live) {
      // Only synthetic fixture context leaves this process, never production chats or memory.
      const payload = {...body, model: modelId, stream: false, max_tokens: 1200}; delete payload.stream_options;
      const upstream = await fetch(provider.baseUrl.replace(/\/$/u, '') + '/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + credential},
        body: JSON.stringify(payload), signal: AbortSignal.timeout(90000),
      });
      if (!upstream.ok) throw Error('official_model_http_' + upstream.status);
      const result = await upstream.json(); message = result.choices?.[0]?.message;
      assert(message, 'official model returned no message'); usage = result.usage ?? {};
      report.usage.promptTokens += usage.prompt_tokens ?? 0; report.usage.completionTokens += usage.completion_tokens ?? 0;
    }
    for (const call of message.tool_calls ?? []) report.toolCalls.push({name: call.function.name, arguments: JSON.parse(call.function.arguments), label: activeTurn.label});
    res.setHeader('content-type', body.stream ? 'text/event-stream' : 'application/json');
    if (body.stream) {
      const base = {id: 'chatcmpl-memory-host', object: 'chat.completion.chunk', created: 1, model: 'fixture'};
      res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {...message, ...(message.tool_calls?.length ? {tool_calls: message.tool_calls.map((call, index) => ({...call, index}))} : {})}, finish_reason: null}]}) + '\n\n');
      res.write('data: ' + JSON.stringify({...base, choices: [{index: 0, delta: {}, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop'}], usage}) + '\n\n');
      res.end('data: [DONE]\n\n');
    } else res.end(JSON.stringify({id: 'chatcmpl-memory-host', object: 'chat.completion', choices: [{index: 0, message, finish_reason: message.tool_calls?.length ? 'tool_calls' : 'stop'}], usage}));
  } catch (error) {report.modelError = error.message; res.writeHead(500); res.end(JSON.stringify({error: {message: 'memory_fixture_failed'}}));}
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
if(v3){
 cfg.agents.entries.main.tools.allow.push('kurumi_memory_records','kurumi_memory_raw');
 const m=cfg.plugins.entries['kurumi-memory'].config;m.continuityStoreAdapter='records-sqlite';
 m.system={enabled:true,records:true,raw:true,l0:true,hostDatabase:path.join(root,'agents/main/agent/openclaw-agent.sqlite')};
}
if(providerFixture){
 const fixture=cfg.models.providers['memory-fixture'];delete cfg.models.providers['memory-fixture'];
 fixture.models[0]={...fixture.models[0],id:'deepseek-flash',reasoning:true};cfg.models.providers.deepseek=fixture;
 cfg.agents.defaults.model.primary='deepseek/deepseek-flash';
 for(const agent of Object.values(cfg.agents.entries))agent.model.primary='deepseek/deepseek-flash';
 cfg.plugins.allow.push('deepseek');cfg.plugins.load.paths.push(providerFixture);cfg.plugins.entries.deepseek={enabled:true};
 report.model='deepseek/deepseek-flash via local deterministic provider endpoint';
}
cfg.session = {dmScope: 'per-channel-peer'}; cfg.cron = {enabled: false}; cfg.logging = {file: path.join(root, 'runtime.log')};
cfg.tools = {deny: ['exec', 'process', 'message', 'sessions_spawn'], web: {search: {enabled: false}, fetch: {enabled: false}}};
const compiled = compileAccessConfig(cfg, policy);
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(path.join(root, file), token, {mode: 0o600});
fs.mkdirSync(path.join(root, 'channel'), {recursive: true, mode: 0o700}); fs.mkdirSync(path.join(root, 'media'), {recursive: true, mode: 0o700});
for (const [file, content] of personaFiles(fixtureRepo, root).files) applyPersonaFile(file, content);
initializeContinuity(workspace, emptyState(OWNER)); replaceNotice(workspace);
if(v3){const backupRoot=path.join(root,'migration');fs.mkdirSync(backupRoot,{mode:0o700});const options={workspace,ownerId:OWNER,backupRoot};const preview=migrateMemoryV3(options);migrateMemoryV3({...options,apply:true,expectedStateHash:preview.stateHash});}
fs.writeFileSync(path.join(root, 'openclaw.json'), JSON.stringify(compiled), {mode: 0o600});

const gatewayLog = path.join(root, 'gateway.log'), fd = fs.openSync(gatewayLog, 'w', 0o600);
let child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(gatewayPort), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
  cwd: repo, env: {...process.env, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: path.join(root, 'openclaw.json'), OPENCLAW_AGENT_DIR: path.join(root, 'agents/main/agent')}, stdio: ['ignore', fd, fd], detached: true,
}); fs.closeSync(fd);
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
const call = (method, params = {}, timeout = 100000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${gatewayPort}`, token, timeout: String(timeout), json: true}, params);
let messageId = 1;
async function turn(label, qq, text) {
  // SAVE in a fixture marker can itself look like an explicit memory request.
  // The live model receives ordinary dialogue, never deterministic control markers.
  if (live) text = text.replace(/^MEMORY_HOST_[A-Z_]+\s*/u, '');
  assert(text.trim(), 'fixture ingress must contain a real user message after removing control markers');
  activeTurn = {label, qq, text};
  const result = await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(qq), message_id: ++messageId, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text}}]}});
  assert(result.ok, `inbound failed: ${label}`); assert(!report.modelError, report.modelError);
  const reply = (result.captured ?? []).map(item => item.text ?? item.payload?.text ?? '').filter(Boolean).join('\n');
  if (live) {assert(reply.trim(), 'empty delivered reply'); report.replies ??= []; report.replies.push({label, text: reply});}
  return result;
}
function state() {const store = openMemory({workspace, ownerId: OWNER, readonly: true}); try {return store.read();} finally {store.close();}}
async function resetOwner() {assert.equal((await call('sessions.reset', {key: `agent:main:kurumi-qq:direct:${OWNER}`, reason: 'new'})).ok, true);}
try {
  let ready = false;
  for (let i = 0; i < 100; i++) {try {await call('health', {}, 1200); ready = true; break;} catch {if (child.exitCode !== null) throw Error('isolated_gateway_exited'); await new Promise(resolve => setTimeout(resolve, 300));}}
  assert(ready, 'isolated gateway did not become ready');
  if(!v3ToolsOnly){
  const saved = await turn('owner-automatic-save', OWNER, 'MEMORY_HOST_SAVE 我喜欢绿茶');
  const initial = state();
  assert.equal(initial.facts.length, 1); assert.match(initial.facts[0].text, /喜欢绿茶/u); assert.equal(initial.revision, 1);
  if (live) {
    const calls = report.toolCalls.filter(row => row.label === 'owner-automatic-save');
    const writes = calls.map(row => row.arguments.args ?? row.arguments).filter(args => ['observe','upsert','delete'].includes(args.action));
    if(!allowModelRepair)assert.equal(writes.length,1);
    assert(writes.length>0 && writes.every(w=>w.action==='observe'),'ordinary preference must use observe');report.automaticWriteAttempts=writes.length;report.automaticCommittedWrites=initial.revision;
  }
  report.cases.push({label: 'owner-automatic-save', passed: true, captured: saved.captured?.length ?? 0});
  const resumed = await turn('owner-memory-injection', OWNER, 'MEMORY_HOST_READ 你记得我平时喜欢喝什么茶吗？');
  const ownerCheck = report.modelChecks.at(-1); assert(ownerCheck.personalContext && ownerCheck.savedFactInContext && ownerCheck.memoryToolAvailable);
  report.cases.push({label: 'owner-memory-injection', passed: true, context: {personal: ownerCheck.personalContext, fact: ownerCheck.savedFactInContext}});
  const reset = await call('sessions.reset', {key: `agent:main:kurumi-qq:direct:${OWNER}`, reason: 'new'}); assert.equal(reset.ok, true);
  await turn('owner-after-new', OWNER, 'MEMORY_HOST_READ 你记得我平时喜欢喝什么茶吗？'); const resetCheck = report.modelChecks.at(-1);
  assert(resetCheck.personalContext && resetCheck.savedFactInContext); report.cases.push({label: 'owner-after-new', passed: true});
  await turn('member-isolation', MEMBER, 'MEMORY_HOST_READ 你知道我平时喜欢喝什么茶吗？'); const memberCheck = report.modelChecks.at(-1);
  assert.equal(memberCheck.personalContext, false); assert.equal(memberCheck.savedFactInContext, false); assert.equal(memberCheck.memoryToolAvailable, false);
  report.cases.push({label: 'member-isolation', passed: true});

  await turn('owner-explicit-save', OWNER, 'MEMORY_HOST_EXPLICIT 请记入长期记忆：' + blue + '。');
  const explicit = state(), entry = explicit.facts.find(f => f.text === blue);
  assert(entry); assert.equal(explicit.facts.length, 2); assert.equal(explicit.revision, 2);
  if (!live) {assert(report.contractVisible); assert(report.malformedAttemptDidNotCommit);}
  report.cases.push({label: 'owner-explicit-save', passed: true, revision: explicit.revision,
    ...(live ? {} : {contractVisible: true, malformedAttemptDidNotCommit: true})});
  await resetOwner(); await turn('owner-blue-after-new', OWNER, 'MEMORY_HOST_READ_BLUE 你记得我的合成书签是什么颜色吗？');
  assert(report.modelChecks.at(-1).blueInContext); assert(!report.modelChecks.at(-1).greenInContext);
  if (live) assert.match(report.replies.at(-1).text, /蓝/u);
  report.cases.push({label: 'owner-blue-after-new', passed: true});

  await turn('owner-correction', OWNER, 'MEMORY_HOST_CORRECT 请更正这条长期记忆：' + green + '。请修改原来的记录。');
  const corrected = state(); assert.equal(corrected.facts.length, 2); assert.equal(corrected.revision, 3);
  assert.equal(corrected.facts.find(f => f.id === entry.id)?.text, green); assert(!corrected.facts.some(f => f.text === blue));
  assert.equal(corrected.facts.find(f => f.id === entry.id)?.createdAt, entry.createdAt);
  report.cases.push({label: 'owner-correction', passed: true, sameId: true, revision: corrected.revision});
  await resetOwner(); await turn('owner-green-after-new', OWNER, 'MEMORY_HOST_READ_GREEN 你记得我的合成书签是什么颜色吗？');
  assert(report.modelChecks.at(-1).greenInContext); assert(!report.modelChecks.at(-1).blueInContext);
  if (live) assert.match(report.replies.at(-1).text, /绿/u);
  report.cases.push({label: 'owner-green-after-new', passed: true});

  if (!live) {
    const before = state();
    await turn('owner-question-delete', OWNER, 'MEMORY_HOST_QUESTION 你忘掉我的合成书签颜色了吗？');
    assert.deepEqual(state(), before, 'new question must not finish old deletion');
    report.cases.push({label:'question-delete-rejected',passed:true,unchanged:true});
  }
  await turn('owner-forget', OWNER, 'MEMORY_HOST_FORGET 请忘掉我的合成书签颜色这条长期记忆。');
  const forgotten = state(); assert.equal(forgotten.revision, 4); assert.deepEqual(forgotten.facts, initial.facts);
  report.cases.push({label: 'owner-forget', passed: true, revision: forgotten.revision});
  if (!live) {
    await turn('owner-history-gap', OWNER, 'MEMORY_HOST_HISTORY 你记得刚刚忘掉的内容吗？');
    // Known limitation: source transcript is still visible until /new; do not mark masking as implemented.
    assert(report.modelChecks.at(-1).greenInContext);
    report.limitations={forgottenTextStillInOldContext:true,historyMaskImplemented:false};
  }
  await resetOwner(); await turn('owner-forgotten-after-new', OWNER, 'MEMORY_HOST_READ_FORGOTTEN 你记得我的合成书签是什么颜色吗？');
  assert(!report.modelChecks.at(-1).blueInContext); assert(!report.modelChecks.at(-1).greenInContext);
  assert.deepEqual(state().facts, initial.facts); assert.equal(state().revision, 4);
  if (live) {
    // A preserved, unrelated tea preference may contain 绿; check denial and the
    // target fact/context instead of treating every colour character as resurrection.
    assert.match(report.replies.at(-1).text, /不记得|不知道|答不上来|记不清|没留着|没有.*(?:记忆|记录)|没(?:有|存|记)/u);
    if(!allowModelRepair)assert.equal(report.toolErrors.length,0,'live model mixed action parameters');
  }
  report.cases.push({label: 'owner-forgotten-after-new', passed: true});
  if (!live) {
    await turn('owner-batch-seed', OWNER, 'MEMORY_HOST_BATCH_SAVE 我喜欢合成红茶，也喜欢合成白茶。我喜欢合成白茶。');
    const before = state(); assert.equal(before.facts.length,3);
    await turn('owner-batch-forget', OWNER, 'MEMORY_HOST_BATCH_FORGET 把红茶和白茶两条都忘掉');
    assert.equal(state().revision,before.revision+1);assert.equal(state().facts.length,1);
    report.cases.push({label:'batch-forget-single-commit',passed:true,deleted:2});
  }
  }
  if(v3){
    await turn('owner-v3-thread',OWNER,'MEMORY_HOST_V3_THREAD 我的合成答辩在2026年11月20日15点。请用kurumi_memory_records保存一条thread，due写上海时间对应ISO，来源引用本次可信原文rawId；这是软件测试，不要创建提醒。');
    const threadStore=new RecordStore({workspace,ownerId:OWNER});try{assert(threadStore.search('合成答辩',{kind:'thread'}).length>0);}finally{threadStore.close();}
    report.cases.push({label:'v3-record-tool-real-host-thread',passed:true});
    await turn('owner-v3-raw',OWNER,'MEMORY_HOST_V3_RAW 请只用kurumi_memory_raw的search检索“合成答辩”，核对刚才的原文日期并回答。');
    assert(report.toolCalls.some(c=>c.label==='owner-v3-raw' && (c.name==='kurumi_memory_raw' || c.name==='dispatch_action' && String(c.arguments.id).endsWith('kurumi_memory_raw'))));
    report.cases.push({label:'v3-raw-tool-real-host-chinese-search',passed:true});
    const beforeCompact=new RecordStore({workspace,ownerId:OWNER});let retainedBefore;
    try{beforeCompact.ingestHost(path.join(root,'agents/main/agent/openclaw-agent.sqlite'));retainedBefore=beforeCompact.rawRows().length;}finally{beforeCompact.close();}
    const compacted=await call('sessions.compact',{key:`agent:main:kurumi-qq:direct:${OWNER}`,maxLines:3});
    assert(compacted.ok && compacted.compacted,'actual canonical transcript trim must execute');
    report.cases.push({label:'v3-canonical-host-compaction-retains-mirror',passed:true,compacted:true});
    await resetOwner();
    const records=new RecordStore({workspace,ownerId:OWNER});
    try{
      records.ingestHost(path.join(root,'agents/main/agent/openclaw-agent.sqlite'));
      assert(records.rawRows().length>=retainedBefore,'compaction cannot remove mirrored raw');
      assert(records.rawRows().some(r=>r.origin==='owner_said'));
      assert(records.rawRows().some(r=>r.origin==='she_said'));
      assert(records.searchRaw('合成书签').every(r=>!r.text.includes(green)),'forgotten raw must stay masked after actual host resets');
      report.cases.push({label:v3ToolsOnly?'v3-native-host-raw-mirror-after-resets':'v3-native-host-raw-mirror-and-forgetting-after-resets',passed:true,retained:records.rawRows().length});
      report.limitations={hotHostContextStillVisibleUntilReset:true,rawToolMaskImplemented:true,backgroundWakeupEnabled:false};
    }finally{records.close();}
  }
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
