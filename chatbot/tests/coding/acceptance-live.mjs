// Explicit --live only: real DSH ACP/model calls through the actual plugin handler and task service.
// Synthetic temporary Git project, recording delivery/owner-confirmation fixture; NO real QQ or production config/service writes.
// Evidence: docs/verification/coding-delegation-plan-2026-10-28/product-pilot-2026-10-29/README.md.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fixture} from './fixtures.mjs';
import {AcpClient} from '../../packages/coding-runtime/acp-client.js';
import {git, targetState, runChecks} from '../../plugins/kurumi-coding/workspaces.js';

if (!process.argv.includes('--live')) throw Error('Explicit --live required: this invokes the installed DSH model. No QQ messages are sent.');
const evidence = process.argv.find(a => a.startsWith('--output='))?.slice('--output='.length);
if (!evidence || !path.isAbsolute(evidence) || fs.existsSync(evidence)) throw Error('Absolute --output= sanitized report path required');
const f = await fixture(null, {clientFactory: args => new AcpClient(args), configure(config) {
  config.dsh = {command: '/opt/deepseek-harness/node_modules/.bin/dsh', home: '/var/lib/dsh/.dsh', model: ['deepseek-official', 'deepseek-flash']};
}});
const report = {schemaVersion: 1, at: new Date().toISOString(), type: 'product-pilot-local', actualDsh: true, actualQq: false,
  ownerConfirmation: 'synthetic-local-fixture-only', privateArtifacts: f.root, prompts: 0, cases: [], productionChanged: false};
const record = (name, result) => {report.cases.push({name, ...result}); console.log(JSON.stringify({name, ...result}));};
try {
  // The registered acceptance check lives outside the task workspace; the model cannot edit it there.
  const check = path.join(f.root, 'acceptance-check.mjs');
  fs.writeFileSync(check, `import assert from 'node:assert/strict'; import path from 'node:path'; import {pathToFileURL} from 'node:url';
const m = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE, 'value.mjs')));
assert.equal(typeof m.clamp, 'function'); for(const [x,a,b,want] of [[-5,0,10,0],[5,0,10,5],[15,0,10,10],[0,0,10,0],[10,0,10,10],[1.5,0,2,1.5]]) assert.equal(m.clamp(x,a,b),want);
assert.throws(()=>m.clamp(1,3,2), RangeError); console.log('7 fixed clamp assertions passed');\n`);
  f.pluginConfig.projects[0].checks = [{name: 'fixed clamp assertions', argv: [process.execPath, check]}, {name: 'project node tests', argv: [process.execPath, '--test']}];
  const baseline = await runChecks(f.pluginConfig.projects[0], f.source, path.join(f.root, 'baseline-checks.log'));
  assert.equal(baseline.ok, false); record('baseline_missing_requested_feature', {ok: true, checkExit: baseline.rows[0].code});
  fs.writeFileSync(path.join(f.source, 'README.md'), 'operator staged unrelated development\n'); git(f.source, 'add', 'README.md');
  fs.writeFileSync(path.join(f.source, 'notes.txt'), 'operator unstaged unrelated development\n'); fs.writeFileSync(path.join(f.source, 'local-draft.txt'), 'operator private untracked fixture\n');
  const original = targetState({root: f.source});
  const task = await f.run({action: 'start', projectId: 'fixture', task: '在 value.mjs 保留原有 value 导出，新增并导出 clamp(value,min,max) 数值函数：小于 min 返回 min，大于 max 返回 max，其余返回 value，min>max 时抛出 RangeError。添加 Node 内置测试，至少包含两边界、区间内、小数和非法范围。仅修改该任务工作树，不提交或合入，由宿主运行固定检查。不要编辑其他目录，也不要启动后台服务。'}); report.prompts++;
  record('start_and_query', {ok: true, taskId: task.id, baseline: task.base, isolatedCwd: task.cwd !== f.source});
  const ready = await f.settle(task.id);
  record('actual_coding_registered_checks_commit', {ok: ready.state === 'ready', state: ready.state, reason: ready.reason, checks: ready.checks, commit: ready.verifiedCommit, externalSessionId: ready.externalSessionId});
  assert.equal(ready.state, 'ready'); assert.deepEqual(targetState({root: f.source}), original);
  // Resume the exact persisted session without a fresh task or implicit replay.
  await f.run({action: 'continue', taskId: task.id, task: '继续同一个任务：添加 clamp 的 min=max 情况的 Node 测试，补充 value.mjs 中函数的简短 JSDoc。保留 clamp 所有行为，不提交或合入，不编辑其他目录。'}); report.prompts++;
  const resumed = await f.settle(task.id); assert.equal(resumed.state, 'ready'); assert.equal(resumed.externalSessionId, ready.externalSessionId);
  record('same_session_continuation', {ok: true, externalSessionId: resumed.externalSessionId, checks: resumed.checks, commit: resumed.verifiedCommit});
  const diff = await f.run({action: 'diff', taskId: task.id}); assert.match(diff.diff, /clamp/);
  const p = await f.run({action: 'preview', taskId: task.id});
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: p.proposalId}), /approval_required/);
  assert.deepEqual(targetState({root: f.source}), original);
  record('no_merge_before_owner_fixture_approval', {ok: true, proposalId: p.proposalId, payloadHash: p.payloadHash});
  // This exercises the real shared confirmation core, but is explicitly NOT a human QQ confirmation.
  f.approve(p); const merged = await f.run({action: 'merge', taskId: task.id, proposalId: p.proposalId}); assert.equal(merged.state, 'merged');
  const after = targetState({root: f.source}); assert.equal(after.status, original.status); assert.equal(after.diff, original.diff); assert.deepEqual(after.files, original.files);
  const result = await runChecks(f.pluginConfig.projects[0], f.source, path.join(f.root, 'merged-checks.log')); assert.equal(result.ok, true);
  record('confirmed_local_fixture_merge_dirty_preserved', {ok: true, candidate: merged.candidate, checks: result});
  assert.equal(resumed.delivery.state, 'platform_accepted');
  record('recording_delivery_and_trusted_trace', {ok: true, messages: f.deliveries.length,
    linkedEvents: f.events.filter(e => e.correlation.taskId === task.id && e.correlation.runId === 'fixture-real-hook-run').length,
    transport: 'recording-adapter-only-no-real-QQ'});
  report.ok = true;
} catch (error) {
  report.ok = false; report.failure = {code: error.code ?? error.name, message: error.code ?? (error.name === 'AssertionError' ? String(error.message).slice(0, 200) : 'see private artifacts')};
  process.exitCode = 1;
} finally {
  for (const s of f.services.toReversed()) await s.stop();
  fs.mkdirSync(path.dirname(evidence), {recursive: true}); fs.writeFileSync(evidence, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({ok: report.ok, report: evidence, privateArtifacts: f.root, actualQq: false, prompts: report.prompts}));
}
