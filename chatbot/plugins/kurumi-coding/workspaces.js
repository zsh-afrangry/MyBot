// Operator-selected Git sources and task-local worktrees. No network or model-provided argv.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {processIdentity, sameProcess, descendants} from '../../packages/coding-runtime/acp-client.js';
import {validateWriteFence, confinedProcess} from '../../packages/coding-runtime/write-fence.js';
import {digest, fail} from './policy.js';
import {directoryState, copyDirectory} from './directory-workspaces.js';

export function executionEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null'};
}
export function git(cwd, ...args) {
  const r = spawnSync('/usr/bin/git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false', ...args], {cwd, env: executionEnv(), encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
  if (r.status !== 0) throw fail('git_operation_failed');
  return r.stdout;
}
const inside = (a, b) => a === b || a.startsWith(b + '/');
function canonical(file) {
  if (typeof file !== 'string' || !path.isAbsolute(file) || path.resolve(file) !== file) throw fail('invalid_coding_paths');
  let ancestor = file;
  while (!fs.existsSync(ancestor)) ancestor = path.dirname(ancestor);
  if (fs.realpathSync(ancestor) !== ancestor) throw fail('invalid_coding_paths');
}
export function projectPolicy(config) {
  // Pilot projects require an explicit operator-owned filesystem write boundary.
  if (config.pilot !== true || !Array.isArray(config.projects) || !config.projects.length) throw fail('coding_pilot_not_configured');
  validateWriteFence(config.writeBoundary);
  canonical(config.root); canonical(config.worktrees);
  for (const file of [config.root, config.worktrees, ...config.projects.map(p => p.root)]) {
    if (!inside(file, config.writeBoundary.root) || file === config.writeBoundary.root) throw fail('coding_paths_outside_write_boundary');
  }
  for (const protectedPath of ['/home/afrangry/.openclaw-fusion', '/home/afrangry/kurumi-fusion', '/home/afrangry/kurumi-archive', '/home/afrangry/.npm-global', '/opt/deepseek-harness']) {
    if (inside(protectedPath, config.writeBoundary.root) || inside(config.writeBoundary.root, protectedPath)) throw fail('protected_write_boundary');
  }
  if (inside(config.root, config.worktrees) || inside(config.worktrees, config.root)) throw fail('overlapping_coding_paths');
  if (!config.dsh || typeof config.dsh.command !== 'string' || !path.isAbsolute(config.dsh.command)
    || !fs.statSync(config.dsh.command).isFile() || !path.isAbsolute(config.dsh.home ?? '') || !fs.statSync(config.dsh.home).isDirectory()
    || !Array.isArray(config.dsh.model) || config.dsh.model.length !== 2 || config.dsh.model.some(v => typeof v !== 'string' || !v || v.length > 100)) throw fail('invalid_dsh_config');
  const ids = new Set();
  for (const p of config.projects) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || ids.has(p.id)) throw fail('invalid_project_id');
    ids.add(p.id); canonical(p.root);
    if (p.kind !== undefined && !['git', 'directory'].includes(p.kind)) throw fail('invalid_project_kind');
    if (p.kind === 'directory') {
      directoryState(p.root);
      if (spawnSync('/usr/bin/git', ['-C', p.root, 'rev-parse', '--show-toplevel'], {env: executionEnv(), stdio: 'ignore'}).status === 0) throw fail('directory_is_inside_git');
    } else {
      if (git(p.root, 'rev-parse', '--show-toplevel').trim() !== p.root) throw fail('invalid_project_root');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(p.branch ?? '')) throw fail('invalid_project_branch');
      git(p.root, 'rev-parse', '--verify', `refs/heads/${p.branch}^{commit}`);
      if (git(p.root, 'remote').trim() || fs.existsSync(path.join(p.root, '.gitmodules'))) throw fail('pilot_requires_synthetic_local_repository');
    }
    if (!Array.isArray(p.checks) || !p.checks.length || p.checks.some(c => !/^[\w .-]{1,100}$/.test(c.name ?? '') || !Array.isArray(c.argv) || !path.isAbsolute(c.argv[0] ?? '') || c.argv.some(a => typeof a !== 'string' || a.includes('\0'))
      || (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs <= 0))
      || (c.skipExitCode !== undefined && (!Number.isSafeInteger(c.skipExitCode) || c.skipExitCode < 1 || c.skipExitCode > 255)))) throw fail('invalid_project_checks');
    for (const protectedPath of [config.root, config.worktrees, config.dsh.home, '/home/afrangry/.openclaw-fusion', '/home/afrangry/kurumi-archive', '/home/afrangry/.npm-global']) {
      if (inside(p.root, protectedPath) || inside(protectedPath, p.root)) throw fail('protected_project_root');
    }
  }
}
export function createWorkspace(config, project, id) {
  fs.mkdirSync(config.worktrees, {recursive: true, mode: 0o700});
  const cwd = path.join(config.worktrees, id), branch = `codex/qq-${id}`;
  if (project.kind === 'directory') {
    const directoryBaseline = directoryState(project.root);
    copyDirectory(project.root, cwd, directoryBaseline);
    git(cwd, 'init', '-b', branch); git(cwd, 'add', '-f', '-A', '--', '.');
    git(cwd, '-c', 'user.name=Kurumi', '-c', 'user.email=kurumi@localhost', 'commit', '--allow-empty', '-m', 'Private experiment baseline');
    if (JSON.stringify(directoryState(project.root)) !== JSON.stringify(directoryBaseline)) throw fail('directory_changed_during_copy');
    const base = git(cwd, 'rev-parse', 'HEAD').trim();
    return {cwd, branch, base, verifiedCommit: base, workspaceKind: 'directory', directoryBaseline};
  }
  const base = git(project.root, 'rev-parse', `refs/heads/${project.branch}`).trim();
  git(project.root, 'worktree', 'add', '-b', branch, cwd, base);
  return {cwd, branch, base, verifiedCommit: base};
}
// Validate the actual current location/repository, independently of check commands or backend settings.
export function assertTaskLocation(config, project, task) {
  for (const file of [config.root, config.worktrees, project.root, task.cwd]) {
    canonical(file);
    if (!inside(file, config.writeBoundary.root) || file === config.writeBoundary.root) throw fail('coding_paths_outside_write_boundary');
  }
  if (task.cwd !== path.join(config.worktrees, task.id) || task.branch !== `codex/qq-${task.id}`) throw fail('task_workspace_changed');
  if (project.kind === 'directory') {
    if (task.workspaceKind !== 'directory' || !Array.isArray(task.directoryBaseline)) throw fail('task_project_changed');
    if (!fs.statSync(project.root).isDirectory()) throw fail('task_project_changed');
    if (fs.realpathSync(git(task.cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim()) !== path.join(task.cwd, '.git')) throw fail('task_project_changed');
  } else {
    if (task.workspaceKind === 'directory') throw fail('task_project_changed');
    assertRepository(project, task.cwd);
  }
}
export function assertCandidateLocation(config, project, cwd, task) {
  canonical(cwd);
  if (path.dirname(cwd) !== config.worktrees || !/^candidate-[a-f0-9-]{36}$/.test(path.basename(cwd))) throw fail('candidate_workspace_changed');
  if (project.kind === 'directory') {
    assertTaskLocation(config, project, task); assertRepository({root: task.cwd}, cwd);
  } else assertRepository(project, cwd);
}
function assertRepository(project, cwd) {
  if (git(cwd, 'rev-parse', '--show-toplevel').trim() !== cwd) throw fail('task_workspace_changed');
  const common = root => fs.realpathSync(git(root, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim());
  if (common(project.root) !== common(cwd)) throw fail('task_project_changed');
}
export function assertWorkspace(task) {
  if (fs.realpathSync(task.cwd) !== task.cwd || git(task.cwd, 'rev-parse', '--show-toplevel').trim() !== task.cwd
    || git(task.cwd, 'symbolic-ref', '--short', 'HEAD').trim() !== task.branch) throw fail('task_workspace_changed');
  if (git(task.cwd, 'rev-parse', 'HEAD').trim() !== task.verifiedCommit) throw fail('unexpected_task_commit');
}
export async function runChecks(project, cwd, file, signal, boundary, onRuntime = () => {}) {
  const rows = [];
  for (const check of project.checks) {
    signal?.throwIfAborted();
    const started = Date.now();
    const result = await new Promise((resolve, reject) => {
      const out = fs.createWriteStream(file, {flags: 'a', mode: 0o600});
      const confined = boundary ? confinedProcess(boundary, check.argv[0], check.argv.slice(1), cwd) : {command: check.argv[0], args: check.argv.slice(1), env: {}};
      const child = spawn(confined.command, confined.args, {cwd, env: {...executionEnv(), ...confined.env, CODING_WORKTREE: cwd}, detached: true, stdio: ['ignore', 'pipe', 'pipe']});
      const identity = processIdentity(child.pid);
      const publish = () => {
        if (sameProcess(identity)) onRuntime({identity: processIdentity(identity.pid), processes: descendants(identity.pid).filter(sameProcess)});
      };
      publish();
      const monitor = setInterval(publish, 500); monitor.unref();
      let killed = false, timedOut = false, captured = [], hard;
      const kill = () => {
        if (killed) return;
        killed = true; captured = sameProcess(identity) ? descendants(identity.pid) : [];
        const send = sig => {
          if (sameProcess(identity)) try {process.kill(-identity.pid, sig);} catch (e) {if (e.code !== 'ESRCH') reject(e);}
          for (const p of captured) if (sameProcess(p)) try {process.kill(p.pid, sig);} catch (e) {if (e.code !== 'ESRCH') reject(e);}
        };
        send('SIGTERM'); hard = setTimeout(() => send('SIGKILL'), 1500);
      };
      child.stdout.pipe(out, {end: false}); child.stderr.pipe(out, {end: false});
      const timer = check.timeoutMs ? setTimeout(() => {timedOut = true; kill();}, check.timeoutMs) : undefined;
      signal?.addEventListener('abort', kill, {once: true});
      if (signal?.aborted) kill();
      const cleanup = () => {clearTimeout(timer); clearTimeout(hard); clearInterval(monitor); signal?.removeEventListener('abort', kill);};
      out.on('error', e => {kill(); reject(e);});
      child.once('error', e => {cleanup(); out.end(); reject(e);});
      child.once('close', async (code, sig) => {
        cleanup(); out.end();
        for (let i = 0; i < 20 && captured.some(sameProcess); i++) {
          if (i === 10) for (const p of captured) if (sameProcess(p)) try {process.kill(p.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') reject(e);}
          await delay(100);
        }
        if (captured.every(p => !sameProcess(p))) onRuntime(undefined);
        resolve({code, signal: sig, ...(timedOut ? {timedOut: true} : {}), ...(killed ? {stopped: captured.every(p => !sameProcess(p))} : {})});
      });
    });
    const skipped = check.skipExitCode !== undefined && result.code === check.skipExitCode && !result.timedOut;
    rows.push({name: check.name, ...result, ...(skipped ? {skipped: true} : {}), elapsedMs: Date.now() - started});
    if (result.stopped === false) throw fail('check_cancel_not_verified');
    signal?.throwIfAborted();
    if ((!skipped && result.code !== 0) || result.timedOut) break;
  }
  return {ok: rows.length === project.checks.length && rows.some(r => !r.skipped) && rows.every(r => (r.skipped || r.code === 0) && !r.timedOut), rows};
}
function fileFacts(cwd, names) {
  return names.map(name => {
    const source = path.join(cwd, name);
    try {
      const stat = fs.lstatSync(source);
      return {name, mode: stat.mode & 0o777, ...(stat.isSymbolicLink() ? {symlink: fs.readlinkSync(source)} : stat.isFile() ? {hash: digest(fs.readFileSync(source))} : {kind: 'directory'})};
    } catch (e) {if (e.code !== 'ENOENT') throw e; return {name, deleted: true};}
  });
}
export function targetState(project) {
  const cwd = project.root;
  const names = [...new Set([...git(cwd, 'diff', '--name-only', '-z', 'HEAD', '--').split('\0'), ...git(cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort();
  return {head: git(cwd, 'rev-parse', 'HEAD').trim(), branch: git(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    status: git(cwd, 'status', '--porcelain=v1', '-z'), diff: digest(git(cwd, 'diff', '--binary', 'HEAD', '--')), files: fileFacts(cwd, names)};
}
export const workingHash = cwd => digest(JSON.stringify(targetState({root: cwd})));
export function assertDirtyPreserved(project, state) {
  if (JSON.stringify(fileFacts(project.root, state.files.map(f => f.name))) !== JSON.stringify(state.files)) throw fail('target_dirty_state_changed');
}
export function snapshot(task, directory) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(directory, 'tracked.patch'), git(task.cwd, 'diff', '--binary', 'HEAD', '--'), {mode: 0o600});
  const files = git(task.cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean), index = [];
  for (const name of files) {
    const source = path.join(task.cwd, name), stat = fs.lstatSync(source);
    if (stat.isSymbolicLink()) index.push({name, symlink: fs.readlinkSync(source)});
    else if (stat.isFile()) {
      const key = digest(name); fs.copyFileSync(source, path.join(directory, key)); fs.chmodSync(path.join(directory, key), 0o600);
      index.push({name, file: key, mode: stat.mode & 0o777});
    }
  }
  fs.writeFileSync(path.join(directory, 'untracked.json'), JSON.stringify(index), {mode: 0o600});
  return directory;
}
export function rollbackUnit(task) {
  assertWorkspace(task);
  git(task.cwd, 'reset', '--hard', task.verifiedCommit);
  git(task.cwd, 'clean', '-fd', '--');
}
export function commitUnit(task, checkedHash) {
  assertWorkspace(task);
  if (workingHash(task.cwd) !== checkedHash) throw fail('checked_tree_changed');
  if (!git(task.cwd, 'status', '--porcelain=v1').trim()) return task.verifiedCommit;
  git(task.cwd, 'add', '-A', '--', '.');
  git(task.cwd, '-c', 'user.name=Kurumi', '-c', 'user.email=kurumi@localhost', 'commit', '-m', `Verified coding task ${task.id}`);
  return git(task.cwd, 'rev-parse', 'HEAD').trim();
}

export function assertNoUntrackedOverwrite(project, baseline, candidate) {
  const tracked = new Set(git(project.root, 'ls-files', '-z').split('\0'));
  for (const file of git(project.root, 'diff', '--name-only', '-z', baseline, candidate, '--').split('\0').filter(Boolean)) {
    if (tracked.has(file)) continue;
    try {fs.lstatSync(path.join(project.root, file));} catch (e) {if (e.code === 'ENOENT') continue; throw e;}
    throw fail('target_untracked_overlap');
  }
}
