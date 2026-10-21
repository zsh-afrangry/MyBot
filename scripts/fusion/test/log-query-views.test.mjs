// Synthetic-data regressions for the log-query views (doc 18 P0 items 1–8).
// Every record here is invented; nothing reads the live runtime root.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {zstdCompressSync} from 'node:zlib';
import {collectEvents, filterEvents, renderQuery} from '../log-query.mjs';
import {applyViewFilters, auditTurns, collectErrors, deepParseJson, groupTurns, matchesKind, pairCalls} from '../log-query-views.mjs';

const T0 = Date.parse('2026-10-21T12:00:00+08:00');
const SESSION = 's1';
const KEY = 'agent:main:kurumi-qq:direct:10001';
const iso = (offset) => new Date(T0 + offset).toISOString();
const user = (text) => ({role: 'user', content: [{type: 'text', text}]});
const assistant = (runId, content) => ({role: 'assistant', content, __openclaw: {runId}});
const wrapped = (id, toolId, args) => ({type: 'toolCall', id, name: 'tool_call', arguments: {id: toolId, args}});
const nested = (runId, toolCallId, parentToolCallId, startedAt, timestamp, isError, details) => ({
  role: 'custom', customType: 'openclaw.nested-tool.v1',
  details: {toolName: 'reminder_create', toolCallId, parentToolCallId, startedAt: T0 + startedAt, timestamp: T0 + timestamp, isError, input: {text: '开会'}, result: {content: [], details}, runId},
});
const toolResult = (toolCallId, toolName, isError, text, details) => ({role: 'toolResult', toolCallId, toolName, isError, content: [{type: 'text', text}], details});

function buildRuntimeRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-query-views-'));
  const dbDir = path.join(root, 'agents', 'main', 'agent');
  fs.mkdirSync(dbDir, {recursive: true});
  fs.mkdirSync(path.join(root, 'channel'));
  const db = new DatabaseSync(path.join(dbDir, 'openclaw-agent.sqlite'));
  db.exec(`CREATE TABLE session_windows (session_id TEXT, session_key TEXT, created_at INTEGER, updated_at INTEGER, channel TEXT,
    account_id TEXT, chat_type TEXT, primary_conversation_id TEXT);
    CREATE TABLE transcript_events (session_id TEXT, seq INTEGER, event_json TEXT, event_zstd BLOB, created_at INTEGER);`);
  db.prepare('INSERT INTO session_windows VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(SESSION, KEY, T0 - 1000, T0 + 10_000, 'kurumi-qq', 'a', 'direct', 'c1');
  const failedResult = JSON.stringify({tool: 'openclaw:kurumi-tasks:reminder_create', result: {details: {ok: false, code: 'CONFIG_INVALID'}}});
  const records = [
    [0, {type: 'message', message: user('提醒我明天开会')}],
    [100, {type: 'message', message: assistant('r1', [wrapped('call_00_a', 'openclaw:kurumi-tasks:reminder_create', '{"text":"开会","when":"\\"明天\\""}')])}],
    [300, {type: 'message', message: nested('r1', 'tool_call_n1', 'call_00_a', 150, 250, true, {ok: false, code: 'CONFIG_INVALID', error: 'bad config'})}],
    [350, {type: 'message', message: toolResult('call_00_a', 'tool_call', true, failedResult, {status: 'error', tool: 'openclaw:kurumi-tasks:reminder_create', error: 'bad config'})}],
    [400, {type: 'message', message: assistant('r1', [wrapped('call_01_b', 'reminder_create', {text: '开会'})])}],
    [500, {type: 'message', message: nested('r1', 'tool_call_n2', 'call_01_b', 420, 480, false, {ok: true, reminderId: 'rem-1'})}],
    [550, {type: 'message', message: toolResult('call_01_b', 'tool_call', false, JSON.stringify({tool: 'reminder_create', result: {details: {ok: true, reminderId: 'rem-1'}}}), {tool: 'reminder_create'})}, 'zstd'],
    [600, {type: 'message', message: assistant('r1', [{type: 'text', text: '好的，已经记下了'}])}],
    [1000, {type: 'reset', reason: 'new'}],
    [2000, {type: 'message', message: user('给朋友发邮件')}],
    [2100, {type: 'message', message: assistant('r2', [{type: 'toolCall', id: 'call_02_c', name: 'email_send', arguments: {to: 'friend@example.invalid'}}])}],
    [2200, {type: 'message', message: toolResult('call_02_c', 'email_send', true, 'blocked', {status: 'blocked', tool: 'email_send'})}],
    [2300, {type: 'message', message: assistant('r2', [{type: 'text', text: '这个我不能发'}])}],
  ];
  const insert = db.prepare('INSERT INTO transcript_events VALUES (?, ?, ?, ?, ?)');
  records.forEach(([offset, record, encoding], seq) => {
    const json = JSON.stringify({...record, timestamp: T0 + offset});
    insert.run(SESSION, seq, encoding === 'zstd' ? null : json, encoding === 'zstd' ? zstdCompressSync(Buffer.from(json)) : null, T0 + offset);
  });
  db.close();
  const access = (offset, tool, decision, code, correlation) => JSON.stringify({at: iso(offset), source: 'access-control', kind: 'access.tool',
    correlation: {sessionKey: KEY, ...correlation}, data: {tool, permission: 'test.permission', decision, ...(code ? {code} : {})}});
  fs.writeFileSync(path.join(root, 'channel', 'access-events.jsonl'), [
    access(120, 'tool_call', 'allow', undefined, {runId: 'r1', toolCallId: 'call_00_a'}),
    // The real tool's decision carries the nested ID only; pairing and closure go through parentToolCallId.
    access(160, 'reminder_create', 'allow', undefined, {toolCallId: 'tool_call_n1'}),
    access(2150, 'email_send', 'deny', 'untrusted_identity_context', {runId: 'r2', toolCallId: 'call_02_c'}),
  ].join('\n') + '\n');
  const runtime = (offset, level, message, subsystem = '{"subsystem":"gateway"}') => JSON.stringify({'0': subsystem, '1': message, time: iso(offset), _meta: {logLevelName: level}});
  fs.writeFileSync(path.join(root, 'runtime.log'), [
    runtime(50, 'INFO', 'gateway heartbeat'),
    runtime(2250, 'WARN', 'gateway slow reply'),
    // Native lines sometimes carry message text in the subsystem slot.
    runtime(2260, 'WARN', 'detail', '[tools] tool_call failed: 合成的私密文本'),
  ].join('\n') + '\n');
  return root;
}

const range = {from: T0 - 1000, to: T0 + 10_000};
const sources = ['openclaw-session', 'access-control', 'openclaw-runtime'];
const load = (root, expand = false) => collectEvents({...range, runtimeRoot: root, snowlumaRoot: path.join(root, 'none'), sources, expand});

function withRoot(fn) {
  const root = buildRuntimeRoot();
  try { fn(root); } finally { fs.rmSync(root, {recursive: true, force: true}); }
}

test('transcript adapter names the real tool behind tool_call and binds inbound to its run', () => withRoot((root) => {
  const events = load(root);
  const calls = events.filter((item) => item.kind === 'agent.tool_call');
  assert.deepEqual(calls.map((item) => [item.data.tool, item.data.declaredTool, item.correlation.toolCallId]), [
    ['reminder_create', 'tool_call', 'call_00_a'], ['reminder_create', 'tool_call', 'call_01_b'], ['email_send', 'email_send', 'call_02_c']]);
  const results = events.filter((item) => item.kind === 'agent.tool_result');
  assert.equal(results.length, 3, 'zstd-encoded result row is decoded');
  assert.equal(results[0].data.summary.code, 'CONFIG_INVALID');
  assert.deepEqual(events.filter((item) => item.kind === 'agent.inbound').map((item) => item.correlation.runId), ['r1', 'r2']);
  const nestedRows = events.filter((item) => item.kind === 'agent.tool_nested');
  assert.deepEqual(nestedRows.map((item) => [item.correlation.parentToolCallId, item.data.durationMs]), [['call_00_a', 100], ['call_01_b', 60]]);
  assert.equal(events.filter((item) => item.kind === 'session.reset').length, 1);
}));

test('view filters hide raw native lines by default and match kinds by prefix', () => withRoot((root) => {
  const events = load(root);
  assert.ok(matchesKind('agent.tool_result', ['agent.tool_']));
  assert.ok(matchesKind('agent.tool_result', ['agent.*']));
  assert.equal(applyViewFilters(events).filter((item) => item.kind === 'openclaw.log').length, 0);
  assert.equal(applyViewFilters(events, {raw: true}).filter((item) => item.kind === 'openclaw.log').length, 3);
  assert.equal(applyViewFilters(events, {kinds: ['openclaw.log']}).length, 3, 'an explicit --kind shows raw lines');
  assert.ok(applyViewFilters(events, {kinds: ['agent.tool_']}).every((item) => item.kind.startsWith('agent.tool_')));
  assert.ok(!applyViewFilters(events, {excludeKinds: ['access.']}).some((item) => item.kind === 'access.tool'));
  assert.ok(!applyViewFilters(events, {excludeSources: ['access-control']}).some((item) => item.source === 'access-control'));

  const rendered = renderQuery(events, range);
  for (const key of ['schemaVersion', 'from', 'to', 'total', 'shown', 'events']) assert.ok(key in rendered.json, `JSON keeps ${key}`);
  assert.equal(rendered.json.schemaVersion, 1);
  assert.equal(rendered.json.hiddenRaw, 3);
  assert.match(rendered.lines[0], /已隐藏原生日志 3 行/u);
  assert.equal(renderQuery(events, {...range, raw: true}).json.hiddenRaw, 0);
}));

test('call pairing merges wrapper, real tool, access and result into one row', () => withRoot((root) => {
  const events = load(root);
  const calls = pairCalls(events);
  assert.deepEqual(calls.map((call) => [call.toolCallId, call.tool, call.declaredTool, call.outcome, call.errorCode, call.durationMs]), [
    ['call_00_a', 'reminder_create', 'tool_call', 'error', 'CONFIG_INVALID', 100],
    ['call_01_b', 'reminder_create', 'tool_call', 'ok', undefined, 60],
    ['call_02_c', 'email_send', 'email_send', 'deny', 'untrusted_identity_context', 100],
  ]);
  assert.deepEqual(calls[0].access.map((item) => item.tool), ['tool_call', 'reminder_create'], 'outer and nested access IDs land on the same call');
  assert.deepEqual(calls[0].nestedToolCallIds, ['tool_call_n1']);
  const lines = renderQuery(events, range).lines;
  assert.equal(lines.filter((line) => line.includes('[tool.call]')).length, 3);
  assert.ok(lines.some((line) => line.includes('[tool.call] reminder_create（经 tool_call） 失败 CONFIG_INVALID 100ms 访问=tool_call:allow,reminder_create:allow')));
  assert.ok(lines.some((line) => line.includes('email_send 拒绝 untrusted_identity_context')));
  assert.ok(!lines.some((line) => /\[(agent\.tool_|access\.tool)/u.test(line)), 'member rows are folded into [tool.call]');
  assert.equal(renderQuery(events, range).json.calls.length, 3);
}));

test('turn view groups by run and shows /new as a segment marker', () => withRoot((root) => {
  const events = applyViewFilters(load(root));
  const grouped = groupTurns(events);
  assert.equal(grouped.turns.length, 2);
  assert.deepEqual(grouped.timeline.map((item) => item.kind), ['turn', 'session.reset', 'turn']);
  assert.deepEqual(grouped.turns.map((turn) => [turn.runId, turn.calls.length, turn.replies.length, turn.errors, turn.denied]), [['r1', 2, 1, 1, 0], ['r2', 1, 1, 0, 1]]);
  const rendered = renderQuery(load(root), {...range, turns: true});
  assert.equal(rendered.json.view, 'turns');
  const text = rendered.lines.join('\n');
  assert.match(text, /\/new 新会话（new）/u);
  assert.match(text, /用户：提醒我明天开会\n {2}工具：reminder_create（经 tool_call） 失败 CONFIG_INVALID 100ms\n {2}工具：reminder_create（经 tool_call） 成功 60ms\n {2}回复：好的，已经记下了/u);
}));

test('error view counts by code and keeps native WARN lines', () => withRoot((root) => {
  const events = load(root);
  const found = collectErrors(applyViewFilters(events, {raw: true}));
  assert.deepEqual(found.counts, {CONFIG_INVALID: 1, untrusted_identity_context: 1, 'gateway:WARN': 1, 'tools:WARN': 1});
  assert.ok(!Object.keys(found.counts).some((code) => code.includes('私密')), 'codes never carry log text');
  const rendered = renderQuery(events, {...range, errors: true});
  assert.equal(rendered.json.view, 'errors');
  assert.deepEqual(rendered.json.counts, found.counts);
  assert.match(rendered.lines[1], /^按错误码：/u);
}));

test('audit flags denied tools and consecutive retries per turn', () => withRoot((root) => {
  const rows = auditTurns(groupTurns(applyViewFilters(load(root))).turns);
  assert.deepEqual(rows[0].retries, [{tool: 'reminder_create', attempts: 2, failures: 1, finalOutcome: 'ok'}]);
  assert.deepEqual(rows[1].denied.map((item) => [item.tool, item.code]), [['email_send', 'untrusted_identity_context']]);
  assert.ok(rows.every((row) => row.flagged));
  const rendered = renderQuery(load(root), {...range, audit: true});
  assert.equal(rendered.json.view, 'audit');
  assert.equal(rendered.json.flagged, 2);
  assert.ok(rendered.lines.some((line) => line.includes('重试 reminder_create×2（失败 1，最终成功）')));
}));

test('expand decodes layered JSON only when asked', () => withRoot((root) => {
  assert.deepEqual(deepParseJson('"{\\"a\\":\\"[1,2]\\"}"'), {a: [1, 2]});
  assert.equal(deepParseJson('not json'), 'not json');
  const plain = load(root).find((item) => item.kind === 'agent.tool_call');
  assert.equal(plain.data.expanded, undefined);
  const expanded = load(root, true);
  const call = expanded.find((item) => item.kind === 'agent.tool_call');
  assert.deepEqual(call.data.expanded.arguments.args, {text: '开会', when: '明天'});
  const result = expanded.find((item) => item.kind === 'agent.tool_result');
  assert.equal(result.data.expanded.content.result.details.code, 'CONFIG_INVALID');
  const lines = renderQuery(expanded, {...range, expand: true}).lines;
  assert.ok(lines.some((line) => line.trim() === 'agent.tool_call:'));
}));

test('run filter follows toolCallId closure to nested access rows without crossing runs', () => withRoot((root) => {
  const selected = filterEvents(load(root), {runId: 'r1'});
  assert.ok(selected.some((item) => item.kind === 'access.tool' && item.correlation.toolCallId === 'tool_call_n1'));
  assert.ok(!selected.some((item) => item.correlation.runId === 'r2' || item.correlation.toolCallId === 'call_02_c'));
}));
