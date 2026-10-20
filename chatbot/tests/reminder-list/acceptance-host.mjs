import {compileAccessConfig} from '../../packages/access-control/config.js';
// Authorized live OpenClaw + primary-model integration in a separate /tmp
// runtime and process. Mock OneBot HTTP/WS only, no real QQ network or sends.
// All chat/domain/Cron state is isolated; source and credentials are read only.
// --natural runs the user dialogue suite; --out selects a separate evidence directory.
// Evidence: docs/verification/reminder-list-2026-10-11/host.json
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
import {dialogue} from './dialogue-cases.mjs';
import {productionSnapshot as guardedSnapshot} from './production-guard.mjs';
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const natural = process.argv.includes('--natural');
const outArg = process.argv.indexOf('--out');
const explicitOut = outArg < 0 ? undefined : process.argv[outArg + 1];
if (outArg >= 0 && !explicitOut) throw Error('--out requires an output directory');
const runtime = '/home/afrangry/.openclaw-fusion', root = fs.mkdtempSync(join(tmpdir(), 'kurumi-list-host-'));
const owner = '365999865', bot = '1794511189', token = randomBytes(24).toString('hex');
const secrets = JSON.parse(fs.readFileSync(join(runtime, 'runtime-env.json')));
function productionSnapshot() {return guardedSnapshot(runtime);}
const before = productionSnapshot(), mockSends = [];
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
const cfg = compileAccessConfig(JSON.parse(fs.readFileSync(join(repo, 'config/runtime.config.json'))),JSON.parse(fs.readFileSync(join(repo,'config/access-control.json'))));
delete cfg._managed;
cfg.gateway = {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}};
cfg.agents.defaults.workspace = join(root, 'workspace');
cfg.agents.entries = {main: {...cfg.agents.entries.main, workspace: join(root, 'workspace'), tools: {
  profile: 'messaging', alsoAllow: ['personal_reminder_list_get', 'personal_reminder_list_manage', ...(natural ? ['personal_reminder_state_get', 'personal_reminder_propose', 'personal_reminder_commit', 'personal_reminder_change_propose', 'personal_reminder_cancel_propose', 'automations'] : [])],
  deny: ['read', 'write', 'edit', 'exec', 'process', 'message', 'sessions_spawn', 'automations'],
}}};
cfg.plugins = {allow: ['kurumi-qq', 'personal-reminder-list'], load: {paths: [join(repo, 'chatbot/plugins/kurumi-qq'), join(repo, 'chatbot/plugins/personal-reminder-list')]},
  entries: {'kurumi-qq': {enabled: true}, 'personal-reminder-list': {enabled: true, config: {backendRoot: join(repo, 'chatbot'), defaultTimes: ['23:58']}}}, slots: {memory: 'none'}};
if (natural) {
  for (const id of ['personal-weather', 'personal-confirmation']) {
    cfg.plugins.allow.push(id); cfg.plugins.load.paths.push(join(repo, 'chatbot/plugins', id));
    cfg.plugins.entries[id] = JSON.parse(JSON.stringify(compileAccessConfig(JSON.parse(fs.readFileSync(join(repo, 'config/runtime.config.json'))),JSON.parse(fs.readFileSync(join(repo,'config/access-control.json')))).plugins.entries[id]));
  }
  cfg.plugins.entries['personal-weather'].config.apiHost = secrets.QWEATHER_API_HOST;
}
// Only these two plugins are loaded; remove provider declarations owned by
// excluded plugins rather than leaving an invalid Tavily reference behind.
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
});
fs.closeSync(logFd);
const {callGatewayFromCli} = await import('openclaw/plugin-sdk/gateway-runtime');
const call = (method, params = {}, timeout = 180000) => callGatewayFromCli(method, {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
const report = {at: new Date().toISOString(), boundary: 'Real configured model and real OpenClaw inbound dispatch/v2 tool/deferred catalog/native scheduler; isolated runtime/process and mock OneBot. No QQ send or production domain/Cron changes.', cases: [], suite: natural ? 'natural-input' : 'baseline'};
let messageId = -100000;
async function turn(label, text, verify) {
  const result = await call('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: Number(bot), user_id: Number(owner), message_id: --messageId, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text}}]}});
  const db = new DatabaseSync(join(root, 'state/personal-reminder-list/list.sqlite'), {readOnly: true});
  let data;
  try {data = {items: db.prepare('SELECT id,title,content,note,ddl,deadline_ms,status,version FROM items ORDER BY created_ms,id').all(), settings: db.prepare('SELECT * FROM settings').get()};}
  finally {db.close();}
  verify(data, result);
  assert.ok(!/\bversion\b|expectedVersion|scheduleSync|personal_reminder_list|\bresume\b|\bpause\b/i.test((result.captured ?? []).map(p => p.text ?? '').join('\n')), 'Internal tool fields leaked into normal chat reply');
  const receipt = {label, passed: true, result: {ok: result.ok, captured: result.captured}, state: data};
  report.cases.push(receipt); console.log(JSON.stringify({case: label, passed: true}));
}
try {
  let up = false;
  for (let i = 0; i < 60; i++) {
    try {await call('health', {}, 1000); up = true; break;} catch {if (child.exitCode !== null) throw Error('Isolated Gateway exited before ready'); await new Promise(r => setTimeout(r, 500));}
  }
  assert.ok(up, 'Isolated Gateway startup timed out');
  if (natural) {
    await turn('user-1-capability', dialogue[0], data => {assert.equal(data.items.length, 0); assert.equal(data.settings.version, 1);});
    const needles = ['党支部换届选举', '组会', '党员材料', '数学分析', 'Web程序设计作业', '党费'];
    const ddls = ['2026-10-13T10:00', '2026-10-12T19:30', null, '2026-10-12T10:30', '2026-10-16', null];
    for (let i = 0; i < 6; i++) await turn('user-' + (i + 2) + '-add', dialogue[i + 1], data => {
      assert.equal(data.items.length, i + 1);
      const found = data.items.filter(item => [item.title, item.content, item.note].join(' ').includes(needles[i]));
      assert.equal(found.length, 1); const item = found[0]; assert.equal(item.ddl, ddls[i]); assert.equal(item.status, 'active');
      const body = [item.title,item.content,item.note].join(' ');
      if (i === 0) assert.match(body, /B806/);
      if (i === 2) {assert.equal(item.deadline_ms, null); assert.match(body, /越快越好/);}
      if (i === 4) {assert.match(body, /学号-姓名-作业1/); assert.match(body, /钉钉/); assert.equal(item.deadline_ms, Date.parse('2026-10-17T00:00:00+08:00'));}
      if (i === 5) {assert.equal(item.deadline_ms, null); assert.match(body, /选举后/);}
    });
    await turn('implicit-event-condition', '还有一条：会议结束后整理会议材料，无DDL，只要知道有这回事就行。', data => {
      assert.equal(data.items.length, 7); const i = data.items.find(i => i.title.includes('会议材料'));
      assert.equal(i?.ddl, null); assert.equal(i?.deadline_ms, null); assert.match([i.title,i.content,i.note].join(' '), /会议结束后/);
    });
    await turn('failed-list-stays-list', '提醒列表添加验收作业，DDL为下次课前。', data => assert.equal(data.items.length, 7));
    await turn('topic-change', '谢谢，先结束录入。', data => assert.equal(data.items.length, 7));
    await turn('implicit-after-end-denied', '还有一个：明天需要提交补充材料。', data => assert.equal(data.items.length, 7));
    await turn('reopen-intake-before-reset', dialogue[0], data => assert.equal(data.items.length, 7));
    const reset = await call('sessions.reset', {key: 'agent:main:kurumi-qq:direct:' + owner, reason: 'new'});
    report.reset = {ok: reset.ok !== false};
    await turn('implicit-after-reset-denied', '还有一个：明天需要提交补充材料。', data => assert.equal(data.items.length, 7));
    const reminderFile = join(root, 'state/personal-reminders/reminders.sqlite');
    if (fs.existsSync(reminderFile)) {
      const oneoff = new DatabaseSync(reminderFile, {readOnly: true});
      try {report.oneoffProposals = oneoff.prepare('SELECT COUNT(*) n FROM reminder_proposals').get().n;}
      finally {oneoff.close();}
    } else report.oneoffProposals = 0;
    assert.equal(report.oneoffProposals, 0);
  } else {
  await turn('actual-host-add', '帮我在提醒列表里加一条：验收汇报，备注写越快越好，不设置DDL。', data => assert.equal(data.items.find(i => i.title === '验收汇报')?.status, 'active'));
  await turn('actual-host-update', '把提醒列表中的验收汇报备注改成提前熟悉PPT。', data => assert.equal(data.items.find(i => i.title === '验收汇报')?.note, '提前熟悉PPT'));
  await turn('actual-host-complete', '我在提醒列表中验收汇报事项做好了。', data => assert.equal(data.items.find(i => i.title === '验收汇报')?.status, 'completed'));
  await turn('actual-host-schedule', '提醒列表每天播报时间改成09:30、20:45和24:00。', data => assert.deepEqual(JSON.parse(data.settings.times_json), ['00:00', '09:30', '20:45']));
  const jobs = (await call('cron.list', {includeDisabled: true, limit: 100})).jobs;
  report.activeJobTimes = jobs.filter(j => j.declarationKey?.startsWith('kurumi.reminder-list.daily:')).map(j => j.declarationKey.slice('kurumi.reminder-list.daily:'.length)).sort();
  report.unrelatedJobs = jobs.filter(j => !j.declarationKey?.startsWith('kurumi.reminder-list.daily:')).length;
  assert.deepEqual(report.activeJobTimes, ['00:00', '09:30', '20:45']);
  report.persistentRunnerPaths = jobs.filter(j => j.declarationKey?.startsWith('kurumi.reminder-list.daily:')).every(job => {
    assert.equal(job.payload.cwd, join(repo, 'chatbot'));
    assert.equal(job.payload.argv[1], join(repo, 'chatbot/scripts/reminder-list.mjs'));
    assert.ok(fs.existsSync(job.payload.argv[1]));
    return true;
  });
  // Execute an actual scheduler-created command, rather than only inspecting
  // its path. The isolated list has no active items, so this must remain silent.
  const smokeJob = jobs.find(j => j.declarationKey?.startsWith('kurumi.reminder-list.daily:'));
  const smokeAt = Date.now();
  await call('cron.run', {id: smokeJob.id, mode: 'force'}, 30000);
  let smokeRun;
  for (let i = 0; i < 30; i++) {
    smokeRun = (await call('cron.runs', {id: smokeJob.id, limit: 5})).entries.find(r => r.runAtMs >= smokeAt);
    if (smokeRun) break;
    await new Promise(r => setTimeout(r, 500));
  }
  assert.equal(smokeRun?.status, 'ok', 'Configured runner failed to execute');
  assert.notEqual(smokeRun?.delivered, true, 'Empty isolated list must not announce');
  report.configuredRunnerExecution = {status: smokeRun.status, deliveryStatus: smokeRun.deliveryStatus, delivered: smokeRun.delivered === true};
  await turn('actual-host-pause', '暂停提醒列表播报。', data => assert.equal(data.settings.enabled, 0));
  assert.equal((await call('cron.list', {includeDisabled: true, limit: 100})).jobs.filter(j => j.declarationKey?.startsWith('kurumi.reminder-list.daily:')).length, 0);
  await turn('actual-host-resume', '恢复提醒列表播报。', data => assert.equal(data.settings.enabled, 1));
  assert.equal((await call('cron.list', {includeDisabled: true, limit: 100})).jobs.filter(j => j.declarationKey?.startsWith('kurumi.reminder-list.daily:')).length, 3);
  }
  report.productionUnchanged = productionSnapshot() === before;
  assert.ok(report.productionUnchanged); assert.equal(mockSends.length, 0);
  report.passed = true;
} catch (error) {report.passed = false; report.error = error.message; process.exitCode = 1;}
finally {
  child.kill('SIGTERM');
  if (child.exitCode === null) {
    let killTimer;
    await Promise.race([once(child, 'exit'), new Promise(r => killTimer = setTimeout(() => {try {process.kill(-child.pid, 'SIGKILL');} catch {} r();}, 35000))]);
    clearTimeout(killTimer);
  }
  for (const client of ws.clients) client.terminate();
  await new Promise(r => ws.close(r)); await new Promise(r => server.close(r));
  report.childStopped = child.exitCode !== null || child.signalCode !== null;
  report.productionUnchanged = productionSnapshot() === before;
  if (!report.productionUnchanged || !report.childStopped) {report.passed = false; process.exitCode = 1;}
  report.mockSends = mockSends.length;
  const evidenceDir = explicitOut ? resolve(explicitOut) : join(repo, 'docs/verification/reminder-list-2026-10-11', natural ? 'natural-input' : ''); fs.mkdirSync(evidenceDir, {recursive: true});
  fs.writeFileSync(join(evidenceDir, 'host.json'), JSON.stringify(report, null, 2) + '\n');
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  else console.log(JSON.stringify({failedFixtureForDiagnostics: root}));
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.length, childStopped: report.childStopped, productionUnchanged: report.productionUnchanged, error: report.error}));
}
