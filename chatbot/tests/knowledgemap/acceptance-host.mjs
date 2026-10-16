#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「测试计划」。
// Real model + real isolated OpenClaw dispatch + FastAPI/SQLite; mock OneBot. No QQ/production writes.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import assert from 'node:assert/strict';
import {WebSocketServer} from 'ws';
import {productionSnapshot as guardedSnapshot} from '../reminder-list/production-guard.mjs';

import {KnowledgeMapClient} from '../../packages/knowledgemap-client/client.js';
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const km = process.env.KM_TEST_REPO ?? '/home/afrangry/repository';
const outArg = process.argv.indexOf('--out');
if (outArg < 0 || !process.argv[outArg + 1]) throw Error('--out required');
const explicitOut = process.argv[outArg + 1];
const runtime = '/home/afrangry/.openclaw-fusion', root = fs.mkdtempSync(join(tmpdir(), 'km-host-'));
const owner = '365999865', bot = '1794511189', token = randomBytes(24).toString('hex');
const secrets = JSON.parse(fs.readFileSync(join(runtime, 'runtime-env.json')));
const before = guardedSnapshot(runtime), mockSends = [];
const server = http.createServer(async (req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {res.writeHead(401); res.end(); return;}
  let raw = ''; for await (const part of req) raw += part;
  const args = raw ? JSON.parse(raw) : {};
  let data = req.url === '/get_login_info' ? {user_id: Number(bot), nickname: 'Isolated fixture'}
    : req.url === '/get_status' ? {online: true, good: true} : {};
  if (req.url === '/send_private_msg') {mockSends.push(args); data = {message_id: 20000 + mockSends.length};}
  res.writeHead(200, {'Content-Type': 'application/json'}); res.end(JSON.stringify({status: 'ok', retcode: 0, data}));
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');
const onebotPort = server.address().port, ws = new WebSocketServer({server});
const portProbe = net.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
const port = portProbe.address().port; await new Promise(r => portProbe.close(r));

const apiProbe = net.createServer(); apiProbe.listen(0, '127.0.0.1'); await once(apiProbe, 'listening');
const apiPort = apiProbe.address().port; await new Promise(r => apiProbe.close(r));
const tokenFile = join(root, 'bridge-token'); fs.writeFileSync(tokenFile, token, {mode: 0o600});
const apiChild = spawn('/home/afrangry/miniconda3/envs/desheng/bin/python', [join(km, 'backend/tests/assistant_server.py'), '--port', String(apiPort), '--token-file', tokenFile], {stdio: 'ignore'});
const api = new KnowledgeMapClient({baseUrl: `http://127.0.0.1:${apiPort}`, tokenFile, trace() {}});
const cfg = JSON.parse(fs.readFileSync(join(repo, 'config/runtime.config.json'))); delete cfg._managed;
cfg.gateway = {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}};
cfg.agents.defaults.workspace = join(root, 'workspace');
cfg.agents.entries = {main: {...cfg.agents.entries.main, workspace: join(root, 'workspace'), tools: {
  profile: 'messaging', alsoAllow: ['personal_reminder_list_get', 'personal_reminder_list_manage', 'knowledge_bills_get', 'knowledge_bill_add'],
  deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn', 'automations'],
}}};
cfg.plugins = {allow: ['kurumi-qq', 'personal-reminder-list', 'kurumi-knowledgemap'], load: {paths: ['kurumi-qq', 'personal-reminder-list', 'kurumi-knowledgemap'].map(p => join(repo, 'chatbot/plugins', p))},
  entries: {'kurumi-qq': {enabled: true},
    'personal-reminder-list': {enabled: true, config: {backendRoot: join(repo, 'chatbot'), defaultTimes: ['23:58'], dataSource: 'knowledgemap', bridgeBaseUrl: api.baseUrl, bridgeTokenFile: tokenFile}},
    'kurumi-knowledgemap': {enabled: true, config: {baseUrl: api.baseUrl, tokenFile}}}, slots: {memory: 'none'}};
cfg.tools = {deny: cfg.tools.deny, fs: cfg.tools.fs, web: {search: {enabled: false}, fetch: {enabled: false}}};
cfg.channels['kurumi-qq'] = {...cfg.channels['kurumi-qq'], httpUrl: `http://127.0.0.1:${onebotPort}`, wsUrl: `ws://127.0.0.1:${onebotPort}`,
  httpTokenFile: join(root, 'http-token'), wsTokenFile: join(root, 'ws-token'), stateDir: join(root, 'channel'), mediaRoot: join(root, 'media'), testIngress: true};
cfg.logging.file = join(root, 'runtime.log');
for (const dir of ['workspace', 'channel', 'media']) fs.mkdirSync(join(root, dir), {mode: 0o700});
for (const file of ['http-token', 'ws-token']) fs.writeFileSync(join(root, file), token, {mode: 0o600});
fs.writeFileSync(join(root, 'openclaw.json'), JSON.stringify(cfg), {mode: 0o600});
fs.copyFileSync(join(repo, 'scripts/fusion/templates/AGENTS.md'), join(root, 'workspace/AGENTS.md'));
fs.copyFileSync(join(repo, 'roles/小鲸鱼.md'), join(root, 'workspace/SOUL.md'));
fs.writeFileSync(join(root, 'workspace/IDENTITY.md'), '# Identity\n小鲸鱼\n');
const sdk = resolve(repo, 'node_modules/openclaw/openclaw.mjs'), logFd = fs.openSync(join(root, 'gateway.log'), 'w', 0o600);
const child = spawn(process.execPath, [sdk, 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
  cwd: repo, env: {...process.env, ...secrets, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: join(root, 'openclaw.json'), OPENCLAW_AGENT_DIR: join(root, 'agents/main/agent')},
  stdio: ['ignore', logFd, logFd], detached: true,
}); fs.closeSync(logFd);
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
const call = (method, params = {}, timeout = 180000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
const report = {at: new Date().toISOString(), boundary: 'Real model and real OpenClaw inbound/v2 tool catalog/native Cron + real isolated API/SQLite; mock OneBot, no real QQ/production writes', cases: []};
let messageId = -210000;
async function turn(label, text, verify) {
  const result = await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(owner), message_id: --messageId, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text}}]}});
  await verify(result); report.cases.push({label, passed: true, captured: result.captured});
  console.log(JSON.stringify({case: label, passed: true}));
}
try {
  let up = false;
  for (let i = 0; i < 80; i++) {
    try {await api.request('/api/assistant/status'); await call('health', {}, 1000); up = true; break;} catch {if (child.exitCode !== null) throw Error('isolated gateway exited; inspect private fixture log'); await new Promise(r => setTimeout(r, 500));}
  }
  assert.ok(up, 'isolated gateway timed out');
  await turn('host-bill-save', '帮我记一笔，今天午饭支出14元，其他信息不知道。', async () => {
    const all = await api.request('/api/assistant/bills'); assert.equal(all.total, 1); assert.equal(all.items[0].amount, '14.00');
  });
  await turn('host-noDDL-add', '提醒列表加一条：收晾好的衣服，无DDL。', async () => {assert.equal((await api.allTasks()).length, 1); assert.equal((await api.allTasks())[0].event_date, null);});
  await turn('host-reset', '/new', async () => {});
  await turn('host-semantic-void', '我衣服晾好了，列表里可以去掉。', async () => {assert.equal((await api.allTasks()).length, 0); assert.ok((await api.allTasks({history: true}))[0].archived_at);});
  await turn('host-monthly', '查一下2026年10月的账单支出和结余。', async result => {assert.match(JSON.stringify(result.captured), /14/);});
  await turn('host-schedule', '把提醒列表每天播报改成08:15和18:15两次。', async () => {
    const db = new DatabaseSync(join(root, 'state/personal-reminder-list/list.sqlite'), {readOnly: true});
    try {assert.equal(db.prepare('SELECT times_json FROM settings').get().times_json, '["08:15","18:15"]');} finally {db.close();}
    const jobs = (await call('cron.list', {includeDisabled: true, limit: 100})).jobs.filter(j => j.declarationKey?.startsWith('kurumi.reminder-list.daily:'));
    assert.equal(jobs.length, 2); for (const job of jobs) assert.equal(job.payload.env.KURUMI_LIST_DATA_SOURCE, 'knowledgemap');
  });
  report.productionUnchanged = guardedSnapshot(runtime) === before; assert.ok(report.productionUnchanged); assert.equal(mockSends.length, 0); report.passed = true;
} catch (error) {report.passed = false; report.error = error.message; process.exitCode = 1;}
finally {
  for (const c of [child, apiChild]) {
    c.kill('SIGTERM'); if (c.exitCode === null) {
      let timer; await Promise.race([once(c, 'exit'), new Promise(r => timer = setTimeout(() => {c.kill('SIGKILL'); r();}, 15000))]); clearTimeout(timer);
    }
  }
  for (const client of ws.clients) client.terminate(); await new Promise(r => ws.close(r)); await new Promise(r => server.close(r));
  report.childStopped = child.exitCode !== null || child.signalCode !== null;
  report.productionUnchanged = guardedSnapshot(runtime) === before; report.mockSends = mockSends.length;
  if (!report.productionUnchanged || !report.childStopped) {report.passed = false; process.exitCode = 1;}
  const evidenceDir = resolve(explicitOut); fs.mkdirSync(evidenceDir, {recursive: true}); fs.writeFileSync(join(evidenceDir, 'host.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) fs.rmSync(root, {recursive: true, force: true}); else console.log(JSON.stringify({failedFixtureForDiagnostics: root}));
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, childStopped: report.childStopped, productionUnchanged: report.productionUnchanged, error: report.error}));
}
