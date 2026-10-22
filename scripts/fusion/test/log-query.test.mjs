import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  attachRuntimeCorrelation,
  attachTurnCorrelation,
  collectEvents,
  filterEvents,
  parseQueryInstant,
  parseReceiptLine,
  parseRuntimeLine,
  parseSnowLumaLine,
} from '../log-query.mjs';
import {createTraceSink, normalizeTraceEvent, redactValue} from '../../../chatbot/packages/observability/index.js';

const file = '/tmp/snowluma-test/snowluma-2026-10-11.log';

test('SnowLuma adapter normalizes QQ ingress and reply target', () => {
  const inbound = parseSnowLumaLine('01:12:35 OK    [1794511189] [Event] 私聊 [L.Y.(365999865)]: ID:-1908656766 1分钟之后提醒我做测试', file, 23);
  assert.equal(inbound.kind, 'qq.inbound');
  assert.equal(inbound.correlation.qqMessageId, '-1908656766');
  assert.equal(inbound.correlation.senderId, '365999865');
  assert.equal(inbound.data.text, '1分钟之后提醒我做测试');

  const outbound = parseSnowLumaLine('01:12:42 INFO [OneBot] 私聊 365999865 | 发送：[回复:-1908656766] 提醒提案已生成', file, 25);
  assert.equal(outbound.kind, 'qq.outbound');
  assert.equal(outbound.correlation.replyToId, '-1908656766');
  assert.equal(outbound.correlation.recipientId, '365999865');
});

test('runtime adapter recognizes structured plugin and cron records without secrets', () => {
  const confirmation = JSON.stringify({
    '0': '{"subsystem":"plugins"}',
    '1': '{"component":"personal-confirmation","outcome":"recorded","backend":"personal-reminder"}',
    time: '2026-10-11T01:12:58.068+08:00',
  });
  const parsed = parseRuntimeLine(confirmation, '/tmp/runtime.log', 1);
  assert.equal(parsed.kind, 'confirmation.recorded');
  assert.equal(parsed.data.message.component, 'personal-confirmation');

  const cron = parseRuntimeLine(JSON.stringify({
    '0': '{"module":"cron"}',
    '1': {jobId: 'job-1', declarationKey: 'event-1'},
    '2': 'cron: job added',
    time: '2026-10-11T01:13:00.352+08:00',
  }), '/tmp/runtime.log', 2);
  assert.equal(cron.kind, 'cron.job_added');
  assert.equal(cron.correlation.cronJobId, 'job-1');
  assert.equal(cron.correlation.eventKey, 'event-1');
});

test('time-window correlation binds matching message text and never steals a nearby turn', () => {
  const make = (kind, at, text, id) => normalizeTraceEvent({at, source: kind.startsWith('qq') ? 'snowluma' : 'openclaw-session', kind, correlation: {sessionKey: 'agent:main:kurumi-qq:direct:1', ...(id ? {qqMessageId: id} : {})}, data: {text}});
  const events = [
    make('qq.inbound', 1_000_000_000_000, '第一条', 'm1'),
    make('agent.inbound', 1_000_000_000_100, '第一条'),
    make('agent.reply', 1_000_000_000_200, '回复一'),
    make('qq.inbound', 1_000_000_005_000, '第二条', 'm2'),
    make('agent.inbound', 1_000_000_005_100, '第二条'),
    make('agent.reply', 1_000_000_005_200, '回复二'),
  ];
  attachTurnCorrelation(events);
  assert.equal(events[1].correlation.qqMessageId, 'm1');
  assert.equal(events[2].correlation.qqMessageId, 'm1');
  assert.equal(events[4].correlation.qqMessageId, 'm2');
  assert.equal(events[5].correlation.qqMessageId, 'm2');
});

test('runtime time-window stops at 120s and at a nearer turn, so a daily Cron run absorbs nothing else', () => {
  const cron = 'agent:main:cron:12345678-1234-1234-1234-123456789abc';
  const direct = 'agent:main:kurumi-qq:direct:1';
  const day = 86_400_000;
  const t0 = 1_000_000_000_000;
  const turn = (at, sessionKey) => normalizeTraceEvent({at, source: 'openclaw-session', kind: 'agent.inbound', correlation: {sessionKey}, data: {}});
  const line = (at, correlation = {}) => normalizeTraceEvent({at, source: 'openclaw-runtime', kind: 'openclaw.log', correlation, data: {}});
  const events = [
    turn(t0, cron), line(t0 + 5_000), line(t0 + 3_600_000, {cronJobId: 'other-job'}),
    turn(t0 + 7_200_000, direct), line(t0 + 7_210_000), turn(t0 + 7_220_000, cron), line(t0 + 7_225_000),
    turn(t0 + day, cron),
  ];
  attachRuntimeCorrelation(events);
  assert.equal(events[1].correlation.sessionKey, cron);
  assert.equal(events[1].data.correlationQuality, 'time-window');
  assert.equal(events[2].correlation.sessionKey, undefined);
  assert.equal(events[4].correlation.sessionKey, direct);
  assert.equal(events[6].correlation.sessionKey, cron);
  const selected = filterEvents(events, {sessionKey: cron});
  assert(!selected.includes(events[2]) && !selected.includes(events[3]) && !selected.includes(events[4]));
});

test('collectEvents handles a source larger than the spread-argument limit', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'log-query-large-'));
  try {
    const at = Date.parse('2026-10-11T00:00:00+08:00');
    const rows = 160_000;
    const line = (i) => JSON.stringify({'0': '{"module":"cron"}', '1': {jobId: `job-${i}`}, '2': 'cron: job added', time: new Date(at + i).toISOString()});
    fs.writeFileSync(path.join(root, 'runtime.log'), Array.from({length: rows}, (_, i) => line(i)).join('\n') + '\n');
    const events = collectEvents({from: at - 1, to: at + rows, runtimeRoot: root, snowlumaRoot: path.join(root, 'none'), sources: ['openclaw-runtime']});
    assert.equal(events.length, rows);
  } finally { fs.rmSync(root, {recursive: true, force: true}); }
});

test('message filtering follows proposal and reminder correlation closure', () => {
  const make = (kind, correlation) => normalizeTraceEvent({source: 'test', kind, correlation, data: {}});
  const proposal = make('reminder.proposal_state', {proposalId: 'p1', reminderId: 'r1'});
  const committed = make('reminder.committed', {proposalId: 'p1', reminderId: 'r1'});
  const delivered = make('reminder.delivered', {reminderId: 'r1'});
  const unrelated = make('reminder.delivered', {reminderId: 'r2'});
  assert.deepEqual(filterEvents([proposal, committed, delivered, unrelated], {proposalId: 'p1'}), [proposal, committed, delivered]);
});

test('trace sink redacts secret-shaped fields and is private', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'trace-query-'));
  const target = path.join(dir, 'trace-events.jsonl');
  try {
    const sink = createTraceSink(target);
    sink.emit({source: 'test', kind: 'test.event', data: {token: 'do-not-write', text: 'Bearer abc'}});
    const saved = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.equal(saved.data.token, '[REDACTED]');
    assert.equal(saved.data.text, 'Bearer [REDACTED]');
    assert.equal(fs.statSync(target).mode & 0o077, 0);
    assert.equal(redactValue({apiKey: 'hidden'}).apiKey, '[REDACTED]');
  } finally { fs.rmSync(dir, {recursive: true, force: true}); }
});

test('time parser treats zone-less timestamps as Asia/Shanghai', () => {
  assert.equal(parseQueryInstant('2026-10-11T01:12:23', 0), Date.parse('2026-10-10T17:12:23Z'));
});

test('receipt adapter keeps receipt metadata small', () => {
  const row = parseReceiptLine(JSON.stringify({at: 1791652380000, action: 'create', id: 'r1', result: {secret: 'omit', status: 'ok'}}), '/tmp/reminder-receipts.jsonl', 4);
  assert.equal(row.kind, 'reminder.receipt');
  assert.equal(row.data.action, 'create');
  assert.deepEqual(row.data.resultKeys, ['secret', 'status']);
});
