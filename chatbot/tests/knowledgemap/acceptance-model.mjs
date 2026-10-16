#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「测试计划」。
// Real configured model + actual v2 factories + isolated FastAPI/SQLite. No QQ/production writes.
import fs from 'node:fs';
import {join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {tmpdir} from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import assert from 'node:assert/strict';
import {KnowledgeMapClient} from '../../packages/knowledgemap-client/client.js';
import list from '../../plugins/personal-reminder-list/index.js';
import bills from '../../plugins/kurumi-knowledgemap/index.js';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const km = process.env.KM_TEST_REPO ?? '/home/afrangry/repository';
const outIndex = process.argv.indexOf('--out');
if (outIndex < 0 || !process.argv[outIndex + 1]) throw Error('--out required; never overwrite an earlier report implicitly');
const out = resolve(process.argv[outIndex + 1]); fs.mkdirSync(out, {recursive: true});
const cfg = JSON.parse(fs.readFileSync(join(repo, 'config/runtime.config.json')));
const [providerId, model] = cfg.agents.entries.main.model.primary.split('/'), provider = cfg.models.providers[providerId];
const secrets = JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json'));
const key = secrets[provider.apiKey.id];
if (!key || new URL(provider.baseUrl).hostname !== 'api.deepseek.com') throw Error('expected official configured model');
const root = fs.mkdtempSync(join(tmpdir(), 'km-model-')), tokenFile = join(root, 'token');
fs.writeFileSync(tokenFile, 'c'.repeat(64), {mode: 0o600});
const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r)); const port = probe.address().port; await new Promise(r => probe.close(r));
const child = spawn('/home/afrangry/miniconda3/envs/desheng/bin/python', [join(km, 'backend/tests/assistant_server.py'), '--port', String(port), '--token-file', tokenFile], {stdio: ['ignore', 'ignore', 'pipe']});
let errorLog = ''; child.stderr.on('data', x => errorLog += x.toString());
const beforeEnv = {root: process.env.OPENCLAW_STATE_DIR, token: process.env.OPENCLAW_GATEWAY_TOKEN};
process.env.OPENCLAW_STATE_DIR = root; delete process.env.OPENCLAW_GATEWAY_TOKEN;
const client = new KnowledgeMapClient({baseUrl: `http://127.0.0.1:${port}`, tokenFile});
const report = {at: new Date().toISOString(), boundary: 'Real configured model + actual v2 factories and synthetic trusted owner hooks; real isolated FastAPI HTTP/SQLite; no full OpenClaw host/QQ or production writes', model: cfg.agents.entries.main.model.primary, cases: []};
const hooks = {}, factories = {}, owner = cfg.channels['kurumi-qq'].ownerId, sessionKey = `agent:main:kurumi-qq:direct:${owner}`;
const ctx = {senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', sessionKey, sessionId: 'km-model-session',
  runId: 'km-model-acceptance', getRuntimeConfig: () => cfg, assertInvocationCurrent() {}};
const on = (name, fn) => (hooks[name] ??= []).push(fn);
const fire = (name, event, context = ctx) => hooks[name]?.forEach(fn => fn(event, context));
const api = {config: cfg, registrationMode: 'full', on, registerService() {}, registerTool: (f, m) => factories[m.name] = f, logger: {warn() {}}};
list.register({...api, pluginConfig: {dataSource: 'knowledgemap', bridgeBaseUrl: client.baseUrl, bridgeTokenFile: tokenFile, backendRoot: join(repo, 'chatbot')}});
bills.register({...api, pluginConfig: {baseUrl: client.baseUrl, tokenFile}});
const definitions = Object.keys(factories).map(name => {const tool = factories[name].create(ctx); return {type: 'function', function: {name, description: tool.description, parameters: tool.parameters}};});
const system = fs.readFileSync(join(repo, 'scripts/fusion/templates/AGENTS.md'), 'utf8') + '\n当前实际日期2026-10-17 Asia/Shanghai；你通过KnowledgeMap工具维护网站共享待做/账单，逾期仍待做，无DDL留空，条件写备注。明确记账直接保存；可空分类/支付方式未知则不编造。测试库无其他事项，所有操作真实执行但只作用于隔离库。';
let messages = [{role: 'system', content: system}], seq = 0;
async function turn(label, text, verify) {
  fire('reply_dispatch', {ctx: {RawBody: text, MessageSid: 'km-model-' + ++seq, Timestamp: Date.now(), ChatType: 'direct', CommandAuthorized: true,
    SenderId: owner, SessionKey: sessionKey, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${owner}`}});
  const tools = Object.fromEntries(Object.keys(factories).map(name => [name, factories[name].create(ctx)]));
  const record = {label, input: text, calls: []}; report.cases.push(record); messages.push({role: 'user', content: text});
  for (let step = 0; step < 8; step++) {
    const response = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {method: 'POST',
      headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({model, messages, tools: definitions, max_tokens: 1600})});
    if (!response.ok) throw Error('model HTTP ' + response.status);
    const answer = (await response.json()).choices?.[0]?.message; if (!answer) throw Error('empty model answer'); messages.push(answer);
    if (!answer.tool_calls?.length) {
      record.reply = answer.content; await verify(record); record.passed = true;
      console.log(JSON.stringify({case: label, passed: true, calls: record.calls.length})); return;
    }
    for (const call of answer.tool_calls) {
      const args = JSON.parse(call.function.arguments), tool = tools[call.function.name];
      if (!tool) throw Error('unknown tool requested');
      const result = await tool.execute(call.id, args), value = JSON.parse(result.content[0].text);
      record.calls.push({tool: call.function.name, args, result: value});
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(value)});
    }
  }
  throw Error('model tool step limit');
}
try {
  let ready = false;
  for (let i = 0; i < 80; i++) {try {await client.request('/api/assistant/status'); ready = true; break;} catch {} await new Promise(r => setTimeout(r, 100));}
  assert.ok(ready, 'API startup failed: ' + errorLog.slice(-500));
  await turn('capability-read-only', '大肥鱼，你能维护提醒列表、定时提醒并记账吗？我先了解一下。', async () => {assert.equal((await client.allTasks({history: true})).length, 0);});
  await turn('bill-direct-save', '帮我记一笔：今天午饭花了14元，支出，其他信息不知道。', async record => {
    const all = await client.request('/api/assistant/bills'); assert.equal(all.total, 1); assert.equal(all.items[0].amount, '14.00');
    assert.ok(record.calls.some(c => c.tool === 'knowledge_bill_add' && c.result.ok));
  });
  await turn('condition-noDDL', '提醒列表加一条：跟本科党支部联系查党员材料，无DDL，备注写选举结束后越快越好。', async () => {
    const all = await client.allTasks(); assert.equal(all.length, 1); assert.equal(all[0].event_date, null);
    assert.match([all[0].title, all[0].detail, all[0].note].join(' '), /选举结束后/);
  });
  await turn('second-task', '提醒列表再加一条：收晾好的衣服，无DDL。', async () => {assert.equal((await client.allTasks()).length, 2);});
  fire('before_reset', {}, ctx); ctx.sessionId = 'km-model-new-session'; messages = [{role: 'system', content: system}];
  await turn('new-session-semantic-target', '我衣服晾好了，列表里可以去掉。', async record => {
    const all = await client.allTasks({history: true}); const clothes = all.find(x => x.title.includes('衣服'));
    assert.ok(clothes?.archived_at); assert.equal((await client.allTasks()).length, 1);
    assert.ok(record.calls.some(c => c.tool === 'personal_reminder_list_get'));
    assert.ok(record.calls.some(c => c.args.action === 'void' && c.result.ok));
  });
  await turn('monthly-query', '查一下我2026年10月的账单汇总，支出、收入和结余分别是多少？', async record => {
    assert.ok(record.calls.some(c => c.tool === 'knowledge_bills_get' && c.args.action === 'monthly' && c.result.expense === '14.00'));
  });
  report.ok = true;
} catch (error) {report.ok = false; report.error = error.message; process.exitCode = 1;}
finally {
  fs.writeFileSync(join(out, 'model.json'), JSON.stringify(report, null, 2) + '\n');
  child.kill('SIGTERM'); await new Promise(r => child.exitCode !== null ? r() : child.once('exit', r));
  if (beforeEnv.root === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = beforeEnv.root;
  if (beforeEnv.token === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN; else process.env.OPENCLAW_GATEWAY_TOKEN = beforeEnv.token;
  fs.rmSync(root, {recursive: true, force: true});
}
if (!report.ok) console.error(report.error);
