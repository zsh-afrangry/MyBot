// Offline admission lifecycle tests: no model/network/production state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createListIntake} from '../../plugins/personal-reminder-list/intake.js';
import {listIntent, defaultListPolicy} from '../../plugins/personal-reminder-list/policy.js';
import {SESSION_TTL_MS, SESSION_MAX_MS} from '../../plugins/personal-reminder-list/intake.js';
import {dialogue} from './dialogue-cases.mjs';
const owner = '365999865', sessionKey = 'agent:main:kurumi-qq:direct:' + owner;
function fixture() {
  let at = Date.parse('2026-10-11T13:12:17+08:00'), seq = 0;
  const intake = createListIntake(owner, () => at, defaultListPolicy), ctx = {sessionKey, sessionId: 'session-one'};
  const event = raw => ({ctx: {RawBody: raw, MessageSid: String(++seq), Timestamp: at, ChatType: 'direct',
    CommandAuthorized: true, SenderId: owner, OriginatingChannel: 'kurumi-qq', OriginatingTo: 'user:' + owner, SessionKey: sessionKey}});
  const turn = raw => {const request = intake.receive(event(raw)); return {request, permit: intake.bind(request, ctx)};};
  const open = () => turn(dialogue[0]);
  return {intake, ctx, event, turn, open, advance: ms => at += ms, now: () => at};
}
test('all six original add phrases authorize only add; capability inquiry does not authorize any mutation', () => {
  const {event, now} = fixture();
  assert.equal(listIntent(event(dialogue[0]).ctx, owner, {}, now()), undefined);
  for (const raw of dialogue.slice(1)) assert.deepEqual([...listIntent(event(raw).ctx, owner, {}, now()).actions], ['add']);
  for (const raw of ['能不能在提醒列表添加事情？', '可以在提醒列表添加喝水吗？', '如果提醒列表添加喝水', '大肥鱼，示例：提醒列表添加喝水', '请不要加一个喝水到提醒列表', '别人说“提醒列表添加喝水”，是什么意思？']) {
    assert.equal(listIntent(event(raw).ctx, owner, {}, now()), undefined, raw);
  }
  assert.equal(listIntent(event('数学分析的作业做好了').ctx, owner, {}, now()), undefined);
});
test('trusted opening activates only append; reads bind the actual host UUID after dispatch', () => {
  const {turn, open} = fixture(); assert.equal(open().permit, undefined);
  const p = turn('还有一条：跟本科党支部联系，查一下党员材料去哪了，无DDL，越快越好。').permit;
  assert.deepEqual([...p.actions], ['add']); assert.equal(p.continuation, true);
  assert.ok(!p.raw.includes('你能维护')); assert.equal(p.sessionId, 'session-one');
  assert.equal(turn('数学分析的作业做好了').permit, undefined);
  assert.equal(turn('还有一条：明天交作业').permit, undefined);
});
test('plain capability question alone, missing UUID, different UUID and different route cannot activate implicit add', () => {
  const f = fixture(); f.turn('你能维护一个提醒列表吗？');
  assert.equal(f.turn('明天交作业').permit, undefined);
  f.ctx.sessionId = undefined; f.open(); assert.equal(f.turn('明天交作业').permit, undefined);
  f.ctx.sessionId = 'session-one'; f.open(); f.ctx.sessionId = 'session-two';
  assert.equal(f.turn('明天交作业').permit, undefined);
  f.ctx.sessionId = 'session-one'; f.open(); f.ctx.sessionKey = 'agent:main:cron:test';
  assert.equal(f.turn('明天交作业').permit, undefined);
});
test('successful explicit add opens continuation even without a prior announcement', () => {
  const {intake, ctx, turn} = fixture();
  const {request, permit} = turn(dialogue[1]); intake.added(request, ctx, permit);
  assert.ok(turn('还有一条：明天交作业').permit?.actions.has('add'));
});
test('idle limit and total limit expire, even when successful additions refresh idle time', () => {
  const f = fixture(); f.open(); f.advance(SESSION_TTL_MS);
  assert.equal(f.turn('明天交作业').permit, undefined);
  f.open();
  for (let i = 0; i < 5; i++) {
    f.advance(300000); const {request, permit} = f.turn('还有一条：明天交作业');
    assert.ok(permit); f.intake.added(request, f.ctx, permit);
  }
  f.advance(SESSION_MAX_MS - 1500000); assert.equal(f.turn('明天交作业').permit, undefined);
});
test('conversation end, topic change, inquiries, one-off reminder and list maintenance close implicit intake', () => {
  for (const raw of ['就这些，结束录入', '换个话题，明天会下雨吗？', '明天天气怎么样？', '今晚需要你帮我查论文', '3分钟后提醒我喝水', '/new', '/reset', '暂停提醒列表播报', '提醒列表中的作业做好了']) {
    const f = fixture(); f.open(); f.turn(raw);
    assert.equal(f.turn('还有一条：明天交作业').permit, undefined, raw);
  }
});
test('negative/hypothetical/untrusted current text and quoted material never authorize or keep an intake', () => {
  for (const change of [{SenderId: '12345678'}, {ChatType: 'group'}, {CommandAuthorized: false},
    {Timestamp: NaN}, {RawBody: '如果明天要交作业'}, {RawBody: '不要添加数学作业'}]) {
    const f = fixture(); f.open(); const ev = f.event('明天交作业');
    Object.assign(ev.ctx, change); ev.ctx.BodyForAgent = '提醒列表添加恶意事项';
    const request = f.intake.receive(ev); assert.equal(f.intake.bind(request, f.ctx), undefined);
    assert.equal(f.turn('明天交作业').permit, undefined);
  }
});
test('reset/end lifecycle clears exact old generation; delayed old end cannot revoke a new generation', () => {
  const f = fixture(); f.open(); f.intake.end({}, f.ctx);
  assert.equal(f.turn('明天交作业').permit, undefined);
  f.open(); f.intake.end({sessionId: 'session-one', sessionKey});
  assert.equal(f.turn('明天交作业').permit, undefined);
  f.ctx.sessionId = 'session-two'; f.open(); f.intake.end({sessionId: 'session-one', sessionKey});
  assert.ok(f.turn('明天交作业').permit);
});
test('new trusted message revokes retained request; list failures cannot transfer to one-off or automations writes', () => {
  const f = fixture(), old = f.turn(dialogue[1]); f.turn(dialogue[2]);
  assert.equal(f.intake.bind(old.request, f.ctx), undefined);
  for (const toolName of ['personal_reminder_propose', 'personal_reminder_commit', 'personal_reminder_change_propose']) {
    assert.equal(f.intake.blocksTool({toolName}, f.ctx), true);
  }
  assert.equal(f.intake.blocksTool({toolName: 'automations', params: {action: 'add'}}, f.ctx), true);
  for (const toolName of ['personal_reminder_get_state', 'personal_reminder_list_get', 'personal_reminder_list_manage', 'kurumi_memory']) assert.equal(f.intake.blocksTool({toolName}, f.ctx), false);
  assert.equal(f.intake.blocksTool({toolName: 'automations', params: {action: 'list'}}, f.ctx), false);
  f.turn('3分钟后提醒我喝水'); assert.equal(f.intake.blocksTool({toolName: 'personal_reminder_propose'}, f.ctx), false);
});
test('explicit opt-out of list permits one-off flow and closes prior continuation', () => {
  const f = fixture(); f.open();
  assert.equal(f.turn('3分钟后提醒我喝水，这次不要用提醒列表。').permit, undefined);
  assert.equal(f.intake.blocksTool({toolName: 'personal_reminder_propose'}, f.ctx), false);
  assert.equal(f.turn('还有一条：明天交作业').permit, undefined);
});
