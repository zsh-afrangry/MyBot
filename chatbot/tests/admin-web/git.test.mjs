// Offline Git inventory checks: temporary repositories only, no network and no
// writes to the real checkout.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {execFileSync} from 'node:child_process';
import {gitOverview} from '../../admin-web/git.mjs';
import {fixture} from './fixture.mjs';

const identity = root => ({...process.env, HOME: root, GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0',
  GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.com',
  GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.com'});

function makeRepo(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-git-test-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  const git = (...args) => execFileSync('git', args, {cwd: repo, env: identity(root), encoding: 'utf8'});
  git('init', '--quiet');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'init');
  git('checkout', '--quiet', '-b', 'feature');
  fs.writeFileSync(path.join(repo, 'feature.txt'), 'feature\n');
  git('add', '-A'); git('commit', '--quiet', '-m', 'feature commit');
  git('checkout', '--quiet', 'main');
  return {root, repo, git};
}

test('git overview reports worktrees, branches, dirt and recoverability without writing', async t => {
  const {root, repo, git} = makeRepo(t);
  const worktree = path.join(root, 'feature-wt');
  git('worktree', 'add', '--quiet', worktree, 'feature');
  const first = await gitOverview({sourceRoot: repo});
  assert.equal(first.available, true);
  assert.equal(first.root.base, 'main');
  assert.equal(first.counts.branches, 2);
  assert.equal(first.counts.worktrees, 2);
  assert.equal(first.counts.unmergedBranches, 1);
  const feature = first.worktrees.find(row => row.branch === 'feature');
  assert.equal(feature.main, false);
  assert.equal(feature.detached, false);
  assert.equal(feature.dirty, 0);
  assert.equal(feature.ahead, 1);
  assert.equal(feature.merged, false);
  assert.equal(feature.recoverable, false);
  assert.equal(first.worktrees.find(row => row.main).head, first.branches.find(row => row.current).head);

  git('merge', '--quiet', '--ff-only', 'feature');
  const merged = await gitOverview({sourceRoot: repo});
  const clean = merged.worktrees.find(row => row.branch === 'feature');
  assert.equal(clean.merged, true);
  assert.equal(clean.ahead, 0);
  assert.equal(clean.recoverable, true);
  assert.equal(merged.counts.recoverableWorktrees, 1);
  assert.equal(merged.counts.unmergedBranches, 0);

  fs.writeFileSync(path.join(worktree, 'feature.txt'), 'dirty\n');
  const dirty = await gitOverview({sourceRoot: repo});
  const changed = dirty.worktrees.find(row => row.branch === 'feature');
  assert.equal(changed.dirty, 1);
  assert.equal(changed.recoverable, false);
  assert.equal(dirty.counts.dirtyWorktrees, 1);

  fs.rmSync(worktree, {recursive: true, force: true});
  const missing = await gitOverview({sourceRoot: repo});
  const gone = missing.worktrees.find(row => row.branch === 'feature');
  assert.equal(gone.missing, true);
  assert.equal(gone.recoverable, false);
  assert.equal(gone.dirty, null);
  assert.equal(missing.counts.missingWorktrees, 1);

  assert.equal(git('rev-parse', '--abbrev-ref', 'HEAD').trim(), 'main');
  assert.match(git('worktree', 'list', '--porcelain'), /feature-wt/u);
});

test('a directory without Git reports unavailable instead of failing', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-git-none-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const data = await gitOverview({sourceRoot: root});
  assert.equal(data.available, false);
  assert.equal(data.reason, 'not_a_git_repository');
});

test('the console exposes Git state only after login', async t => {
  const f = await fixture();
  t.after(() => f.close());
  assert.equal((await f.call('/api/git')).status, 401);
  const api = await f.session();
  const before = await api('/git');
  assert.equal(before.status, 200);
  assert.equal(before.body.available, false);
  const git = (...args) => execFileSync('git', args, {cwd: f.source, env: identity(f.root), encoding: 'utf8'});
  git('init', '--quiet');
  git('symbolic-ref', 'HEAD', 'refs/heads/main');
  git('add', '-A'); git('commit', '--quiet', '-m', 'fixture source');
  const after = await api('/git');
  assert.equal(after.status, 200);
  assert.equal(after.body.available, true);
  assert.equal(after.body.current.branch, 'main');
  assert.equal(after.body.worktrees[0].main, true);
  assert.equal(after.body.worktrees[0].dirty, 0);
  assert.equal(after.body.branches.find(row => row.current).name, 'main');
});
