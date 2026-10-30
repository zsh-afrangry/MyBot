// Offline product-handler flow with real Git, SQLite and natural confirmation. No model or QQ calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, core, member} from './fixtures.mjs';
import {git, targetState, workingHash, runChecks} from '../../plugins/kurumi-coding/workspaces.js';
import {CodingService} from '../../plugins/kurumi-coding/service.js';
import {digest} from '../../plugins/kurumi-coding/policy.js';

const start = f => f.run({action: 'start', projectId: 'fixture', task: 'Change only value.mjs to the next verified integer.'});
test('actual tool isolates committed baseline, resumes the same session, confirms and merges without changing dirty source files', async t => {
  const f = await fixture(t);
  fs.writeFileSync(path.join(f.source, 'README.md'), 'staged unrelated progress\n'); git(f.source, 'add', 'README.md');
  fs.writeFileSync(path.join(f.source, 'notes.txt'), 'unstaged unrelated progress\n'); fs.writeFileSync(path.join(f.source, 'draft.txt'), 'private local draft\n');
  const before = targetState({root: f.source}), first = await start(f);
  assert.equal(fs.readFileSync(path.join(first.cwd, 'README.md'), 'utf8'), 'committed baseline\n');
  assert.equal(fs.existsSync(path.join(first.cwd, 'draft.txt')), false);
  const ready = await f.settle(first.id); assert.equal(ready.state, 'ready'); assert.equal(ready.checks.ok, true);
  assert.notEqual(ready.verifiedCommit, f.baseline); assert.deepEqual(targetState({root: f.source}), before);
  await f.run({action: 'continue', taskId: first.id, task: 'Continue to one more verified integer.'});
  const next = await f.settle(first.id); assert.equal(next.externalSessionId, ready.externalSessionId);
  assert.equal(f.calls.filter(c => c.method === 'resume').length, 1);
  assert.match((await f.run({action: 'diff', taskId: first.id})).diff, /value = 3/);
  const preview = await f.run({action: 'preview', taskId: first.id}); assert.equal(preview.status, 'pending');
  await assert.rejects(f.run({action: 'merge', taskId: first.id, proposalId: preview.proposalId}), /approval_required/);
  assert.deepEqual(targetState({root: f.source}), before);
  f.approve(preview);
  const merged = await f.run({action: 'merge', taskId: first.id, proposalId: preview.proposalId}); assert.equal(merged.state, 'merged');
  assert.match(fs.readFileSync(path.join(f.source, 'value.mjs'), 'utf8'), /value = 3/);
  const after = targetState({root: f.source}); assert.equal(after.status, before.status); assert.equal(after.diff, before.diff); assert.deepEqual(after.files, before.files);
  assert.equal(git(f.source, 'diff', '--cached', '--name-only').trim(), 'README.md');
  await assert.rejects(f.run({action: 'merge', taskId: first.id, proposalId: preview.proposalId}), /merge_not_pending/);
  assert.equal(f.events.find(e => e.kind === 'coding.submitted').correlation.runId, 'fixture-real-hook-run');
  assert.equal(JSON.stringify(f.events).includes('Change only'), false);
  assert.equal(next.delivery.state, 'platform_accepted');
});

test('untrusted identities, member permissions, unknown actions and task bindings never start ACP', async t => {
  const f = await fixture(t);
  for (const patch of [{requesterSenderId: member, senderIsOwner: false, agentId: 'qq-user-' + member, sessionKey: `agent:qq-user-${member}:kurumi-qq:direct:${member}`}, {senderIsOwner: false}, {messageChannel: 'webchat'}, {sessionKey: 'forged'}, {deliveryContext: {to: 'user:' + member}}]) {
    await assert.rejects(f.run({action: 'start', projectId: 'fixture', task: 'injection'}, {...f.context, ...patch}));
  }
  await assert.rejects(f.run({action: 'arbitrary_command'}), /unmapped_tool/); assert.equal(f.calls.length, 0);
  const first = await start(f); await f.settle(first.id);
  assert.throws(() => f.service.status(first.id, {subjectId: member, sessionKey: f.context.sessionKey}), /unknown_coding_task/);
  await assert.rejects(f.run({action: 'start', projectId: '/tmp/model-path', task: 'injection'}), /unknown_coding_project/);
});

test('start and continuation retries keep exactly one backend turn for the same trusted call', async t => {
  const f = await fixture(t), args = {action: 'start', projectId: 'fixture', task: 'unique fixture request'};
  const a = await f.run(args, f.context, 'same-start'), b = await f.run(args, f.context, 'same-start'); assert.equal(a.id, b.id);
  await f.settle(a.id);
  const more = {action: 'continue', taskId: a.id, task: 'one continuation'};
  await f.run(more, f.context, 'same-continuation'); await f.run(more, f.context, 'same-continuation'); await f.settle(a.id);
  assert.equal(f.calls.filter(c => c.method === 'prompt').length, 2);
  await assert.rejects(f.run({...args, task: 'changed payload'}, f.context, 'same-start'), /coding_request_key_conflict/);
});

test('failed checks create no formal commit; explicit rollback retains failed snapshot and affects only its task', async t => {
  const f = await fixture(t, {behavior: async ({cwd}) => {fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 0;\n'); fs.writeFileSync(path.join(cwd, 'scratch.txt'), 'unfinished');}});
  const first = await start(f), result = await f.settle(first.id);
  assert.equal(result.state, 'check_failed'); assert.equal(result.verifiedCommit, f.baseline); assert.equal(git(first.cwd, 'rev-parse', 'HEAD').trim(), f.baseline);
  await assert.rejects(f.run({action: 'preview', taskId: first.id}), /coding_task_not_ready/);
  const original = workingHash(f.source), rolled = await f.run({action: 'rollback', taskId: first.id}); assert.equal(rolled.state, 'rolled_back');
  assert.equal(git(first.cwd, 'status', '--porcelain=v1'), ''); assert.equal(workingHash(f.source), original);
  const raw = f.service.store.get(first.id); assert.ok(fs.existsSync(path.join(raw.snapshotPath, 'tracked.patch')));
  assert.equal(JSON.parse(fs.readFileSync(path.join(raw.snapshotPath, 'untracked.json')))[0].name, 'scratch.txt');
});

test('stale target, changed untracked content, candidate tampering and changed checks each invalidate merge authority', async t => {
  const f = await fixture(t), task = await start(f); await f.settle(task.id);
  fs.writeFileSync(path.join(f.source, 'draft.txt'), 'first draft');
  const p = await f.run({action: 'preview', taskId: task.id}); f.approve(p);
  fs.writeFileSync(path.join(f.source, 'draft.txt'), 'changed draft');
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: p.proposalId}), /merge_preview_stale/);
  const p2 = await f.run({action: 'preview', taskId: task.id}); f.approve(p2);
  const candidate = f.service.store.getPreview(p2.proposalId).payload.candidateDir;
  fs.writeFileSync(path.join(candidate, 'value.mjs'), 'export const value = 99;\n');
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: p2.proposalId}), /candidate_changed/);
  f.pluginConfig.projects[0].checks[0].argv.push('--changed');
  await assert.rejects(f.run({action: 'status', taskId: task.id}), /project_policy_changed/);
  assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline);
});

test('parallel tasks have isolated worktrees and a second merge must be re-previewed on the new target', async t => {
  const f = await fixture(t, {behavior: async ({cwd, text}) => {fs.writeFileSync(path.join(cwd, text.includes('second') ? 'README.md' : 'value.mjs'), text.includes('second') ? 'second module\n' : 'export const value = 2;\n');}});
  const a = await start(f), b = await f.run({action: 'start', projectId: 'fixture', task: 'second independent module'});
  await Promise.all([f.settle(a.id), f.settle(b.id)]); assert.notEqual(a.cwd, b.cwd); assert.equal(a.base, b.base);
  const p1 = await f.run({action: 'preview', taskId: a.id}), p2 = await f.run({action: 'preview', taskId: b.id});
  f.approve(p1); await f.run({action: 'merge', taskId: a.id, proposalId: p1.proposalId});
  f.approve(p2); await assert.rejects(f.run({action: 'merge', taskId: b.id, proposalId: p2.proposalId}), /merge_preview_stale/);
  const fresh = await f.run({action: 'preview', taskId: b.id}); f.approve(fresh); await f.run({action: 'merge', taskId: b.id, proposalId: fresh.proposalId});
  assert.match(fs.readFileSync(path.join(f.source, 'value.mjs'), 'utf8'), /value = 2/); assert.equal(fs.readFileSync(path.join(f.source, 'README.md'), 'utf8'), 'second module\n');
});

test('an extra ACP permission never becomes automatic approval or a tested commit', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => {assert.equal(await peer.args.permission({sessionId: peer.sessionId}, {toolCallId: 'extra-tool', rawInput: {private: 'not for unified log'}}), false);}});
  const task = await start(f), status = await f.settle(task.id);
  assert.equal(status.state, 'needs_permission'); assert.equal(status.verifiedCommit, f.baseline);
  assert.equal(JSON.stringify(f.events).includes('not for unified log'), false);
});

test('permission requests accumulate privately across continuation; repeated RPCs are counted once per connection', async t => {
  const f = await fixture(t, {behavior: async ({peer}) => {
    const params = {sessionId: peer.sessionId, toolCall: {toolCallId: 'outside-edit'}, options: [{kind: 'allow_once', optionId: 'allow'}]};
    const call = {toolCallId: 'outside-edit', kind: 'edit', rawInput: {file_path: '/outside-test/private.txt', justification: 'private reason retained only in audit'}};
    for (let i = 0; i < 2; i++) assert.equal(await peer.args.permission(params, call, {requestId: 'same-rpc', correlated: true}), false);
    assert.equal(await peer.args.permission({...params, toolCall: {toolCallId: 'unknown-action'}}, undefined, {requestId: 'unknown-rpc', correlated: false}), false);
  }});
  const task = await start(f), first = await f.settle(task.id);
  assert.equal(first.state, 'needs_permission'); assert.equal(first.permissionSummary.requests, 2); assert.equal(first.permissionSummary.approved, 0);
  assert.equal(first.permissionSummary.byScope.outside_test_root, 1); assert.equal(first.permissionSummary.byScope.unknown, 1);
  await f.run({action: 'continue', taskId: task.id, task: 'Continue without extra access.'});
  const next = await f.settle(task.id); assert.equal(next.permissionSummary.requests, 4);
  const file = next.permissionSummary.privateAuditFile, rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.length, 4); assert.equal(new Set(rows.map(row => row.roundId)).size, 2);
  assert.equal(rows[0].call.rawInput.justification, 'private reason retained only in audit');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.equal(JSON.stringify(f.events).includes('private reason'), false); assert.equal(JSON.stringify(f.events).includes('/outside-test'), false);
  assert.equal(f.events.filter(e => e.kind === 'coding.permission_rejected').length, 4);
});

test('a missing filesystem fence fails closed before creating a task', async t => {
  await assert.rejects(fixture(t, {configure(config) {config.writeBoundary.launcher = '/usr/bin/false';}}), /coding_write_boundary_unavailable/);
});

test('cancel and stop terminate their own active task; revoked delivery cannot rerun the model', async t => {
  let entered;
  const waiting = new Promise(resolve => entered = resolve);
  const f = await fixture(t, {behavior: async ({peer}) => {entered(); await new Promise(resolve => peer.once('cancel', resolve)); return {stopReason: 'cancelled'};}});
  const task = await start(f); await waiting;
  const cancelled = await f.run({action: 'cancel', taskId: task.id}); assert.equal(cancelled.state, 'cancelled');
  assert.equal(f.calls.filter(c => c.method === 'cancel').length, 1); assert.equal(f.deliveries.length, 0);
  f.config.channels['kurumi-qq'].accessControl.subjects[0].permissions['tasks.code'] = false;
  await assert.rejects(f.run({action: 'continue', taskId: task.id, task: 'resume'}), /capability_not_allowed/);
});

test('unknown delivery result stays unknown and is separate from successful execution', async t => {
  const f = await fixture(t, {delivery: async () => ({channel: 'kurumi-qq', messageId: ''})});
  const task = await start(f), status = await f.settle(task.id);
  assert.equal(status.state, 'ready'); assert.equal(status.delivery.state, 'unknown');
  await f.run({action: 'status', taskId: task.id}); assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1);
});

test('restart marks unresolved execution for reconciliation and never starts a duplicate ACP process', async t => {
  const f = await fixture(t), task = await start(f); await f.settle(task.id);
  f.service.store.save({...f.service.store.get(task.id), state: 'running'}); await f.service.stop();
  const restarted = new CodingService(f.pluginConfig, {authorize() {}, clientFactory() {throw Error('must not spawn');}}); restarted.start(); t.after(() => restarted.stop());
  assert.equal(restarted.store.get(task.id).state, 'needs_reconciliation'); assert.equal(restarted.active.size, 0);
});

test('checks cannot silently change the tree that is later committed', async t => {
  const f = await fixture(t, {configure: config => config.projects[0].checks = [{name: 'mutating check', argv: [process.execPath, '-e', "require('fs').writeFileSync('value.mjs','export const value = 4;\\n')"]}]});
  const task = await start(f), status = await f.settle(task.id); assert.equal(status.state, 'failed'); assert.equal(status.reason, 'checked_tree_changed'); assert.equal(status.verifiedCommit, f.baseline);
});

test('shared natural-confirmation runtime delivers the coding preview and authorizes only a later real-bound request', async t => {
  const {createConfirmationRuntime} = await import('../../plugins/personal-confirmation/dist/runtime.js');
  const f = await fixture(t), task = await start(f); await f.settle(task.id);
  const runtime = createConfirmationRuntime('100001');
  const receive = (text, id, runId) => {
    runtime.receive({ctx: {ChatType: 'direct', OriginatingChannel: 'kurumi-qq', OriginatingTo: 'user:100001', SenderId: '100001', AccountId: 'default',
      SessionKey: f.context.sessionKey, CommandAuthorized: true, MessageSid: id, Timestamp: Date.now(), RawBody: text}});
    const ctx = {sessionKey: f.context.sessionKey, sessionId: f.context.sessionId, runId, agentId: 'main', senderId: '100001', channel: 'kurumi-qq', trigger: 'user',
      toolAuthority: {allows: () => true, assertActive() {}}, hookInvocation: {assertActive() {}}};
    assert.match(runtime.prompt({}, ctx).prependContext, /编码合入/); return ctx;
  };
  const first = receive('请展示合入预览', 'coding-preview-source', 'coding-preview-run');
  const preview = await f.run({action: 'preview', taskId: task.id});
  runtime.afterTool({toolName: 'kurumi_code', runId: first.runId, result: {content: [{type: 'text', text: JSON.stringify(preview)}]}}, first);
  const reply = runtime.beforeReply({runId: first.runId, sessionKey: first.sessionKey, channel: 'kurumi-qq', kind: 'final', payload: {text: 'model paraphrase'}});
  assert.equal(reply.payload.text, preview.previewText);
  core.recordConfirmationDelivery({accountId: 'default', conversationId: 'user:100001', sourceMessageId: 'coding-preview-source', messageId: 'coding-preview-delivered', text: reply.payload.text});
  runtime.end({}, first);
  const next = receive('确认合入此测试任务', 'coding-owner-confirm', 'coding-confirm-run');
  runtime.beforeTool({toolName: 'personal_confirmation', toolCallId: 'coding-confirm-call', runId: next.runId}, next);
  const granted = runtime.execute('coding-confirm-call', {action: 'confirm', domain: 'coding', proposalId: preview.proposalId, payloadHash: preview.payloadHash}, f.context);
  assert.equal(granted.ok, true); assert.equal((await f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId})).state, 'merged');
  runtime.end({}, next);
});

test('an ignored untracked file at an added candidate path is preserved and cannot be overwritten by merge', async t => {
  const f = await fixture(t, {behavior: async ({cwd}) => {fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 2;\n'); fs.writeFileSync(path.join(cwd, 'generated.txt'), 'new task file\n');}});
  const task = await start(f); await f.settle(task.id);
  fs.writeFileSync(path.join(f.source, '.gitignore'), 'generated.txt\n'); fs.writeFileSync(path.join(f.source, 'generated.txt'), 'owner ignored progress\n');
  await assert.rejects(f.run({action: 'preview', taskId: task.id}), /target_untracked_overlap/);
  assert.equal(fs.readFileSync(path.join(f.source, 'generated.txt'), 'utf8'), 'owner ignored progress\n');
});

test('an ACP-created unchecked Git commit is rejected rather than advertised as a verified unit', async t => {
  const f = await fixture(t, {behavior: async ({cwd}) => {fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 2;\n'); git(cwd, 'add', '.'); git(cwd, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'unchecked backend commit');}});
  const task = await start(f), status = await f.settle(task.id);
  assert.equal(status.state, 'failed'); assert.equal(status.reason, 'unexpected_task_commit'); assert.equal(status.verifiedCommit, f.baseline);
});

test('coding task events pass through the existing unified log query without plaintext task/code payloads', async t => {
  const {createTraceSink} = await import('../../packages/observability/index.js');
  const {collectEvents} = await import('../../../scripts/fusion/log-query.mjs');
  const f = await fixture(t), task = await start(f); await f.settle(task.id);
  const sink = createTraceSink(path.join(f.root, 'channel', 'trace-events.jsonl'));
  for (const event of f.events) sink.emit(event);
  const rows = collectEvents({from: Date.now() - 60000, to: Date.now() + 60000, runtimeRoot: f.root, sources: ['trace-events']});
  assert.ok(rows.some(e => e.source === 'coding' && e.kind === 'coding.ready' && e.correlation.taskId === task.id && e.correlation.runId === 'fixture-real-hook-run'));
  assert.equal(JSON.stringify(rows).includes('Change only value.mjs'), false); assert.equal(JSON.stringify(rows).includes('export const'), false);
  assert.equal(fs.statSync(sink.file).mode & 0o777, 0o600);
});

test('product cancellation finishes even when the ACP peer ignores session/cancel', async t => {
  const {AcpClient} = await import('../../packages/coding-runtime/acp-client.js');
  const {fileURLToPath} = await import('node:url');
  const {setTimeout: delay} = await import('node:timers/promises');
  const f = await fixture(t, {clientFactory: args => new AcpClient({...args, command: process.execPath,
    args: [fileURLToPath(new URL('./acp-peer.mjs', import.meta.url))], env: {...process.env, FIXTURE_IGNORE_CANCEL: '1', FIXTURE_HEARTBEAT: path.join(args.cwd, 'heartbeat')},
  })});
  const task = await f.run({action: 'start', projectId: 'fixture', task: 'FIXTURE_WAIT'}), marker = path.join(task.cwd, 'heartbeat');
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await delay(20);
  assert.ok(fs.existsSync(marker));
  const result = await f.run({action: 'cancel', taskId: task.id}); assert.equal(result.state, 'cancelled');
  const size = fs.statSync(marker).size; await delay(100); assert.equal(fs.statSync(marker).size, size);
});
