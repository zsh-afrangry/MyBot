// Stage 3A tests: external real Git repositories with remotes and dynamic per-phase Landlock boundaries.
// Uses isolated temporary repos, loopback bare remotes, and real landlock-run; never pushes or alters host repos.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fixture, core} from './fixtures.mjs';
import {git, projectPolicy, targetState} from '../../plugins/kurumi-coding/workspaces.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-ext-projects-'));
test.after(() => fs.rmSync(tmpBase, {recursive: true, force: true}));

function setupExternalGitProject(name, {withRemote = true, withSubmodules = false} = {}) {
  const container = fs.mkdtempSync(path.join(tmpBase, name));
  const bareRemote = path.join(container, 'origin.git');
  const externalRepo = path.join(container, 'repo');
  const boundaryRoot = path.join(container, 'pilot-boundary');
  fs.mkdirSync(externalRepo, {recursive: true});
  fs.mkdirSync(boundaryRoot, {mode: 0o700});

  git(externalRepo, 'init', '-b', 'master');
  fs.writeFileSync(path.join(externalRepo, 'value.mjs'), 'export const value = 10;\n');
  fs.writeFileSync(path.join(externalRepo, 'notes.txt'), 'external committed baseline\n');
  git(externalRepo, 'add', '.');
  git(externalRepo, '-c', 'user.name=External', '-c', 'user.email=ext@localhost', 'commit', '-m', 'External init');

  if (withRemote) {
    git(container, 'init', '--bare', bareRemote);
    git(externalRepo, 'remote', 'add', 'origin', bareRemote);
  }
  if (withSubmodules) {
    fs.writeFileSync(path.join(externalRepo, '.gitmodules'), '[submodule "x"]\n\tpath = x\n\turl = https://invalid.local/x.git\n');
    git(externalRepo, 'add', '.gitmodules');
    git(externalRepo, '-c', 'user.name=External', '-c', 'user.email=ext@localhost', 'commit', '-m', 'Add .gitmodules');
  }
  const baseline = git(externalRepo, 'rev-parse', 'HEAD').trim();
  return {container, bareRemote, externalRepo, boundaryRoot, baseline};
}

test('external Git projects require explicit opt-in, allow remotes when flagged, and still reject submodules and external directories', async t => {
  const {container, externalRepo, boundaryRoot} = setupExternalGitProject('policy-');
  const dshHome = path.join(boundaryRoot, 'dsh');
  const checkFile = path.join(boundaryRoot, 'check.mjs');
  fs.mkdirSync(dshHome, {recursive: true});
  fs.writeFileSync(checkFile, 'process.exit(0);\n');

  const baseConfig = {
    pilot: true,
    writeBoundary: {root: boundaryRoot, launcher: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'},
    root: path.join(boundaryRoot, 'state'),
    worktrees: path.join(boundaryRoot, 'worktrees'),
    dsh: {command: process.execPath, home: dshHome, model: ['fixture', 'fixture']},
    projects: [],
  };

  // Without externalRoot: outside boundary fails coding_paths_outside_write_boundary.
  assert.throws(() => projectPolicy({
    ...baseConfig,
    projects: [{id: 'ext', root: externalRepo, branch: 'master', checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'coding_paths_outside_write_boundary'});

  // With externalRoot=true but allowRemote omitted: remote fails pilot_requires_synthetic_local_repository.
  assert.throws(() => projectPolicy({
    ...baseConfig,
    projects: [{id: 'ext', root: externalRepo, branch: 'master', externalRoot: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'pilot_requires_synthetic_local_repository'});

  // Directory kind cannot use externalRoot.
  const extDir = path.join(container, 'ext-dir');
  fs.mkdirSync(extDir);
  assert.throws(() => projectPolicy({
    ...baseConfig,
    projects: [{id: 'extdir', root: extDir, kind: 'directory', externalRoot: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'external_directory_project_not_allowed'});

  // Submodules stay rejected even when externalRoot + allowRemote are set.
  const sub = setupExternalGitProject('submod-', {withRemote: true, withSubmodules: true});
  assert.throws(() => projectPolicy({
    ...baseConfig,
    projects: [{id: 'sub', root: sub.externalRepo, branch: 'master', externalRoot: true, allowRemote: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'pilot_requires_synthetic_local_repository'});

  // Self-maintenance on kurumi-fusion stays rejected without Stage 3B selfMaintenance policy.
  assert.throws(() => projectPolicy({
    ...baseConfig,
    projects: [{id: 'self', root: '/home/afrangry/kurumi-fusion', branch: 'main', externalRoot: true, allowRemote: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }), {code: 'protected_project_root'});

  // Valid external Git repo with origin remote passes policy cleanly.
  assert.doesNotThrow(() => projectPolicy({
    ...baseConfig,
    projects: [{id: 'ext', root: externalRepo, branch: 'master', externalRoot: true, allowRemote: true, checks: [{name: 'ok', argv: [process.execPath, checkFile]}]}],
  }));
});

test('external Git workflow isolates worktree under Landlock, blocks direct writes to external source/checks, confirms, merges --ff-only, and never pushes', async t => {
  const {externalRepo, bareRemote, baseline} = setupExternalGitProject('flow-');
  const writeProbeErrors = [];
  let checkTriedExternalWrite = false;

  const f = await fixture(t, {
    configure(pluginConfig) {
      const checkScript = path.join(pluginConfig.writeBoundary.root, 'ext-check.mjs');
      fs.writeFileSync(checkScript, `
        import assert from 'node:assert/strict';
        import fs from 'node:fs';
        import path from 'node:path';
        import {pathToFileURL} from 'node:url';
        const mod = await import(pathToFileURL(path.join(process.env.CODING_WORKTREE, 'value.mjs')));
        assert.equal(mod.value, 42);
        // Checks run under read-only externalRepo Landlock fence; trying to write externalRepo must fail EACCES.
        let blocked = false;
        try {
          fs.writeFileSync(${JSON.stringify(path.join(externalRepo, 'check-escape.txt'))}, 'escape');
        } catch (err) {
          blocked = ['EACCES', 'EPERM', 'EROFS'].includes(err.code);
        }
        assert.equal(blocked, true, 'Registered check must not write externalRepo');
      `);
      pluginConfig.projects.push({
        id: 'external-repo',
        root: externalRepo,
        branch: 'master',
        externalRoot: true,
        allowRemote: true,
        checks: [{name: 'external worktree check', argv: [process.execPath, checkScript]}],
      });
    },
    behavior: async ({cwd, peer}) => {
      // Simulate coding backend running under real Landlock fence (as configured in production launchOptions)
      // and proving it can write inside worktree cwd while direct writes to externalRepo or externalRepo/.git fail.
      const probeScript = `
        const fs = require('fs'), path = require('path');
        for (const target of [
          path.join(${JSON.stringify(externalRepo)}, 'direct-tamper.txt'),
          path.join(${JSON.stringify(externalRepo)}, '.git', 'hook-tamper'),
        ]) {
          try { fs.writeFileSync(target, 'pwn'); }
          catch (err) { process.stdout.write(err.code + '\\n'); }
        }
      `;
      const probe = peer.args;
      void probe;
      // Launch confined subprocess with exact service writeBoundary (same as DSH fence) to verify kernel block.
      const {confinedProcess} = await import('../../packages/coding-runtime/write-fence.js');
      const boundary = peer.args.boundary ?? f.pluginConfig.writeBoundary;
      const confined = confinedProcess(boundary, process.execPath, ['-e', probeScript], cwd);
      const res = spawnSync(confined.command, confined.args, {cwd, env: {...process.env, ...confined.env}, encoding: 'utf8'});
      assert.equal(res.status, 0, res.stderr);
      for (const line of res.stdout.trim().split('\n')) writeProbeErrors.push(line);
      fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 42;\n');
    },
  });

  // Preserve dirty staged, unstaged, and untracked files on externalRepo across full coding lifecycle.
  fs.writeFileSync(path.join(externalRepo, 'notes.txt'), 'unstaged external user note\n');
  fs.writeFileSync(path.join(externalRepo, 'untracked-local.txt'), 'user local untracked\n');
  const before = targetState({root: externalRepo});

  const started = await f.run({action: 'start', projectId: 'external-repo', title: '外部仓库测试', task: 'Update value to 42 on external repo.'});
  const ready = await f.settle(started.id);
  assert.equal(ready.state, 'ready');
  assert.equal(ready.checks.ok, true);
  assert.deepEqual(writeProbeErrors, ['EACCES', 'EACCES']);
  assert.equal(fs.existsSync(path.join(externalRepo, 'direct-tamper.txt')), false);
  assert.equal(fs.existsSync(path.join(externalRepo, '.git', 'hook-tamper')), false);
  assert.deepEqual(targetState({root: externalRepo}), before);

  const preview = await f.run({action: 'preview', taskId: started.id});
  assert.equal(preview.status, 'pending');
  assert.match(preview.previewText, /分支方向：codex\/qq-[a-f0-9]{8} → master（本次合入 1 个提交）/);
  assert.match(preview.previewText, /本次改动：value\.mjs（\+\d+\/-\d+）/);
  assert.match(preview.previewText, /分支领先情况：/);
  assert.match(preview.previewText, /不包含push/);
  assert.doesNotMatch(preview.previewText, /[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/i);
  assert.doesNotMatch(preview.previewText, /\b[a-f0-9]{40,64}\b/i);

  // Before confirmation, merge refuses; externalRepo remains untouched.
  await assert.rejects(f.run({action: 'merge', taskId: started.id, proposalId: preview.proposalId}), /approval_required/);
  assert.equal(git(externalRepo, 'rev-parse', 'HEAD').trim(), baseline);

  f.approve(preview);
  const merged = await f.run({action: 'merge', taskId: started.id, proposalId: preview.proposalId});
  assert.equal(merged.state, 'merged');
  assert.match(fs.readFileSync(path.join(externalRepo, 'value.mjs'), 'utf8'), /value = 42/);
  assert.equal(fs.readFileSync(path.join(externalRepo, 'notes.txt'), 'utf8'), 'unstaged external user note\n');
  assert.equal(fs.readFileSync(path.join(externalRepo, 'untracked-local.txt'), 'utf8'), 'user local untracked\n');
  assert.equal(fs.existsSync(path.join(externalRepo, 'check-escape.txt')), checkTriedExternalWrite);
  // Confirm origin bare remote never received any push or ref update.
  assert.equal(git(bareRemote, 'for-each-ref').trim(), '');
});

test('autoPreview attaches non-developer remote-lead preview directly to ready notification and allows immediate confirmation', async t => {
  const {externalRepo, bareRemote, boundaryRoot} = setupExternalGitProject('ext-autopv');
  assert.equal(spawnSync('/usr/bin/git', ['-C', externalRepo, 'push', '-u', 'origin', 'master']).status, 0);
  fs.writeFileSync(path.join(externalRepo, 'prior.txt'), 'unpushed baseline\n');
  git(externalRepo, 'add', 'prior.txt');
  git(externalRepo, '-c', 'user.name=Dev', '-c', 'user.email=dev@localhost', 'commit', '-m', 'Prior unpushed feature');

  const f = await fixture(t, {
    root: path.join(boundaryRoot, 'root'),
    configure: plugin => {
      plugin.autoPreviewOnReady = true;
      plugin.projects = [{
        id: 'external-repo',
        root: externalRepo,
        branch: 'master',
        externalRoot: true,
        allowRemote: true,
        checks: [{name: 'ok-check', argv: ['/usr/bin/node', '-e', 'process.exit(0)']}],
      }];
    },
    behavior: async ({cwd}) => {
      fs.writeFileSync(path.join(cwd, 'value.mjs'), 'export const value = 7;\n');
    },
  });

  const started = await f.run({action: 'start', projectId: 'external-repo', title: '调整默认数值', task: 'Set value to 7.'});
  const ready = await f.settle(started.id);
  assert.equal(ready.state, 'ready');
  assert.equal(f.deliveries.length, 1);

  const delivered = f.deliveries[0].text;
  assert.match(delivered, /编码任务待确认合入（external-repo）/);
  assert.match(delivered, /任务说明：调整默认数值/);
  assert.match(delivered, /当前本地 master 已领先 origin\/master 1 个提交，合入后将领先 2 个提交（含本次任务；此前未推送提交包含：Prior unpushed feature）/);
  assert.doesNotMatch(delivered, /\b[a-f0-9]{40,64}\b/i);

  const pvRow = f.service.store.latestPreview(started.id);
  assert.ok(pvRow);
  const confirmEvent = f.event('确认');
  core.captureNaturalConfirmationRequest(confirmEvent);
  const proposals = core.listNaturalConfirmations(confirmEvent).filter(p => p.domain === 'coding');
  assert.equal(proposals.length, 1);
  const granted = core.confirmNaturalProposal(confirmEvent, {
    domain: 'coding', proposalId: proposals[0].proposalId, payloadHash: proposals[0].payloadHash,
  });
  assert.equal(granted.ok, true);

  const merged = await f.run({action: 'merge', taskId: started.id, proposalId: proposals[0].proposalId});
  assert.equal(merged.state, 'merged');
  assert.match(fs.readFileSync(path.join(externalRepo, 'value.mjs'), 'utf8'), /value = 7/);
  assert.equal(git(bareRemote, 'rev-list', '--count', 'master').trim(), '1');
});
