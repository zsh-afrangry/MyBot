import assert from 'node:assert/strict';
import {test} from 'node:test';
import {summarizeEvents, verdict} from '../../scripts/acceptance-live-dialogue.mjs';

const sources = [{source: 'openclaw-session', status: 'available'}, {source: 'access-control', status: 'available'}];
const turn = {status: 'ok', replyChars: 20};
const events = [
  {source: 'openclaw-session', kind: 'agent.inbound'},
  {source: 'openclaw-session', kind: 'agent.tool_call', tool: 'kurumi_code'},
  {source: 'openclaw-session', kind: 'agent.reply'},
];

test('a polite reply does not turn a denied business action into a successful acceptance', () => {
  assert.deepEqual(verdict({turns: [turn], sources, events: [...events,
    {source: 'access-control', decision: 'deny', code: 'untrusted_identity_context'}], expectTool: 'kurumi_code'}),
  {status: 'blocked', reason: 'tool_authorization_denied'});
});

test('each turn requires recorded inbound and reply and expected actions must be observed', () => {
  assert.deepEqual(verdict({turns: [turn, turn], sources, events}), {status: 'blocked', reason: 'log_evidence_unavailable'});
  assert.deepEqual(verdict({turns: [turn], sources, events, expectTool: 'personal_confirmation'}),
    {status: 'failed', reason: 'expected_tool_not_observed'});
  assert.deepEqual(verdict({turns: [turn], sources, events, expectTool: 'kurumi_code', expectReplyMatched: false}),
    {status: 'failed', reason: 'expected_reply_not_observed'});
  assert.deepEqual(verdict({turns: [turn], sources, events, expectTool: 'kurumi_code'}),
    {status: 'unverified', reason: 'business_result_requires_domain_assertion'});
  assert.deepEqual(verdict({turns: [turn], sources, events}), {status: 'passed', scope: 'dialogue_only'});
});

test('technical evidence excludes message contents and arbitrary event data', () => {
  assert.deepEqual(summarizeEvents([{source: 'access-control', kind: 'access.tool',
    data: {tool: 'kurumi_code', decision: 'deny', code: 'untrusted_identity_context', text: 'private content'}}]),
  [{source: 'access-control', kind: 'access.tool', tool: 'kurumi_code', decision: 'deny', code: 'untrusted_identity_context'}]);
});
