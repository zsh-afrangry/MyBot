// Stage 3B tests: self-maintenance safety gate for kurumi-fusion-style repositories.
// Enforces protected runtime/policy diffs, mandatory non-skipped offline tests, Landlock isolation, and zero auto-restart/runtime edits.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture} from './fixtures.mjs';
import {git, projectPolicy} from '../../plugins/kurumi-coding/workspaces.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-self-maint-'));
test.after(() => fs.rmSync(tmpBase, {recursive: true, force: true}));

function setupSyntheticFusion(name) {
  const container = fs.mkdtempSync(path.join(tmpBase, name));
  const selfRepo = path.join(container, 'kurumi-fusion');
  const fakeRuntime = path.join(container, '.openclaw-fusion');
  const boundaryRoot = path.join(container, 'boundary');
  fs.mkdirSync(path.join(selfRepo, 'config'), {recursive: true});
  fs.mkdirSync(path.join(selfRepo, 'chatbot/pkg'), {recursive: true});
  fs.mkdirSync(fakeRuntime, {mode: 0o700});
  fs.mkdirSync(boundaryRoot, {mode: 0o700});

  fs.writeFileSync(path.join(fakeRuntime, 'openclaw.json'), '{"sentinel":true}\n');
  fs.writeFileSync(path.join(selfRepo, 'config/access-control.json'), '{"subjects":[]}\n');
  fs.writeFileSync(path.join(selfRepo, 'chatbot/pkg/math.mjs'), 'export const add = (a, b) => a + b;\n');
  git(selfRepo, 'init', '-b', 'main');
  git(selfRepo, 'add', '.');
  git(selfRepo, '-c', 'user.name=Maint', '-c', 'user.email=maint@localhost', 'commit', '-m', 'Self baseline');
  const baseline = git(selfRepo, 'rev-parse', 'HEAD').trim();
  return {container, selfRepo, fakeRuntime, boundaryRoot, baseline};
}

test('selfMaintenance policy checks opt-in flags, real kurumi-fusion gating, and immutable .openclaw-fusion ban', () => {
  const {selfRepo, boundaryRoot} = setupSyntheticFusion('policy-');
  const dshHome = path.join(boundaryRoot, 'dsh');
  const checkFile = path.join(boundaryRoot, 'check.mjs');
  fs.mkdirSync(dshHome, {recursive: true});
  fs.writeFileSync(checkFile, 'process.exit(0);\n');

  const base = {
    pilot: true,
    writeBoundary: {root: boundaryRoot, launcher: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'},
    root: path.join(boundaryRoot, 'state'),
    worktrees: path.join(boundaryRoot, 'worktrees'),
    dsh: {command: process.execPath, home: dshHome, model: ['fixture', 'fixture']},
    projects: [],
  };

  // selfMaintenance requires externalRoot: true.
  assert.throws(() => projectPolicy({
    ...base,
    projects: [{id: 'self', root: selfRepo, branch: 'main', selfMaintenance: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'self_maintenance_requires_external_root'});

  // .openclaw-fusion can NEVER be registered even with selfMaintenance: true.
  assert.throws(() => projectPolicy({
    ...base,
    projects: [{id: 'rt', root: '/home/afrangry/.openclaw-fusion', branch: 'main', externalRoot: true, selfMaintenance: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'protected_project_root'});

  // Invalid protectedPaths rejected.
  assert.throws(() => projectPolicy({
    ...base,
    projects: [{id: 'self', root: selfRepo, branch: 'main', externalRoot: true, selfMaintenance: true, protectedPaths: ['/abs/bad'], checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'invalid_project_flags'});

  // Real kurumi-fusion passes ONLY with selfMaintenance: true + externalRoot: true + allowRemote: true.
  assert.throws(() => projectPolicy({
    ...base,
    projects: [{id: 'kf', root: '/home/afrangry/kurumi-fusion', branch: 'main', externalRoot: true, allowRemote: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'protected_project_root'});
  assert.doesNotThrow(() => projectPolicy({
    ...base,
    projects: [{id: 'kf', root: '/home/afrangry/kurumi-fusion', branch: 'main', externalRoot: true, allowRemote: true, selfMaintenance: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }));
});

test('selfMaintenance blocks protected diffs, escaping symlinks, and skipped checks, while permitting tested code edits to confirm and merge safely', async t => {
  const {selfRepo, fakeRuntime, baseline} = setupSyntheticFusion('gate-');
  let mode = 'protected-access';
  const canaryBefore = fs.readFileSync(path.join(fakeRuntime, 'openclaw.json'), 'utf8');

  const f = await fixture(t, {
    configure(pluginConfig) {
      const checkScript = path.join(pluginConfig.writeBoundary.root, 'self-check.mjs');
      fs.writeFileSync(checkScript, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import {pathToFileURL} from 'node:url';
        if (fs.existsSync(path.join(process.env.CODING_WORKTREE, 'trigger-skip'))) process.exit(77);
        const mod = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE, 'chatbot/pkg/math.mjs')));
        assert.equal(mod.add(2, 3), 5);
        let blockedRuntime = false;
        try { fs.writeFileSync(${JSON.stringify(path.join(fakeRuntime, 'openclaw.json'))}, 'hacked'); }
        catch (err) { blockedRuntime = ['EACCES', 'EPERM', 'EROFS'].includes(err.code); }
        assert.equal(blockedRuntime, true);
      `);
      pluginConfig.projects.push({
        id: 'self-maint',
        root: selfRepo,
        branch: 'main',
        externalRoot: true,
        selfMaintenance: true,
        checks: [{name: 'self unit tests', argv: [process.execPath, checkScript], skipExitCode: 77}],
      });
    },
    behavior: async ({cwd, peer}) => {
      void peer;
      const {confinedProcess} = await import('../../packages/coding-runtime/write-fence.js');
      const confined = confinedProcess(f.pluginConfig.writeBoundary, process.execPath, [
        '-e',
        `const fs = require('fs'); try { fs.writeFileSync(${JSON.stringify(path.join(fakeRuntime, 'openclaw.json'))}, 'tamper'); process.exit(2); } catch { process.exit(0); }`,
      ], cwd);
      const r = spawnSync(confined.command, confined.args, {cwd, env: {...process.env, ...confined.env}});
      assert.equal(r.status, 0);

      if (mode === 'protected-access') {
        fs.writeFileSync(path.join(cwd, 'config/access-control.json'), '{"subjects":[{"qq":"999"}]}\n');
      } else if (mode === 'symlink-escape') {
        fs.writeFileSync(path.join(cwd, 'config/access-control.json'), '{"subjects":[]}\n');
        fs.symlinkSync(fakeRuntime, path.join(cwd, 'chatbot/pkg/escape-runtime'));
      } else if (mode === 'skip-check') {
        fs.rmSync(path.join(cwd, 'chatbot/pkg/escape-runtime'), {force: true});
        fs.writeFileSync(path.join(cwd, 'trigger-skip'), '1');
      } else {
        fs.rmSync(path.join(cwd, 'trigger-skip'), {force: true});
        fs.writeFileSync(path.join(cwd, 'chatbot/pkg/math.mjs'), 'export const add = (a, b) => Number(a) + Number(b);\n');
      }
    },
  });

  // 1. Modifying config/access-control.json fails preview with self_maintenance_protected_diff.
  const t1 = await f.run({action: 'start', projectId: 'self-maint', task: 'Try editing access-control.'});
  const r1 = await f.settle(t1.id);
  assert.equal(r1.state, 'ready');
  await assert.rejects(f.run({action: 'preview', taskId: t1.id}), {code: 'self_maintenance_protected_diff'});

  // 2. Adding a symlink pointing out into .openclaw-fusion also fails preview.
  mode = 'symlink-escape';
  await f.run({action: 'continue', taskId: t1.id, task: 'Replace with symlink escape.'});
  await f.settle(t1.id);
  await assert.rejects(f.run({action: 'preview', taskId: t1.id}), {code: 'self_maintenance_protected_diff'});

  // 3. A check returning skipExitCode is NOT treated as verified under selfMaintenance.
  mode = 'skip-check';
  await f.run({action: 'continue', taskId: t1.id, task: 'Trigger skip exit code.'});
  const rSkip = await f.settle(t1.id);
  assert.equal(rSkip.state, 'check_failed');

  // 4. Clean code change passes tests -> freezes preview with selfMaintenance guard text -> confirms -> merges cleanly.
  mode = 'valid-edit';
  await f.run({action: 'continue', taskId: t1.id, task: 'Implement valid safe change.'});
  const rValid = await f.settle(t1.id);
  assert.equal(rValid.state, 'ready');
  assert.equal(rValid.checks.ok, true);

  const pv = await f.run({action: 'preview', taskId: t1.id});
  assert.match(pv.previewText, /不写\.openclaw-fusion、不自动重启服务/);
  f.approve(pv);
  const merged = await f.run({action: 'merge', taskId: t1.id, proposalId: pv.proposalId});
  assert.equal(merged.state, 'merged');
  assert.notEqual(git(selfRepo, 'rev-parse', 'HEAD').trim(), baseline);
  assert.match(fs.readFileSync(path.join(selfRepo, 'chatbot/pkg/math.mjs'), 'utf8'), /Number\(a\)/);
  assert.equal(fs.readFileSync(path.join(fakeRuntime, 'openclaw.json'), 'utf8'), canaryBefore);
});

test('autoPreviewOnReady reports blocked preview error without failing notification when selfMaintenance blocks protected diff', async t => {
  const {selfRepo} = setupSyntheticFusion('self-autopv-blocked-');
  const seenFacts = [];
  const f = await fixture(t, {
    composeNotice: async facts => { seenFacts.push(facts); return `blocked=${facts.mergePreview?.code}`; },
    configure: plugin => {
      plugin.autoPreviewOnReady = true;
      plugin.projects.push({
        id: 'self-maint',
        root: selfRepo,
        branch: 'main',
        externalRoot: true,
        selfMaintenance: true,
        checks: [{name: 'safe-check', argv: ['/usr/bin/node', '-e', 'process.exit(0)']}],
      });
    },
    behavior: async ({cwd}) => {
      fs.writeFileSync(path.join(cwd, 'config/access-control.json'), '{"subjects":[{"qq":"999"}]}\n');
    },
  });

  const task = await f.run({action: 'start', projectId: 'self-maint', task: 'Touch protected access-control'});
  const ready = await f.settle(task.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.delivery.state, 'platform_accepted');
  assert.equal(f.deliveries.length, 1);
  assert.match(f.deliveries[0].text, /blocked=self_maintenance_protected_diff/);
  assert.equal(seenFacts[0].mergePreview?.status, 'blocked');
  assert.equal(f.service.store.latestPreview(task.id), null);
});
