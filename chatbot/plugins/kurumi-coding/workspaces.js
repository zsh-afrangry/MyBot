// Operator-selected Git sources and task-local worktrees. No network or model-provided argv.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync, spawn} from 'node:child_process';
import {setTimeout as delay} from 'node:timers/promises';
import {processIdentity, sameProcess, descendants} from '../../packages/coding-runtime/acp-client.js';
import {validateWriteFence, confinedProcess} from '../../packages/coding-runtime/write-fence.js';
import {digest, fail} from './policy.js';
import {directoryState, copyDirectory} from './directory-workspaces.js';
import {validateBackends} from './backends.js';

export function executionEnv() {
  const env = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'TMPDIR', 'XDG_CACHE_HOME', 'SSL_CERT_FILE', 'SSL_CERT_DIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return {...env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_OPTIONAL_LOCKS: '0'};
}
export const DEFAULT_SELF_MAINTENANCE_PROTECTED_PATHS = Object.freeze([
  '.openclaw-fusion',
  '.git',
  'config/access-control.json',
  'config/runtime.config.json',
]);

export function assertSelfMaintenanceCandidateSafe(project, roGit, diffBase, candidate, candidateDir) {
  if (project?.selfMaintenance !== true) return;
  const protectedList = [...new Set([
    ...DEFAULT_SELF_MAINTENANCE_PROTECTED_PATHS,
    ...(Array.isArray(project.protectedPaths) ? project.protectedPaths : []),
  ])];
  const rawNames = roGit(candidateDir, 'diff', '--no-ext-diff', '--name-only', '-z', diffBase, candidate, '--')
    .split('\0').filter(Boolean);
  for (const rel of rawNames) {
    const posixRel = rel.replaceAll('\\', '/');
    if (posixRel.split('/').includes('.openclaw-fusion')) throw fail('self_maintenance_protected_diff');
    if (protectedList.some(prefix => posixRel === prefix || posixRel.startsWith(prefix.replace(/\/+$/u, '') + '/'))) {
      throw fail('self_maintenance_protected_diff');
    }
    const candidateFile = path.join(candidateDir, rel);
    try {
      const lst = fs.lstatSync(candidateFile);
      if (lst.isSymbolicLink()) {
        const target = fs.readlinkSync(candidateFile);
        const resolved = path.resolve(path.dirname(candidateFile), target);
        if (!inside(resolved, candidateDir) || resolved.includes('.openclaw-fusion')) {
          throw fail('self_maintenance_protected_diff');
        }
      }
    } catch (error) {
      if (error?.code === 'self_maintenance_protected_diff') throw error;
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export function isExternalProject(config, project) {
  return Boolean(project?.externalRoot) && !inside(project.root, config.writeBoundary.root);
}
export function gitBoundaryFor(config, project, mode = 'readonly') {
  if (!isExternalProject(config, project) || mode === 'readonly') return config.writeBoundary;
  if (mode === 'worktree') {
    return {
      ...config.writeBoundary,
      additionalRoots: [...(config.writeBoundary.additionalRoots ?? []), path.join(project.root, '.git')],
    };
  }
  if (mode === 'merge') {
    return {
      ...config.writeBoundary,
      additionalRoots: [...(config.writeBoundary.additionalRoots ?? []), project.root],
    };
  }
  throw fail('invalid_git_boundary_mode');
}
export function projectGit(config, project, mode = 'readonly') {
  const boundary = gitBoundaryFor(config, project, mode);
  const external = isExternalProject(config, project);
  return (cwd, ...args) => {
    if (external && cwd === project.root && mode !== 'merge') {
      const anchor = fs.existsSync(config.worktrees) ? config.worktrees : config.root;
      return fencedGit(boundary, anchor, '-C', project.root, ...args);
    }
    return fencedGit(boundary, cwd, ...args);
  };
}
export function git(cwd, ...args) {
  return runGit(cwd, args);
}
export function fencedGit(boundary, cwd, ...args) {
  return runGit(cwd, args, boundary);
}
function runGit(cwd, args, boundary) {
  const options = ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'commit.gpgSign=false',
    '-c', 'protocol.allow=never', ...args];
  const command = boundary ? confinedProcess(boundary, '/usr/bin/git', options, cwd) : {command: '/usr/bin/git', args: options, env: {}};
  const r = spawnSync(command.command, command.args, {cwd, env: {...executionEnv(), ...command.env}, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024});
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
  // Pilot projects require an explicit operator-owned filesystem write boundary; external Git repos opt in explicitly.
  if (config?.pilot !== true || !Array.isArray(config.projects)) throw fail('coding_pilot_not_configured');
  validateWriteFence(config.writeBoundary);
  canonical(config.root); canonical(config.worktrees);
  for (const file of [config.root, config.worktrees]) {
    if (!inside(file, config.writeBoundary.root) || file === config.writeBoundary.root) throw fail('coding_paths_outside_write_boundary');
  }
  for (const p of config.projects) {
    if (p.externalRoot !== undefined && typeof p.externalRoot !== 'boolean') throw fail('invalid_project_flags');
    if (p.allowRemote !== undefined && typeof p.allowRemote !== 'boolean') throw fail('invalid_project_flags');
    if (p.selfMaintenance !== undefined && typeof p.selfMaintenance !== 'boolean') throw fail('invalid_project_flags');
    if (p.protectedPaths !== undefined && (!Array.isArray(p.protectedPaths) || p.protectedPaths.some(item => typeof item !== 'string' || !item || path.isAbsolute(item) || item.includes('\0') || item.split('/').includes('..')))) {
      throw fail('invalid_project_flags');
    }
    canonical(p.root);
    if (p.selfMaintenance === true && p.externalRoot !== true) throw fail('self_maintenance_requires_external_root');
    if (p.externalRoot === true) {
      if (p.kind === 'directory') throw fail('external_directory_project_not_allowed');
      if (inside(config.writeBoundary.root, p.root) || inside(p.root, config.writeBoundary.root)) {
        if (!inside(p.root, config.writeBoundary.root) || p.root === config.writeBoundary.root) throw fail('overlapping_coding_paths');
      }
    } else if (!inside(p.root, config.writeBoundary.root) || p.root === config.writeBoundary.root) {
      throw fail('coding_paths_outside_write_boundary');
    }
  }
  for (const protectedPath of ['/home/afrangry/.openclaw-fusion', '/home/afrangry/kurumi-fusion', '/home/afrangry/kurumi-archive', '/home/afrangry/.npm-global', '/opt/deepseek-harness']) {
    if (inside(protectedPath, config.writeBoundary.root) || inside(config.writeBoundary.root, protectedPath)) throw fail('protected_write_boundary');
  }
  if (inside(config.root, config.worktrees) || inside(config.worktrees, config.root)) throw fail('overlapping_coding_paths');
  if (!config.dsh || typeof config.dsh.command !== 'string' || !path.isAbsolute(config.dsh.command)
    || !fs.statSync(config.dsh.command).isFile() || !path.isAbsolute(config.dsh.home ?? '') || !fs.statSync(config.dsh.home).isDirectory()
    || !Array.isArray(config.dsh.model) || config.dsh.model.length !== 2 || config.dsh.model.some(v => typeof v !== 'string' || !v || v.length > 100)) throw fail('invalid_dsh_config');
  validateBackends(config);
  const ids = new Set(), roots = [];
  for (const p of config.projects) {
    if (!/^[a-z][a-z0-9-]{0,39}$/.test(p.id) || ids.has(p.id)) throw fail('invalid_project_id');
    ids.add(p.id); canonical(p.root);
    if (p.registrationId !== undefined && (typeof p.registrationId !== 'string'
      || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(p.registrationId))) throw fail('invalid_project_registration');
    if (roots.some(root => inside(root, p.root) || inside(p.root, root))) throw fail('overlapping_project_roots');
    roots.push(p.root);
    const protectedPaths = [
      config.root, config.worktrees, config.dsh.home,
      '/home/afrangry/.openclaw-fusion', '/home/afrangry/kurumi-archive', '/home/afrangry/.npm-global', '/opt/deepseek-harness',
      ...(p.selfMaintenance === true ? [] : ['/home/afrangry/kurumi-fusion']),
    ];
    for (const protectedPath of protectedPaths) {
      if (inside(p.root, protectedPath) || inside(protectedPath, p.root)) throw fail('protected_project_root');
    }
    if (p.kind !== undefined && !['git', 'directory'].includes(p.kind)) throw fail('invalid_project_kind');
    if (p.kind === 'directory') {
      directoryState(p.root);
      if (spawnSync('/usr/bin/git', ['-C', p.root, 'rev-parse', '--show-toplevel'], {env: executionEnv(), stdio: 'ignore'}).status === 0) throw fail('directory_is_inside_git');
    } else {
      const dotGit = path.join(p.root, '.git');
      if (!fs.lstatSync(dotGit, {throwIfNoEntry: false})?.isDirectory()
        || git(p.root, 'rev-parse', '--path-format=absolute', '--git-common-dir').trim() !== dotGit) throw fail('invalid_project_root');
      if (git(p.root, 'rev-parse', '--show-toplevel').trim() !== p.root) throw fail('invalid_project_root');
      if (!/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(p.branch ?? '')) throw fail('invalid_project_branch');
      git(p.root, 'rev-parse', '--verify', `refs/heads/${p.branch}^{commit}`);
      if (fs.existsSync(path.join(p.root, '.gitmodules'))) throw fail('pilot_requires_synthetic_local_repository');
      if (p.allowRemote !== true && git(p.root, 'remote').trim()) throw fail('pilot_requires_synthetic_local_repository');
    }
    if (!Array.isArray(p.checks) || !p.checks.length || p.checks.some(c => !/^[\w .-]{1,100}$/.test(c.name ?? '') || !Array.isArray(c.argv) || !path.isAbsolute(c.argv[0] ?? '') || c.argv.some(a => typeof a !== 'string' || a.includes('\0'))
      || (c.timeoutMs !== undefined && (!Number.isSafeInteger(c.timeoutMs) || c.timeoutMs <= 0))
      || (c.skipExitCode !== undefined && (!Number.isSafeInteger(c.skipExitCode) || c.skipExitCode < 1 || c.skipExitCode > 255)))) throw fail('invalid_project_checks');
  }
}
export function createWorkspace(config, project, id) {
  fs.mkdirSync(config.worktrees, {recursive: true, mode: 0o700});
  const cwd = path.join(config.worktrees, id), branch = `codex/qq-${id}`;
  const run = projectGit(config, project, 'worktree');
  if (project.kind === 'directory') {
    const directoryBaseline = directoryState(project.root);
    copyDirectory(project.root, cwd, directoryBaseline);
    run(cwd, 'init', '-b', branch); run(cwd, 'add', '-f', '-A', '--', '.');
    run(cwd, '-c', 'user.name=Kurumi', '-c', 'user.email=kurumi@localhost', 'commit', '--allow-empty', '-m', 'Private experiment baseline');
    if (JSON.stringify(directoryState(project.root)) !== JSON.stringify(directoryBaseline)) throw fail('directory_changed_during_copy');
    const base = git(cwd, 'rev-parse', 'HEAD').trim();
    return {cwd, branch, base, verifiedCommit: base, workspaceKind: 'directory', directoryBaseline};
  }
  const base = git(project.root, 'rev-parse', `refs/heads/${project.branch}`).trim();
  run(project.root, 'worktree', 'add', '-b', branch, cwd, base);
  return {cwd, branch, base, verifiedCommit: base};
}
// Validate the actual current location/repository, independently of check commands or backend settings.
export function assertTaskLocation(config, project, task) {
  if (task.projectRegistrationId !== project.registrationId
    || (task.projectRoot !== undefined && task.projectRoot !== project.root)) throw fail('task_project_changed');
  if (project.externalRoot === true) {
    canonical(project.root);
    if (inside(config.writeBoundary.root, project.root)) throw fail('overlapping_coding_paths');
  }
  const checkedPaths = project.externalRoot === true
    ? [config.root, config.worktrees, task.cwd]
    : [config.root, config.worktrees, project.root, task.cwd];
  for (const file of checkedPaths) {
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
export function targetState(project, gitRun = git) {
  const cwd = project.root;
  const names = [...new Set([...gitRun(cwd, 'diff', '--no-ext-diff', '--name-only', '-z', 'HEAD', '--').split('\0'), ...gitRun(cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0')].filter(Boolean))].sort();
  return {head: gitRun(cwd, 'rev-parse', 'HEAD').trim(), branch: gitRun(cwd, 'rev-parse', '--abbrev-ref', 'HEAD').trim(),
    status: gitRun(cwd, 'status', '--porcelain=v1', '-z'), diff: digest(gitRun(cwd, 'diff', '--no-ext-diff', '--binary', 'HEAD', '--')), files: fileFacts(cwd, names)};
}
export const workingHash = (cwd, gitRun) => digest(JSON.stringify(targetState({root: cwd}, gitRun)));
export function assertDirtyPreserved(project, state) {
  if (JSON.stringify(fileFacts(project.root, state.files.map(f => f.name))) !== JSON.stringify(state.files)) throw fail('target_dirty_state_changed');
}
export function snapshot(task, directory, gitRun = git) {
  fs.mkdirSync(directory, {recursive: true, mode: 0o700});
  fs.writeFileSync(path.join(directory, 'tracked.patch'), gitRun(task.cwd, 'diff', '--no-ext-diff', '--binary', 'HEAD', '--'), {mode: 0o600});
  const files = gitRun(task.cwd, 'ls-files', '--others', '--exclude-standard', '-z').split('\0').filter(Boolean), index = [];
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
export function rollbackUnit(task, gitRun = git) {
  assertWorkspace(task);
  gitRun(task.cwd, 'reset', '--hard', task.verifiedCommit);
  gitRun(task.cwd, 'clean', '-fd', '--');
}
export function commitUnit(task, checkedHash, gitRun = git) {
  assertWorkspace(task);
  if (workingHash(task.cwd, gitRun) !== checkedHash) throw fail('checked_tree_changed');
  if (!gitRun(task.cwd, 'status', '--porcelain=v1').trim()) return task.verifiedCommit;
  gitRun(task.cwd, 'add', '-A', '--', '.');
  gitRun(task.cwd, '-c', 'user.name=Kurumi', '-c', 'user.email=kurumi@localhost', 'commit', '-m', `Verified coding task ${task.id}`);
  return gitRun(task.cwd, 'rev-parse', 'HEAD').trim();
}

export function assertNoUntrackedOverwrite(project, baseline, candidate, gitRun = git) {
  const tracked = new Set(gitRun(project.root, 'ls-files', '-z').split('\0'));
  for (const file of gitRun(project.root, 'diff', '--no-ext-diff', '--name-only', '-z', baseline, candidate, '--').split('\0').filter(Boolean)) {
    if (tracked.has(file)) continue;
    try {fs.lstatSync(path.join(project.root, file));} catch (e) {if (e.code === 'ENOENT') continue; throw e;}
    throw fail('target_untracked_overlap');
  }
}
