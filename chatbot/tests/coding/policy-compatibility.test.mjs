// Offline configuration-upgrade regression with private synthetic Git/SQLite; no model or real QQ.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture, member} from './fixtures.mjs';
import {git, targetState} from '../../plugins/kurumi-coding/workspaces.js';

const start = f => f.run({action: 'start', projectId: 'fixture', task: 'Update the synthetic integer and run registered checks.'});
const extraCheck = (name, script = 'process.exit(0)') => ({name, argv: [process.execPath, '-e', script]});
const grantStatus = (f, p) => f.service.store.db.prepare('SELECT status FROM approval_grants WHERE proposal_id=?').get(p.proposalId)?.status;
async function ready(t, options) {
  const f = await fixture(t, options), task = await start(f);
  await f.settle(task.id);
  return {f, task};
}

test('legacy tasks remain readable after checks/backend settings change, and continuation uses current checks without a policy fingerprint', async t => {
  const {f, task} = await ready(t), raw = f.service.store.get(task.id);
  assert.equal(Object.hasOwn(raw, 'policyHash'), false);
  f.service.store.save({...raw, policyHash: 'legacy-field-retained-without-interpretation', executionRoundId: undefined});
  const marker = path.join(f.root, 'new-check-runs');
  f.pluginConfig.projects[0].checks.push(extraCheck('new operator check', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'checked')`));
  f.pluginConfig.dsh.model = ['fixture', 'updated-fixture'];
  const prompts = f.calls.filter(c => c.method === 'prompt').length, sends = f.deliveries.length;
  assert.equal((await f.run({action: 'list'})).tasks[0].id, task.id);
  assert.equal((await f.run({action: 'status', taskId: task.id})).state, 'ready');
  assert.match((await f.run({action: 'diff', taskId: task.id})).committedDiff, /value = 2/);
  assert.equal((await f.run({action: 'result', taskId: task.id})).result.reason, 'result_not_recorded');
  assert.equal(fs.existsSync(marker), false); assert.equal(f.calls.filter(c => c.method === 'prompt').length, prompts); assert.equal(f.deliveries.length, sends);
  await f.run({action: 'continue', taskId: task.id, task: 'Continue under the current registered checks.'});
  const next = await f.settle(task.id);
  assert.equal(next.state, 'ready'); assert.equal(next.checks.rows.at(-1).name, 'new operator check');
  assert.equal(fs.readFileSync(marker, 'utf8'), 'checked');
  assert.equal(f.service.store.get(task.id).policyHash, raw.policyHash ?? 'legacy-field-retained-without-interpretation');
  assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline);
});

test('configuration upgrades do not relax requester binding or current read permissions', async t => {
  const {f, task} = await ready(t);
  f.pluginConfig.projects[0].checks.push(extraCheck('new check'));
  for (const ctx of [{...f.context, requesterSenderId: member, senderIsOwner: false}, {...f.context, sessionKey: 'agent:main:cron:synthetic'}]) {
    await assert.rejects(f.run({action: 'status', taskId: task.id}, ctx));
    await assert.rejects(f.run({action: 'diff', taskId: task.id}, ctx));
  }
  f.config.channels['kurumi-qq'].accessControl.subjects[0].permissions['tasks.read'] = false;
  await assert.rejects(f.run({action: 'status', taskId: task.id}), /capability_not_allowed/);
  assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1);
});

test('actual project and directory changes are rejected by explicit conditions', async t => {
  for (const change of ['unregistered', 'remapped-repository', 'outside-boundary', 'moved-worktree-root', 'symlink-worktree']) await t.test(change, async t => {
    const {f, task} = await ready(t);
    let code;
    if (change === 'unregistered') {f.pluginConfig.projects = []; code = /unknown_coding_project/;}
    if (change === 'remapped-repository') {
      const other = path.join(f.root, 'another-project'); fs.mkdirSync(other); git(other, 'init', '-b', 'main');
      f.pluginConfig.projects[0].root = other; code = /task_project_changed/;
    }
    if (change === 'outside-boundary') {f.pluginConfig.writeBoundary.root = path.join(f.root, 'narrower-authorization'); code = /coding_paths_outside_write_boundary/;}
    if (change === 'moved-worktree-root') {f.pluginConfig.worktrees = path.join(f.root, 'different-worktrees'); code = /task_workspace_changed/;}
    if (change === 'symlink-worktree') {
      const moved = path.join(f.root, 'moved-task'); fs.renameSync(task.cwd, moved); fs.symlinkSync(moved, task.cwd); code = /invalid_coding_paths/;
    }
    await assert.rejects(f.run({action: 'status', taskId: task.id}), code);
    await assert.rejects(f.run({action: 'continue', taskId: task.id, task: 'Must not launch with a different actual location.'}), code);
    assert.equal(f.calls.filter(c => c.method === 'prompt').length, 1);
    assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline);
  });
});

test('preview and confirmed merge use current checks while preserving the historical execution result', async t => {
  const {f, task} = await ready(t);
  const roundId = f.service.store.get(task.id).executionRoundId;
  f.pluginConfig.projects[0].checks.push(extraCheck('added before preview'));
  const preview = await f.run({action: 'preview', taskId: task.id}); f.approve(preview);
  const frozen = f.service.store.getPreview(preview.proposalId).payload;
  assert.equal(frozen.checks.rows.length, 2); assert.equal(frozen.projectRoot, f.source);
  const marker = path.join(f.root, 'merge-current-check-runs');
  f.pluginConfig.projects[0].checks.push(extraCheck('added after confirmation', `require('fs').appendFileSync(${JSON.stringify(marker)}, 'current')`));
  const merged = await f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId});
  assert.equal(merged.state, 'merged'); assert.equal(merged.mergeChecks.ok, true); assert.equal(merged.mergeChecks.rows.length, 3);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'current'); assert.equal(grantStatus(f, preview), 'consumed');
  assert.equal(f.service.store.result(task.id, roundId).hostChecks.rows.length, 1);
  assert.deepEqual(f.service.store.getPreview(preview.proposalId).payload.checks, frozen.checks);
  assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), frozen.candidate);
});

test('a newly failing merge check leaves the source and confirmation intact; current passing checks can be retried', async t => {
  const {f, task} = await ready(t), preview = await f.run({action: 'preview', taskId: task.id}); f.approve(preview);
  f.pluginConfig.projects[0].checks.push(extraCheck('new mandatory check', 'process.exit(9)'));
  const before = targetState({root: f.source});
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /candidate_checks_failed/);
  assert.deepEqual(targetState({root: f.source}), before); assert.equal(grantStatus(f, preview), 'pending');
  const failed = await f.run({action: 'status', taskId: task.id}); assert.equal(failed.state, 'ready'); assert.equal(failed.mergeChecks.ok, false);
  f.pluginConfig.projects[0].checks.at(-1).argv = [process.execPath, '-e', 'process.exit(0)'];
  assert.equal((await f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId})).state, 'merged');
});

test('a changed registered target branch leaves historical reads available but invalidates the old merge target', async t => {
  const {f, task} = await ready(t), preview = await f.run({action: 'preview', taskId: task.id}); f.approve(preview);
  git(f.source, 'branch', 'other-target');
  f.pluginConfig.projects[0].branch = 'other-target';
  assert.equal((await f.run({action: 'status', taskId: task.id})).state, 'ready');
  assert.match((await f.run({action: 'diff', taskId: task.id})).committedDiff, /value = 2/);
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /merge_preview_stale/);
  await assert.rejects(f.run({action: 'preview', taskId: task.id}), /target_branch_changed/);
  assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline); assert.equal(grantStatus(f, preview), 'pending');
});

test('merge validation detects candidate/target changes, revoked permission and checks changed while running before consuming confirmation', async t => {
  for (const change of ['candidate', 'target', 'permission', 'check-plan']) await t.test(change, async t => {
    const {f, task} = await ready(t), preview = await f.run({action: 'preview', taskId: task.id}); f.approve(preview);
    const candidate = f.service.store.getPreview(preview.proposalId).payload.candidateDir;
    const marker = path.join(f.root, 'validation-started'), release = path.join(f.root, 'validation-release');
    f.pluginConfig.projects[0].checks.push({...extraCheck('wait for concurrent change', `const fs=require('fs');fs.writeFileSync(${JSON.stringify(marker)},'started');const timer=setInterval(()=>{if(fs.existsSync(${JSON.stringify(release)})){clearInterval(timer);}},10);`), timeoutMs: 5000});
    let error;
    const pending = f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}).catch(e => {error = e;});
    const {setTimeout: delay} = await import('node:timers/promises');
    for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await delay(10);
    assert.equal(fs.existsSync(marker), true);
    if (change === 'candidate') fs.writeFileSync(path.join(candidate, 'value.mjs'), 'export const value = 77;\n');
    if (change === 'target') fs.writeFileSync(path.join(f.source, 'notes.txt'), 'owner concurrent progress\n');
    if (change === 'permission') f.config.channels['kurumi-qq'].accessControl.subjects[0].permissions['tasks.code'] = false;
    if (change === 'check-plan') f.pluginConfig.projects[0].checks.push(extraCheck('arrived during validation'));
    fs.writeFileSync(release, 'release'); await pending;
    assert.match(error?.code ?? '', {candidate: /candidate_changed/, target: /merge_preview_stale/, permission: /capability_not_allowed/, 'check-plan': /checks_changed_during_validation/}[change]);
    assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline); assert.equal(grantStatus(f, preview), 'pending');
  });
});

test('current passing checks still require an explicit exact-candidate confirmation', async t => {
  const {f, task} = await ready(t), preview = await f.run({action: 'preview', taskId: task.id});
  f.pluginConfig.projects[0].checks.push(extraCheck('new passing check'));
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /approval_required/);
  assert.equal(git(f.source, 'rev-parse', 'HEAD').trim(), f.baseline);
});
