// Read-only Git inventory for the local Web console. Every command here is a
// query: this module never creates, removes or switches worktrees or branches.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const run = promisify(execFile);
const TIMEOUT = 5000;
const MAX_BUFFER = 4 * 1024 * 1024;
const env = {...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C', LANG: 'C'};
const home = os.homedir();
const label = value => typeof value !== 'string' ? value
  : value === home ? '~' : value.startsWith(home + path.sep) ? '~/' + value.slice(home.length + 1) : value;
const short = value => value ? value.slice(0, 7) : null;

async function git(root, args) {
  const {stdout} = await run('git', ['-C', root, ...args], {cwd: root, timeout: TIMEOUT, maxBuffer: MAX_BUFFER, env, windowsHide: true});
  return stdout.trim();
}

async function query(root, args) {
  try { return await git(root, args); } catch { return null; }
}

async function ancestor(root, commit, base) {
  try {
    await git(root, ['merge-base', '--is-ancestor', commit, base]);
    return true;
  } catch (error) {
    return error.code === 1 ? false : null;
  }
}

async function distance(root, from, to) {
  const count = Number(await query(root, ['rev-list', '--count', from + '..' + to]));
  return Number.isInteger(count) ? count : null;
}

function parseWorktrees(text) {
  return text.split(/\n\n/u).filter(block => block.trim()).map(block => {
    const row = {};
    for (const line of block.split('\n')) {
      const space = line.indexOf(' ');
      if (space < 0) row[line] = true;
      else row[line.slice(0, space)] = line.slice(space + 1);
    }
    return row;
  });
}

async function commitOf(root) {
  const text = await query(root, ['log', '-1', '--format=%cI%x1f%s']);
  if (!text) return null;
  const [at, subject] = text.split('\x1f');
  return {at: at || null, subject: subject || null};
}

async function worktreeRow(root, base, entry) {
  const dir = entry.worktree;
  const head = entry.HEAD ?? null;
  const exists = typeof dir === 'string' && fs.existsSync(dir);
  const branch = typeof entry.branch === 'string' ? entry.branch.replace(/^refs\/heads\//u, '') : null;
  const [commit, dirty, merged, ahead, behind] = await Promise.all([
    exists ? commitOf(dir) : Promise.resolve(null),
    exists ? query(dir, ['status', '--porcelain', '--untracked-files=normal']).then(value => value === null ? null : value.split('\n').filter(Boolean).length) : Promise.resolve(null),
    head ? ancestor(root, head, base) : Promise.resolve(null),
    head ? distance(root, base, head) : Promise.resolve(null),
    head ? distance(root, head, base) : Promise.resolve(null),
  ]);
  const main = typeof dir === 'string' && path.resolve(dir) === root;
  const missing = !exists;
  return {
    path: dir ?? null, label: label(dir), head: short(head), commit, main,
    branch, detached: !branch && !main, missing, prunable: entry.prunable === true, locked: entry.locked === true,
    dirty, merged, ahead, behind,
    recoverable: !main && !missing && entry.prunable !== true && dirty === 0 && merged === true,
  };
}

function parseBranches(text) {
  return text.split('\n').filter(Boolean).map(line => {
    const [name, head, at, subject, upstream] = line.split('\x00');
    return {name, head, at: at || null, subject: subject || null, upstream: upstream || null};
  });
}

export async function gitOverview({sourceRoot}) {
  const root = path.resolve(sourceRoot);
  let top;
  try { top = await git(root, ['rev-parse', '--show-toplevel']); }
  catch (error) {
    return {available: false, reason: error.code === 'ENOENT' ? 'git_unavailable' : 'not_a_git_repository'};
  }
  const currentBranch = await query(root, ['rev-parse', '--abbrev-ref', 'HEAD']);
  const base = (await query(root, ['rev-parse', '--verify', '--quiet', 'refs/heads/main^{commit}'])) ? 'main' : 'HEAD';
  const [head, worktreeText, branchText] = await Promise.all([
    commitOf(root),
    query(root, ['worktree', 'list', '--porcelain']),
    query(root, ['for-each-ref', 'refs/heads', '--sort=-committerdate',
      '--format=%(refname:short)%00%(objectname:short)%00%(committerdate:iso-strict)%00%(subject)%00%(upstream:short)']),
  ]);
  const worktrees = await Promise.all(parseWorktrees(worktreeText ?? '').map(entry => worktreeRow(root, base, entry)));
  const branches = await Promise.all(parseBranches(branchText ?? '').map(async row => {
    const merged = await ancestor(root, row.name, base);
    const [ahead, behind] = await Promise.all([distance(root, base, row.name), distance(root, row.name, base)]);
    const holder = worktrees.find(worktree => worktree.branch === row.name) ?? null;
    return {...row, merged, ahead, behind, current: row.name === currentBranch,
      worktree: holder?.path ?? null, worktreeLabel: holder?.label ?? null};
  }));
  const detached = worktrees.filter(worktree => worktree.detached);
  return {
    available: true, generatedAt: new Date().toISOString(),
    root: {path: top || root, label: label(top || root), base},
    current: {branch: currentBranch === 'HEAD' ? null : currentBranch, detached: currentBranch === 'HEAD',
      head: short((await query(root, ['rev-parse', 'HEAD'])) ?? ''), commit: head},
    counts: {
      branches: branches.length, worktrees: worktrees.length, detachedWorktrees: detached.length,
      dirtyWorktrees: worktrees.filter(worktree => (worktree.dirty ?? 0) > 0).length,
      missingWorktrees: worktrees.filter(worktree => worktree.missing).length,
      unmergedBranches: branches.filter(branch => branch.merged === false).length,
      recoverableWorktrees: worktrees.filter(worktree => worktree.recoverable).length,
    },
    worktrees, branches,
  };
}
