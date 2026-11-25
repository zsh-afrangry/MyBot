import assert from 'node:assert/strict';
import {test} from 'node:test';
import {evaluateCodingCatalog, evaluateCodingTask, summarizeEvents, verdict, verifyCodingEvidence} from '../../scripts/acceptance-live-dialogue.mjs';

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
  const [coding] = summarizeEvents([{source: 'coding', kind: 'coding.ready', correlation: {taskId: 'task'},
    data: {backend: 'opencode', projectId: 'kurumi-fusion', verifiedCommit: 'commit', text: 'private content'}}]);
  assert.equal(coding.backend, 'opencode');
  assert.equal(coding.verifiedCommit, 'commit');
  assert.equal(JSON.stringify(coding).includes('private content'), false);
});

test('coding catalog requires the requested backend and registered project', () => {
  const catalog = {status: 'ok', replyChars: 10, actions: [{
    action: 'list', status: 'ok', backends: ['dsh-acp', 'opencode'], projects: ['kurumi-fusion'],
  }]};
  assert.deepEqual(evaluateCodingCatalog(catalog, 'opencode'), {status: 'passed', scope: 'coding_catalog'});
  assert.deepEqual(evaluateCodingCatalog(catalog, 'missing'), {status: 'failed', reason: 'coding_catalog_not_verified'});
  assert.deepEqual(evaluateCodingCatalog({...catalog, actions: [{action: 'list', status: 'ok'}]}, 'opencode'),
    {status: 'blocked', reason: 'coding_catalog_evidence_missing'});
});

test('coding task requires matching backend, commit, checks, result and exact difference', () => {
  const input = {
    taskId: 'task', expectedBackend: 'opencode',
    task: {taskId: 'task', projectId: 'kurumi-fusion', backend: 'opencode', state: 'ready',
      active: false, base: 'base', verifiedCommit: 'commit', checksPassed: true, resultAvailable: true},
    result: {taskId: 'task', backend: 'opencode', roundId: 'round', verifiedCommit: 'commit', available: true, currentRound: true},
    diff: {taskId: 'task', base: 'base', verifiedCommit: 'commit', exact: true, paths: ['config/access-control.json']},
  };
  assert.deepEqual(evaluateCodingTask(input), {status: 'passed', scope: 'coding_task_evidence'});
  for (const altered of [
    {...input, task: {...input.task, backend: 'dsh-acp'}},
    {...input, result: {...input.result, verifiedCommit: 'other'}},
    {...input, diff: {...input.diff, exact: false}},
    {...input, diff: {...input.diff, paths: ['config/access-control.json', 'other']}},
    {...input, task: {...input.task, checksPassed: false}},
  ]) {
    assert.deepEqual(evaluateCodingTask(altered), {status: 'failed', reason: 'coding_task_result_not_verified'});
  }
  assert.deepEqual(evaluateCodingTask({...input, result: undefined}),
    {status: 'blocked', reason: 'coding_task_evidence_missing'});
});

test('coding acceptance requires the action trace and task lifecycle evidence', () => {
  const passed = {status: 'passed', scope: 'coding_protected_diff'};
  const report = {expectedBackend: 'opencode', leaseClosed: true, task: {taskId: 'task', verifiedCommit: 'commit'},
    turns: [{runId: 'run', actions: [{action: 'start', status: 'ok', taskId: 'task'}]}]};
  const lifecycle = ['coding.submitted', 'coding.checked', 'coding.ready'].map(kind => ({
    kind, taskId: 'task', backend: 'opencode', projectId: 'kurumi-fusion',
    ...(kind === 'coding.checked' && {ok: true}), ...(kind === 'coding.ready' && {verifiedCommit: 'commit'}),
  }));
  const trace = [{kind: 'coding.acceptance_action', runId: 'run', action: 'start', status: 'ok', taskId: 'task'},
    ...lifecycle, {kind: 'coding.delivery', taskId: 'task', status: 'local_available'}];
  assert.deepEqual(verifyCodingEvidence(passed, report, trace), passed);
  assert.deepEqual(verifyCodingEvidence(passed, report, trace.filter(row => row.kind !== 'coding.checked')),
    {status: 'blocked', reason: 'coding_evidence_incomplete'});
  assert.deepEqual(verifyCodingEvidence(passed, {...report, leaseClosed: false}, trace),
    {status: 'blocked', reason: 'coding_evidence_incomplete'});
});
