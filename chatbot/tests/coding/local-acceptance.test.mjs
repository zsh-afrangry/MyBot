import test from 'node:test';
import assert from 'node:assert/strict';
import {bindLocalCodingTurn, localCodingDecision} from '../../packages/host-control/local-coding.js';

test('local coding authority binds each detached model turn and expires with its lease', () => {
  const requester = {sessionKey: 'agent:kurumi-acceptance:coding:lease'};
  const sessionKey = `${requester.sessionKey}:turn:run`;
  let current = true;
  const turn = {requester, sessionKey, sessionId: 'session', current: () => current};
  const ctx = {agentId: 'kurumi-acceptance', sessionKey, sessionId: 'session', runId: 'run'};
  const action = {toolName: 'kurumi_code', params: {action: 'list'}};
  const unbind = bindLocalCodingTurn(ctx.runId, turn);
  try {
    assert.deepEqual(localCodingDecision(action, ctx), {scope: 'local-coding-acceptance'});
    for (const patch of [
      {sessionKey: requester.sessionKey}, {sessionKey: `${requester.sessionKey}:turn:other`},
      {sessionKey: undefined}, {sessionId: 'other'}, {runId: 'other'}, {agentId: 'main'},
    ]) assert.equal(localCodingDecision(action, {...ctx, ...patch}).blockReason, 'local_coding_turn_required');
    assert.equal(localCodingDecision({toolName: 'kurumi_code', params: {action: 'merge'}}, ctx).blockReason, 'local_coding_action_denied');
    current = false;
    assert.equal(localCodingDecision(action, ctx).blockReason, 'local_coding_turn_required');
  } finally {unbind();}
  assert.equal(localCodingDecision(action, ctx).blockReason, 'local_coding_turn_required');
});
