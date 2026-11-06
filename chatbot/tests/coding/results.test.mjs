// Offline result-loop regression: injected ACP, actual private SQLite/Git/checks; no model, QQ or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {fixture, member} from './fixtures.mjs';
import {CodingService} from '../../plugins/kurumi-coding/service.js';
import {git, runChecks} from '../../plugins/kurumi-coding/workspaces.js';
import {digest} from '../../plugins/kurumi-coding/policy.js';

const start = f => f.run({action: 'start', projectId: 'fixture', task: 'Run the requested synthetic experiment.'});
const update = (peer, value, sessionId = peer.sessionId) => peer.emit('notification', {method: 'session/update', params: {sessionId, update: value}});
function execution(peer, text, id = 'actual-exec') {
  update(peer, {sessionUpdate: 'tool_call', toolCallId: id, kind: 'other', title: 'bash', status: 'in_progress', rawInput: {command: 'private raw command must not be copied'}});
  update(peer, {sessionUpdate: 'tool_call_update', toolCallId: id, status: 'completed', content: [{type: 'content', content: {type: 'text', text}}]});
}
test('actual execution output is persisted separately from file reads, reasoning and the agent report; notification uses the same result', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => {
    update(peer, {sessionUpdate: 'tool_call', toolCallId: 'private-read', title: 'read_file', kind: 'read'});
    update(peer, {sessionUpdate: 'tool_call_update', toolCallId: 'private-read', status: 'completed', content: [{type: 'content', content: {type: 'text', text: 'unrelated-file-marker'}}]});
    update(peer, {sessionUpdate: 'agent_thought_chunk', content: {type: 'text', text: 'private-thought-marker'}});
    execution(peer, 'before: [3,1,2]\nafter: [1,2,3]\n4 assertions passed');
    update(peer, {sessionUpdate: 'agent_message_chunk', messageId: 'earlier', content: {type: 'text', text: 'earlier planning text'}});
    update(peer, {sessionUpdate: 'agent_message_chunk', messageId: 'final', content: {type: 'text', text: 'Agent summary only.'}});
    update(peer, {sessionUpdate: 'agent_message_chunk', messageId: 'foreign', content: {type: 'text', text: 'foreign-session-marker'}}, 'different-session');
  }});
  const task = await start(f), ready = await f.settle(task.id);
  const actual = (await f.run({action: 'result', taskId: task.id})).result;
  assert.equal(actual.state, 'ready'); assert.equal(actual.roundId, ready.executionRoundId); assert.equal(actual.hostChecks.ok, true);
  assert.equal(actual.executionTools.length, 1); assert.equal(actual.page.source, 'acp_execution_tool_results');
  assert.match(actual.page.text, /after: \[1,2,3\]/); assert.doesNotMatch(actual.page.text, /Agent summary/);
  const agent = (await f.run({action: 'result', taskId: task.id, section: 'agent_report'})).result;
  assert.equal(agent.page.text, 'Agent summary only.'); assert.equal(agent.page.source, 'agent_report_not_host_verification');
  const persisted = JSON.stringify(f.service.store.resultEvents(task.id, actual.roundId));
  for (const secret of ['unrelated-file-marker', 'private-thought-marker', 'foreign-session-marker', 'private raw command', 'rawInput']) assert.equal(persisted.includes(secret), false);
  assert.match(f.deliveries[0].text, /after: \[1,2,3\]/);
  const recorded = f.service.store.result(task.id, actual.roundId).notification;
  assert.equal(recorded.text, f.deliveries[0].text); assert.equal(recorded.bodyHash, digest(recorded.text));
  assert.equal(ready.delivery.bodyHash, recorded.bodyHash); assert.equal(fs.statSync(f.service.store.file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(f.events).includes('assertions passed'), false);
});

test('redaction precedes paging and handles credentials split across agent chunks', async t => {
  const secret = 'sk-syntheticcredential0123456789';
  const f = await fixture(t, {behavior: async ({peer}) => {
    execution(peer, `kept\nAPI_KEY = arbitrary-private-value\nAuthorization: Bearer ${secret}\n-----BEGIN PRIVATE KEY-----\nprivate-key-material\n-----END PRIVATE KEY-----\n${'output🙂'.repeat(900)}`);
    for (const text of ['Report ', secret.slice(0, 5), secret.slice(5)]) update(peer, {sessionUpdate: 'agent_message_chunk', messageId: 'final', content: {type: 'text', text}});
  }});
  const task = await start(f); await f.settle(task.id);
  let offset = 0, text = '', pages = 0, roundId;
  do {
    const result = (await f.run({action: 'result', taskId: task.id, roundId, offset, limit: 137})).result;
    roundId = result.roundId; text += result.page.text; offset = result.page.nextOffset; pages++;
  } while (offset !== null);
  assert.ok(pages > 2); assert.match(text, /output🙂/); assert.match(text, /REDACTED/);
  const agent = (await f.run({action: 'result', taskId: task.id, section: 'agent_report'})).result.page.text;
  for (const value of [text, agent, f.deliveries[0].text]) for (const marker of [secret, 'arbitrary-private-value', 'private-key-material']) assert.equal(value.includes(marker), false);
  assert.equal(agent, 'Report [REDACTED]');
});

test('continuation records a new round even without code changes, and old output survives restart without running or sending again', async t => {
  const f = await fixture(t, {behavior: async ({peer, turn}) => execution(peer, `actual turn ${turn}`)});
  const task = await start(f), first = await f.settle(task.id);
  await f.run({action: 'continue', taskId: task.id, task: 'Repeat the observation without editing code.'});
  const second = await f.settle(task.id);
  assert.equal(first.verifiedCommit, second.verifiedCommit); assert.notEqual(first.executionRoundId, second.executionRoundId);
  assert.equal(f.deliveries.length, 2); assert.notEqual(f.deliveries[0].key, f.deliveries[1].key);
  const old = await f.run({action: 'result', taskId: task.id, roundId: first.executionRoundId});
  assert.equal(old.result.currentRound, false); assert.match(old.result.page.text, /actual turn 1/);
  assert.match((await f.run({action: 'result', taskId: task.id})).result.page.text, /actual turn 2/);
  await f.service.notify(f.service.store.get(task.id)); assert.equal(f.deliveries.length, 2);
  const stale = {...f.service.store.get(task.id), executionRoundId: first.executionRoundId};
  await f.service.notify(stale); assert.equal(f.deliveries.length, 2);
  const requester = f.service.store.get(task.id).requester;
  await f.service.stop();
  const restarted = new CodingService(f.pluginConfig, {authorize() {}, clientFactory() {throw Error('must not launch');}, sendText() {throw Error('must not resend');}});
  restarted.start(); t.after(() => restarted.stop());
  assert.equal(restarted.result(task.id, requester, {roundId: first.executionRoundId}).result.page.text, old.result.page.text);
  assert.equal(restarted.active.size, 0);
});

test('unknown delivery is retained once; status/result reads cannot restart coding or retry a send', async t => {
  const f = await fixture(t, {delivery: async () => {throw Object.assign(Error('uncertain send'), {code: 'transport_unknown'});}, behavior: async ({peer}) => execution(peer, 'actual completed output')});
  const task = await start(f), ready = await f.settle(task.id);
  assert.equal(ready.state, 'ready'); assert.equal(ready.delivery.state, 'unknown');
  for (let i = 0; i < 3; i++) {
    await f.run({action: 'result', taskId: task.id}); await f.service.notify(f.service.store.get(task.id));
  }
  assert.equal(f.calls.filter(call => call.method === 'prompt').length, 1); assert.equal(f.deliveries.length, 1);
});

test('revoked result-read permission blocks completion content before any delivery', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => {
    execution(peer, 'must remain private after revocation');
    f.config.channels['kurumi-qq'].accessControl.subjects[0].permissions['tasks.read'] = false;
  }});
  const task = await start(f); await f.service.idle(task.id);
  const current = f.service.store.get(task.id);
  assert.equal(current.state, 'ready'); assert.equal(current.delivery.state, 'unknown'); assert.equal(f.deliveries.length, 0);
  await assert.rejects(f.run({action: 'result', taskId: task.id}), /capability_not_allowed/);
  assert.equal(f.calls.filter(call => call.method === 'prompt').length, 1);
});

test('results enforce owner, original session, task/round binding and bounded page parameters', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => execution(peer, 'owner result')});
  const a = await start(f), b = await start(f); const [first, other] = await Promise.all([f.settle(a.id), f.settle(b.id)]);
  for (const ctx of [{...f.context, requesterSenderId: member, senderIsOwner: false}, {...f.context, sessionKey: 'agent:main:cron:synthetic'}]) await assert.rejects(f.run({action: 'result', taskId: a.id}, ctx));
  assert.throws(() => f.service.result(a.id, {subjectId: member, sessionKey: f.context.sessionKey}), /unknown_coding_task/);
  await assert.rejects(f.run({action: 'result', taskId: a.id, roundId: other.executionRoundId}), /unknown_coding_result_round/);
  for (const args of [{offset: -1}, {offset: 1e9}, {limit: 12001}, {limit: 0}, {section: 'credentials'}, {roundId: '../../private'}]) await assert.rejects(f.run({action: 'result', taskId: a.id, ...args}));
  f.config.channels['kurumi-qq'].accessControl.subjects[0].permissions['tasks.read'] = false;
  await assert.rejects(f.run({action: 'result', taskId: a.id, roundId: first.executionRoundId}), /capability_not_allowed/);
});

test('failed execution preserves observed output without claiming that host checks passed', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => {execution(peer, 'partial actual output'); throw Object.assign(Error('backend failed'), {code: 'synthetic_backend_failed'});}});
  const task = await start(f), failed = await f.settle(task.id), result = (await f.run({action: 'result', taskId: task.id})).result;
  assert.equal(failed.state, 'failed'); assert.equal(result.state, 'failed'); assert.equal(result.reason, 'synthetic_backend_failed');
  assert.equal(result.hostChecks, undefined); assert.match(result.page.text, /partial actual output/);
});

test('interrupted result rounds require reconciliation after restart; legacy tasks explicitly lack recorded output', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => execution(peer, 'retained observation')});
  const task = await start(f); await f.settle(task.id);
  const raw = f.service.store.get(task.id), round = f.service.store.result(task.id, raw.executionRoundId);
  f.service.store.save({...raw, state: 'running'});
  f.service.store.saveResult(task.id, {...round, state: 'running', finishedAt: undefined});
  await f.service.stop();
  const restarted = new CodingService(f.pluginConfig, {authorize() {}, clientFactory() {throw Error('must not launch');}});
  restarted.start(); t.after(() => restarted.stop());
  const recovered = restarted.result(task.id, raw.requester).result;
  assert.equal(recovered.state, 'needs_reconciliation'); assert.equal(recovered.finishedAt, undefined); assert.ok(recovered.interruptedAt);
  assert.match(recovered.page.text, /retained observation/);
  restarted.store.save({...restarted.store.get(task.id), executionRoundId: undefined});
  assert.equal(restarted.result(task.id, raw.requester).result.reason, 'result_not_recorded');
});

const pythonCheck = fileURLToPath(new URL('../../scripts/check-coding-pilot-python.py', import.meta.url));
const goodPython = `def quicksort(values):
    def sort(low, high):
        if low >= high:
            return
        pivot = values[low]
        left, right = low + 1, high
        while left <= right:
            if values[left] < pivot:
                left += 1
            else:
                values[left], values[right] = values[right], values[left]
                right -= 1
        values[low], values[right] = values[right], values[low]
        sort(low, right - 1)
        sort(right + 1, high)
    sort(0, len(values) - 1)
    return values
`;
const pythonFixture = (t, behavior) => fixture(t, {behavior, configure(config) {
  config.projects[0].checks.push({name: 'independent python quicksort', argv: ['/usr/bin/python3', '-B', pythonCheck], skipExitCode: 77, timeoutMs: 5000});
}});

test('independent host Python checks fail incorrect sorting before commit; a corrected continuation passes without pycache writes', async t => {
  const f = await pythonFixture(t, async ({cwd, turn}) => fs.writeFileSync(path.join(cwd, 'quicksort_first_pivot.py'), turn === 1 ? 'def quicksort(values):\n    return values\n' : goodPython));
  const task = await start(f), bad = await f.settle(task.id);
  assert.equal(bad.state, 'check_failed'); assert.equal(bad.verifiedCommit, f.baseline); assert.equal(bad.checks.rows.at(-1).code, 1);
  await f.run({action: 'continue', taskId: task.id, task: 'Correct sorting and retain the original interface.'});
  const good = await f.settle(task.id); assert.equal(good.state, 'ready'); assert.equal(good.checks.rows.at(-1).code, 0);
  assert.equal(fs.existsSync(path.join(task.cwd, '__pycache__')), false); assert.notEqual(good.verifiedCommit, f.baseline);
  assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline);
});

test('an absent optional Python artifact is explicitly skipped, while deletion of a tracked artifact fails', async t => {
  const f = await pythonFixture(t, async ({cwd, turn}) => {
    if (turn === 2) fs.writeFileSync(path.join(cwd, 'quicksort_first_pivot.py'), goodPython);
    if (turn === 3) fs.unlinkSync(path.join(cwd, 'quicksort_first_pivot.py'));
  });
  const task = await start(f), absent = await f.settle(task.id);
  assert.equal(absent.state, 'ready'); assert.equal(absent.checks.rows.at(-1).skipped, true); assert.match(f.deliveries[0].text, /independent python quicksort=不适用/);
  await f.run({action: 'continue', taskId: task.id, task: 'Add Python sorting.'}); assert.equal((await f.settle(task.id)).state, 'ready');
  await f.run({action: 'continue', taskId: task.id, task: 'Remove the tracked artifact.'}); assert.equal((await f.settle(task.id)).state, 'check_failed');
});

test('the Python host check rejects a symlink artifact instead of importing an outside implementation', async t => {
  const f = await pythonFixture(t, async ({cwd}) => {
    const outside = path.join(f.root, 'outside.py'); fs.writeFileSync(outside, goodPython);
    fs.symlinkSync(outside, path.join(cwd, 'quicksort_first_pivot.py'));
  });
  const task = await start(f), result = await f.settle(task.id);
  assert.equal(result.state, 'check_failed'); assert.equal(result.verifiedCommit, f.baseline);
});

test('a skip code requires explicit registration and entirely skipped checks never verify a task', async t => {
  const f = await fixture(t), check = {name: 'conditional fixture', argv: [process.execPath, '-e', 'process.exit(77)']};
  const absent = await runChecks({checks: [check]}, f.source, path.join(f.root, 'unregistered-skip.log'), undefined, f.pluginConfig.writeBoundary);
  assert.equal(absent.ok, false); assert.equal(absent.rows[0].skipped, undefined);
  const skipped = await runChecks({checks: [{...check, skipExitCode: 77}]}, f.source, path.join(f.root, 'all-skipped.log'), undefined, f.pluginConfig.writeBoundary);
  assert.equal(skipped.ok, false); assert.equal(skipped.rows[0].skipped, true);
});
