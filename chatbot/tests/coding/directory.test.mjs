// Registered non-Git experiments, real Git/SQLite and fenced file writeback. No model/QQ calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fixture} from './fixtures.mjs';
import {projectPolicy, git} from '../../plugins/kurumi-coding/workspaces.js';
import {directoryState, prepareDirectoryWriteback, runDirectoryWriteback, directoryWritebackState} from '../../plugins/kurumi-coding/directory-workspaces.js';
const start = f => f.run({action: 'start', projectId: 'fixture', task: 'Change the registered private experiment only.'});
async function prepared(f) {
  const task = await start(f); assert.equal((await f.settle(task.id)).state, 'ready');
  const preview = await f.run({action: 'preview', taskId: task.id});
  return {task, preview, payload: f.service.store.getPreview(preview.proposalId).payload};
}
test('non-Git copy includes ignored/binary files and empty directories; confirmed rename/suffix/create/delete preserves the original until writeback', async t => {
  const bytes = Buffer.from([0, 255, 2, 13, 10]);
  const f = await fixture(t, {directoryProject: true, sourceSetup(source) {
    fs.writeFileSync(path.join(source, '.gitignore'), 'private.bin\n');
    fs.writeFileSync(path.join(source, 'private.bin'), bytes, {mode: 0o640});
    fs.writeFileSync(path.join(source, '中文 草稿.txt'), 'extension only\n', {mode: 0o640});
    fs.mkdirSync(path.join(source, 'empty'), {mode: 0o750});
  }, behavior: async ({cwd}) => {
    assert.deepEqual(fs.readFileSync(path.join(cwd, 'private.bin')), bytes);
    fs.renameSync(path.join(cwd, '中文 草稿.txt'), path.join(cwd, '中文 结果.md'));
    fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 2;\n');
    fs.unlinkSync(path.join(cwd, 'notes.txt')); fs.mkdirSync(path.join(cwd, 'added'));
    fs.writeFileSync(path.join(cwd, 'added', 'result.txt'), 'new result\n');
  }});
  const before = directoryState(f.source), {task, preview} = await prepared(f);
  assert.equal(task.workspaceKind, 'directory'); assert.deepEqual(directoryState(f.source), before);
  assert.match(preview.previewText, /确认后目录回写/); assert.match(f.deliveries[0].text, /尚未修改原目录/);
  await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /approval_required/);
  assert.deepEqual(directoryState(f.source), before);
  f.approve(preview); const done = await f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId});
  assert.equal(done.state, 'written_back'); assert.equal(fs.existsSync(path.join(f.source, '.git')), false);
  assert.equal(fs.existsSync(path.join(f.source, 'notes.txt')), false); assert.equal(fs.existsSync(path.join(f.source, '中文 草稿.txt')), false);
  assert.equal(fs.readFileSync(path.join(f.source, '中文 结果.md'), 'utf8'), 'extension only\n');
  assert.equal(fs.readFileSync(path.join(f.source, 'added', 'result.txt'), 'utf8'), 'new result\n');
  assert.deepEqual(fs.readFileSync(path.join(f.source, 'private.bin')), bytes);
  assert.equal(fs.statSync(path.join(f.source, 'private.bin')).mode & 0o777, 0o640);
  assert.equal(fs.statSync(path.join(f.source, 'empty')).mode & 0o777, 0o750);
  assert.equal((await f.run({action: 'cancel', taskId: task.id})).state, 'written_back');
  assert.equal((await f.run({action: 'list'})).projects[0].kind, 'directory');
});
test('original edits, new files or permission changes invalidate the complete directory baseline', async t => {
  for (const mutate of [s => fs.writeFileSync(path.join(s, 'notes.txt'), 'operator edit'), s => fs.writeFileSync(path.join(s, 'new.txt'), 'operator new'), s => fs.chmodSync(path.join(s, 'notes.txt'), 0o600)]) {
    const f = await fixture(t, {directoryProject: true}), {task, preview} = await prepared(f); f.approve(preview); mutate(f.source);
    const edited = directoryState(f.source);
    await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /merge_preview_stale/);
    await assert.rejects(f.run({action: 'preview', taskId: task.id}), /directory_source_changed/);
    assert.deepEqual(directoryState(f.source), edited);
    for (const service of f.services.toReversed()) await service.stop();
  }
});
test('candidate symlinks and file/directory conversion are refused without writes to the original', async t => {
  for (const behavior of [async ({cwd}) => {fs.symlinkSync('/etc/hosts', path.join(cwd, 'link'));}, async ({cwd}) => {fs.unlinkSync(path.join(cwd, 'notes.txt')); fs.mkdirSync(path.join(cwd, 'notes.txt')); fs.writeFileSync(path.join(cwd, 'notes.txt', 'new.txt'), 'type changed');}]) {
    const f = await fixture(t, {directoryProject: true, behavior}), before = directoryState(f.source), task = await start(f);
    assert.equal((await f.settle(task.id)).state, 'ready');
    await assert.rejects(f.run({action: 'preview', taskId: task.id}), /directory_requires_regular_files|directory_type_change_not_supported/);
    assert.deepEqual(directoryState(f.source), before);
    for (const service of f.services.toReversed()) await service.stop();
  }
});
test('registration refuses symlinks, embedded Git and directories inside another repository', async t => {
  const f = await fixture(t, {directoryProject: true});
  const bad = path.join(f.source, 'bad'); fs.symlinkSync('/etc/hosts', bad);
  assert.throws(() => projectPolicy(f.pluginConfig), /directory_requires_regular_files/); fs.unlinkSync(bad);
  fs.mkdirSync(path.join(f.source, '.git')); assert.throws(() => projectPolicy(f.pluginConfig), /directory_contains_git/); fs.rmdirSync(path.join(f.source, '.git'));
  git(f.root, 'init'); assert.throws(() => projectPolicy(f.pluginConfig), /directory_is_inside_git/);
});
test('fenced writeback rolls back preceding file changes if a later staged candidate disappears', async t => {
  const f = await fixture(t, {directoryProject: true, behavior: async ({cwd}) => {fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 2;\n'); fs.writeFileSync(path.join(cwd, 'README.md'), 'changed\n');}});
  const {task, payload} = await prepared(f), before = directoryState(f.source), transaction = prepareDirectoryWriteback(f.pluginConfig.root, f.pluginConfig.projects[0], f.service.store.get(task.id), payload.candidateDir, payload.directoryPlan);
  fs.unlinkSync(path.join(path.dirname(transaction.file), 'new', '1'));
  assert.throws(() => runDirectoryWriteback(f.pluginConfig.writeBoundary, f.pluginConfig.projects[0], transaction), /directory_writeback_rolled_back/);
  assert.deepEqual(directoryState(f.source), before); assert.equal(directoryWritebackState(transaction, f.pluginConfig.projects[0]), 'ready');
  assert.equal(JSON.parse(fs.readFileSync(transaction.file)).phase, 'rolled_back');
});
for (const applied of [false, true]) test(`restart reconciles ${applied ? 'completed' : 'unstarted'} writeback without replaying it`, async t => {
  const f = await fixture(t, {directoryProject: true}), {task, preview, payload} = await prepared(f);
  const transaction = prepareDirectoryWriteback(f.pluginConfig.root, f.pluginConfig.projects[0], f.service.store.get(task.id), payload.candidateDir, payload.directoryPlan);
  if (applied) runDirectoryWriteback(f.pluginConfig.writeBoundary, f.pluginConfig.projects[0], transaction);
  f.service.store.save({...f.service.store.get(task.id), state: 'merging', mergeProposalId: preview.proposalId, mergeCandidate: payload.candidate, directoryWriteback: transaction});
  await f.service.stop(); f.service.start(); const calls = f.calls.length, before = directoryState(f.source);
  const result = await f.run({action: 'reconcile', taskId: task.id});
  assert.equal(result.state, applied ? 'written_back' : 'ready'); assert.equal(f.calls.length, calls); assert.deepEqual(directoryState(f.source), before);
  if (!applied) {await assert.rejects(f.run({action: 'merge', taskId: task.id, proposalId: preview.proposalId}), /approval_required/);}
});
test('partially applied journals stay explicit reconciliation failures and cannot be cancelled or continued as execution tasks', async t => {
  const f = await fixture(t, {directoryProject: true}), {task, preview, payload} = await prepared(f);
  const transaction = prepareDirectoryWriteback(f.pluginConfig.root, f.pluginConfig.projects[0], f.service.store.get(task.id), payload.candidateDir, payload.directoryPlan);
  const journal = JSON.parse(fs.readFileSync(transaction.file)); journal.phase = 'applying'; fs.writeFileSync(transaction.file, JSON.stringify(journal));
  f.service.store.save({...f.service.store.get(task.id), state: 'merging', mergeProposalId: preview.proposalId, mergeCandidate: payload.candidate, directoryWriteback: transaction});
  await f.service.stop(); f.service.start();
  await assert.rejects(f.run({action: 'reconcile', taskId: task.id}), /directory_writeback_requires_reconciliation/);
  await assert.rejects(f.run({action: 'cancel', taskId: task.id}), /merge_reconciliation_required/);
  await assert.rejects(f.run({action: 'continue', taskId: task.id, task: 'continue'}), /merge_reconciliation_required/);
  assert.equal((await f.run({action: 'status', taskId: task.id})).state, 'needs_reconciliation');
});
