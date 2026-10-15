// Authorized live primary-model acceptance with actual plugin tool factories.
// Only /tmp domain state. Service callbacks are not started; Gateway token is
// removed, so schedule sync cannot mutate production Cron. No QQ delivery.
// --natural runs the user dialogue suite; --ordinal verifies contextual item operations.
// --out selects a separate evidence directory.
// Evidence: docs/verification/reminder-list-2026-10-11/model.json
import {manageList} from '../../plugins/personal-reminder-list/application.js';
import fs from 'node:fs';
import {join, resolve} from 'node:path';
import {tmpdir} from 'node:os';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {ListStore} from '../../plugins/personal-reminder-list/store.js';
import {localTime} from '../../plugins/personal-reminder-list/time.js';
import plugin from '../../plugins/personal-reminder-list/index.js';
import {dialogue} from './dialogue-cases.mjs';
import {productionSnapshot as guardedSnapshot} from './production-guard.mjs';
import {toolPluginMetadataSymbol} from 'openclaw/plugin-sdk/tool-plugin';
import weather from '../../plugins/personal-weather/dist/index.js';

const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url)));
const natural = process.argv.includes('--natural');
const ordinal = process.argv.includes('--ordinal');
if (natural && ordinal) throw Error('Choose one suite');
const outArg = process.argv.indexOf('--out');
const explicitOut = outArg < 0 ? undefined : process.argv[outArg + 1];
if (outArg >= 0 && !explicitOut) throw Error('--out requires an output directory');
const outDir = explicitOut ? resolve(explicitOut) : resolve(repo, 'docs/verification/reminder-list-2026-10-11', natural ? 'natural-input' : '');
const runtime = '/home/afrangry/.openclaw-fusion';
const cfg = JSON.parse(fs.readFileSync(join(repo, 'config/runtime.config.json')));
const primary = cfg.agents.entries.main.model.primary, [providerId, model] = primary.split('/');
const provider = cfg.models.providers[providerId];
const secrets = JSON.parse(fs.readFileSync(join(runtime, 'runtime-env.json')));
const key = secrets[provider.apiKey.id];
if (!key || new URL(provider.baseUrl).hostname !== 'api.deepseek.com') throw Error('Expected configured official DeepSeek provider');
const owner = cfg.channels['kurumi-qq'].ownerId, session = `agent:main:kurumi-qq:direct:${owner}`;
const root = fs.mkdtempSync(join(tmpdir(), 'kurumi-list-model-'));
const oldRoot = process.env.OPENCLAW_STATE_DIR, oldGatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
process.env.OPENCLAW_STATE_DIR = root;
delete process.env.OPENCLAW_GATEWAY_TOKEN;
const hooks = {}, factories = {}, ctx = {senderIsOwner: true, requesterSenderId: owner, messageChannel: 'kurumi-qq', sessionKey: session, sessionId: 'model-acceptance-session', runId: 'reminder-list-model-acceptance', getRuntimeConfig: () => cfg, assertInvocationCurrent() {}};
plugin.register({config: cfg, registrationMode: 'full', pluginConfig: {backendRoot: join(repo, 'chatbot')}, logger: {warn() {}}, on: (name, fn) => hooks[name] = fn, registerTool: (f, meta) => factories[meta.name] = f, registerService() {}});
const definitions = Object.keys(factories).map(name => {const t = factories[name].create(ctx); return {type: 'function', function: {name, description: t.description, parameters: t.parameters}};});
if (natural) {
  const declaration = weather[toolPluginMetadataSymbol].tools.find(t => t.name === 'personal_reminder_propose');
  definitions.push({type: 'function', function: {name: declaration.name, description: declaration.description, parameters: declaration.parameters}});
}
const messages = [{role: 'system', content: fs.readFileSync(join(repo, 'scripts/fusion/templates/AGENTS.md'), 'utf8') + `\n当前实际本地时间 ${localTime(Date.now())} Asia/Shanghai。本人QQ身份已由可信入站提供；所有工具结果指向独立验收库。自然澄清缺失字段，真实工具结果才是完成依据。`}];
const report = {at: new Date().toISOString(), model: primary, boundary: 'Real configured model, actual plugin v2 tool factories with synthetic trusted owner hooks; temporary domain SQLite only; competing one-off declaration is a non-writing routing fixture. No QQ send, no production domain write or Cron mutation; not full OpenClaw/QQ inbound.', cases: [], suite: ordinal ? 'ordinal' : natural ? 'natural-input' : 'baseline', competingProposalAttempts: 0};
function productionSnapshot() {return guardedSnapshot(runtime);}
const before = productionSnapshot();
let seq = 0;
const inspect = () => {
  const store = new ListStore({root, ownerId: owner});
  try {return store.get({history: true});} finally {store.close();}
};
async function turn(label, text, verify) {
  const row = {label, input: text, calls: []}; report.cases.push(row);
  hooks.reply_dispatch({ctx: {RawBody: text, MessageSid: 'model-' + ++seq, Timestamp: Date.now(), ChatType: 'direct', CommandAuthorized: true, SenderId: owner, SessionKey: session, OriginatingChannel: 'kurumi-qq', OriginatingTo: `user:${owner}`}});
  const tools = Object.fromEntries(Object.keys(factories).map(name => [name, factories[name].create(ctx)]));
  messages.push({role: 'user', content: text});
  for (let step = 0; step < 8; step++) {
    const response = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
      method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(90000),
      body: JSON.stringify({model, messages, tools: definitions, max_tokens: 2048}),
    });
    if (!response.ok) throw Error(`Model HTTP ${response.status}`);
    const result = await response.json(), answer = result.choices?.[0]?.message;
    if (!answer) throw Error('No model message');
    messages.push(answer);
    if (!answer.tool_calls?.length) {
      row.reply = answer.content; verify(inspect(), row); row.passed = true;
      console.log(JSON.stringify({case: label, passed: true, toolCalls: row.calls.length})); return;
    }
    for (const call of answer.tool_calls) {
      const tool = tools[call.function.name];
      const args = JSON.parse(call.function.arguments);
      const blocked = hooks.before_tool_call?.({toolName: call.function.name, params: args}, ctx);
      let value;
      if (call.function.name === 'personal_reminder_propose') {
        report.competingProposalAttempts++;
        value = {ok: false, error: {code: blocked?.block ? 'tool_blocked' : 'fixture_competing_proposal', message: blocked?.blockReason ?? '竞争工具仅作模型路由观察，不存提案'}};
      } else {
        if (!tool) throw Error('Unknown requested tool');
        value = blocked?.block ? {ok: false, error: {code: 'tool_blocked', message: blocked.blockReason}} : JSON.parse((await tool.execute(call.id, args)).content[0].text);
      }
      row.calls.push({name: call.function.name, args, result: value});
      messages.push({role: 'tool', tool_call_id: call.id, content: JSON.stringify(value)});
    }
  }
  throw Error('Exceeded bounded tool rounds');
}
try {
  if (ordinal) {
    const seed = new ListStore({root, ownerId: owner});
    const seedItem = (title, ddl = null) => manageList(seed, {action: 'add', title, ddl}, {raw: `提醒列表添加${title} DDL ${ddl ?? ''}`, actions: new Set(['add']), at: Date.now(), messageId: 'seed-' + title, sessionKey: session}).item;
    let target, inserted;
    try {
      for (let i = 1; i <= 5; i++) seedItem('验收事项' + i, localTime(Date.now() + (i + 1) * 86400000).slice(0, 10));
      target = seedItem('党支部换届选举后需要整理党费缴纳情况');
      await turn('show-six-items', '把当前提醒列表按查询返回顺序编号列出来。', (data, row) => {
        assert.equal(data.items.length, 6);
        const listed = row.calls.find(c => c.name === 'personal_reminder_list_get')?.result.items;
        assert.equal(listed?.[5]?.id, target.id);
        assert.match(row.reply ?? '', /6[.、．)）\s][\s\S]*党费/u);
      });
      // A concurrent insertion changes the latest sort order. The spoken ordinal
      // must continue referring to the list already shown to the user.
      inserted = seedItem('验收新插入项', localTime(Date.now() + 86400000).slice(0, 10));
    } finally {seed.close();}
    await turn('ordinal-delete-after-reorder', '大肥鱼，第六条可以删了', (data, row) => {
      assert.equal(data.items.find(i => i.id === target.id)?.status, 'void');
      assert.equal(data.items.find(i => i.id === inserted.id)?.status, 'active');
      const writes = row.calls.filter(c => c.name === 'personal_reminder_list_manage');
      assert.equal(writes.length, 1); assert.equal(writes[0].result.ok, true);
      assert.equal(writes[0].args.action, 'void'); assert.equal(writes[0].result.item.id, target.id);
    });
    await turn('title-delete', '提醒列表里，把“验收事项2”删掉。', data => assert.equal(data.items.find(i => i.title === '验收事项2')?.status, 'void'));
    await turn('title-void', '提醒列表里，把“验收事项3”作废。', data => assert.equal(data.items.find(i => i.title === '验收事项3')?.status, 'void'));
    const unchanged = JSON.stringify(inspect().items);
    for (const [label, text] of [['negative', '别删验收事项4，保留它。'], ['hypothetical', '如果我说“验收事项4作废”，你会怎么办？仅讨论，不执行。']]) {
      await turn(label, text, (data, row) => {assert.equal(JSON.stringify(data.items), unchanged); assert.ok(!row.calls.some(c => c.name === 'personal_reminder_list_manage'));});
    }
    hooks.before_reset({}, ctx); ctx.sessionId = 'ordinal-new-session'; messages.splice(1);
    await turn('ordinal-without-prior-list', '大肥鱼，第六条可以删了', (data, row) => {
      assert.equal(JSON.stringify(data.items), unchanged);
      assert.ok(!row.calls.some(c => c.name === 'personal_reminder_list_manage'));
      assert.match(row.reply ?? '', /哪|确认|列表|标题|不确定|对应/u);
    });
  } else if (natural) {
    await turn('user-1-capability', dialogue[0], (data, row) => {
      assert.equal(data.items.length, 0); assert.ok(row.calls.some(c => c.name === 'personal_reminder_list_get'));
      assert.equal(data.settings.version, 1);
    });
    const needles = ['党支部换届选举', '组会', '党员材料', '数学分析', 'Web程序设计作业', '党费'];
    const ddls = ['2026-10-13T10:00', '2026-10-12T19:30', null, '2026-10-12T10:30', '2026-10-16', null];
    for (let i = 0; i < 6; i++) await turn('user-' + (i + 2) + '-add', dialogue[i + 1], (data, row) => {
      assert.equal(data.items.length, i + 1);
      const found = data.items.filter(item => [item.title, item.content, item.note].join(' ').includes(needles[i]));
      assert.equal(found.length, 1); const item = found[0]; assert.equal(item.ddl, ddls[i]); assert.equal(item.status, 'active');
      const body = [item.title, item.content, item.note].join(' ');
      if (i === 0) assert.match(body, /B806/);
      if (i === 2) {assert.equal(item.deadlineMs, null); assert.match(body, /越快越好/);}
      if (i === 4) {assert.match(body, /学号-姓名-作业1/); assert.match(body, /钉钉/); assert.equal(item.deadlineMs, Date.parse('2026-10-17T00:00:00+08:00'));}
      if (i === 5) {assert.equal(item.deadlineMs, null); assert.match(body, /选举后/);}
      assert.ok(!row.calls.some(c => c.name === 'personal_reminder_propose'));
    });
    await turn('implicit-event-condition', '还有一条：会议结束后整理会议材料，无DDL，只要知道有这回事就行。', data => {
      assert.equal(data.items.length, 7); const i = data.items.find(i => i.title.includes('会议材料'));
      assert.equal(i?.ddl, null); assert.equal(i?.deadlineMs, null); assert.match([i.title,i.content,i.note].join(' '), /会议结束后/);
    });
    await turn('failed-list-stays-list', '提醒列表添加验收作业，DDL为下次课前。', (data, row) => {
      assert.equal(data.items.length, 7); assert.ok(!row.calls.some(c => c.name === 'personal_reminder_propose'));
      assert.match(row.reply ?? '', /哪天|日期|什么时候|时间|下次.*课/);
    });
    await turn('topic-change', '谢谢，先结束录入。', data => assert.equal(data.items.length, 7));
    await turn('implicit-after-end-denied', '还有一个：明天需要提交补充材料。', (data,row) => {
      assert.equal(data.items.length, 7); assert.ok(!row.calls.some(c => c.result.ok));
    });
    assert.equal(report.competingProposalAttempts, 0);
  } else {
  const tomorrow = localTime(Date.now() + 86400000).slice(0, 10);
  await turn('add-with-ddl', '帮我在提醒列表里加一条：验收汇报，内容写提前熟悉PPT，备注写越快越好，DDL为明天19:30。', data => {
    const i = data.items.find(i => i.title === '验收汇报'); assert.equal(i?.ddl, tomorrow + 'T19:30'); assert.equal(i?.note, '越快越好');
  });
  await turn('add-without-ddl', '提醒列表添加验收材料，备注写越快越好，没有DDL。', data => assert.equal(data.items.find(i => i.title === '验收材料')?.ddl, null));
  await turn('update-note', '把提醒列表里的验收汇报备注改成带打印稿。', data => assert.equal(data.items.find(i => i.title === '验收汇报')?.note, '带打印稿'));
  await turn('complete', '我在提醒列表中验收汇报事项做好了。', data => assert.equal(data.items.find(i => i.title === '验收汇报')?.status, 'completed'));
  await turn('void', '提醒列表里的验收材料作废。', data => assert.equal(data.items.find(i => i.title === '验收材料')?.status, 'void'));
  await turn('schedule-count-and-midnight', '把提醒列表每天播报改为09:30、20:45和24:00，每天三次。', data => assert.deepEqual(data.settings.times, ['00:00', '09:30', '20:45']));
  await turn('pause', '暂停提醒列表播报。', data => assert.equal(data.settings.enabled, false));
  await turn('resume', '恢复提醒列表播报。', data => assert.equal(data.settings.enabled, true));
  await turn('date-only', '提醒列表添加验收日结，DDL为明天，只规定日期没有具体钟点。', data => assert.equal(data.items.find(i => i.title === '验收日结')?.ddl, tomorrow));
  await turn('unknown-ddl-clarification', '帮我在提醒列表添加验收作业，DDL为下次课前。', (data, row) => {
    assert.ok(!data.items.some(i => i.title === '验收作业')); assert.match(row.reply ?? '', /什么时候|哪天|日期|时间|下次.*课/);
  });
  const store = new ListStore({root, ownerId: owner});
  try {
    for (const title of ['验收候选A', '验收候选B']) manageList(store, {action: 'add', title}, {raw: '提醒列表添加 ' + title, at: Date.now(), actions: new Set(['add']), messageId: title, sessionKey: session});
  } finally {store.close();}
  await turn('ambiguous-target', '我在提醒列表里的验收候选事项做好了。', (data, row) => {
    assert.ok(data.items.filter(i => i.title.startsWith('验收候选')).every(i => i.status === 'active')); assert.match(row.reply ?? '', /哪|具体|ID|编号|一条|A.*B/);
  });
  await turn('active-list-only', '查看有效提醒列表。', (_data, row) => {
    const calls = row.calls.filter(c => c.name === 'personal_reminder_list_get'); assert.ok(calls.length); assert.ok(calls.every(c => c.result.items.every(i => i.status === 'active')));
  });
  }
  report.passed = true;
} catch (error) {report.passed = false; report.error = error.message; process.exitCode = 1;}
finally {
  report.productionUnchanged = productionSnapshot() === before;
  if (!report.productionUnchanged) {report.passed = false; process.exitCode = 1;}
  if (oldRoot === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = oldRoot;
  if (oldGatewayToken === undefined) delete process.env.OPENCLAW_GATEWAY_TOKEN; else process.env.OPENCLAW_GATEWAY_TOKEN = oldGatewayToken;
  fs.mkdirSync(outDir, {recursive: true}); fs.writeFileSync(join(outDir, 'model.json'), JSON.stringify(report, null, 2) + '\n');
  fs.rmSync(root, {recursive: true, force: true});
  console.log(JSON.stringify({passed: report.passed, cases: report.cases.filter(c => c.passed).length, productionUnchanged: report.productionUnchanged, error: report.error}));
}
