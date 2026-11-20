// Select only operator-configured local backends and prepare their write fences.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {AcpClient} from '../../packages/coding-runtime/acp-client.js';
import {CodexClient} from '../../packages/coding-runtime/codex-client.js';
import {confinedProcess, fencedDirectory} from '../../packages/coding-runtime/write-fence.js';
import {fail} from './policy.js';

export const DSH = 'dsh-acp', CODEX = 'codex-app-server';
export const availableBackends = config => config.codex === undefined ? [DSH] : [DSH, CODEX];
export const taskBackend = task => task.backend ?? DSH;
export function selectBackend(config, backend = DSH) {
  if (![DSH, CODEX].includes(backend)) throw fail('unknown_coding_backend');
  if (!availableBackends(config).includes(backend)) throw fail('coding_backend_not_enabled');
  return backend;
}
export function validateCodex(config) {
  if (config.codex === undefined) return;
  const {command, model} = config.codex ?? {};
  const home = path.join(config.root, 'backend', 'codex-home');
  const stat = fs.statSync(home, {throwIfNoEntry: false});
  const root = config.writeBoundary.root;
  if (typeof command !== 'string' || !path.isAbsolute(command) || path.resolve(command) !== command
    || command.startsWith(root + path.sep) || !fs.statSync(command, {throwIfNoEntry: false})?.isFile()
    || !stat?.isDirectory() || fs.realpathSync(home) !== home || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()
    || fs.realpathSync(command).startsWith(root + path.sep)
    || (model !== undefined && (typeof model !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,99}$/i.test(model)))) throw fail('invalid_codex_config');
  return {command, home, model};
}

export function launchOptions(config, task, directory, env) {
  const backend = selectBackend(config, taskBackend(task));
  if (backend === CODEX) {
    const {home, command, model} = validateCodex(config);
    // The app server can persist its threads in a dedicated home. Its own workspace-write policy
    // limits commands to the task; the inherited fence also denies writes to the project and task ledger.
    const boundary = {root: home, additionalRoots: [task.cwd], launcher: config.writeBoundary.launcher};
    const probe = confinedProcess(boundary, command, ['sandbox', '-P', ':workspace', '--cd', task.cwd, '--', '/usr/bin/true'], task.cwd);
    const sandbox = spawnSync(probe.command, probe.args, {cwd: task.cwd, env: {...env, ...probe.env, HOME: home, CODEX_HOME: home},
      stdio: 'ignore', timeout: 5000});
    if (sandbox.status !== 0) throw fail('codex_sandbox_unavailable');
    const confined = confinedProcess(boundary, command, ['app-server', '--listen', 'stdio://',
      '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', '-c', 'allow_login_shell=false',
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]'], task.cwd);
    return {backend, model, boundary, client: {...confined, cwd: task.cwd, codexHome: home,
      env: {...env, ...confined.env, HOME: home, CODEX_HOME: home}, stderrFile: path.join(directory, 'codex.stderr')}};
  }

  const {command, home, model} = config.dsh;
  const boundary = config.writeBoundary;
  const patch = path.join(directory, 'acp.patch.yml');
  const backendRoot = path.join(config.root, 'backend');
  const backendHome = fencedDirectory(boundary, path.relative(boundary.root, path.join(backendRoot, 'dsh-home')));
  fs.writeFileSync(patch, `- id: session-title-llm\n  disabled: true\n- id: credentials\n  config:\n    path: ${JSON.stringify(path.join(home, '.credentials.yaml'))}\n    watch: false\n- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(path.join(backendRoot, 'sessions'))}\n- id: storage-json\n  config:\n    root: ${JSON.stringify(path.join(backendRoot, 'storages'))}\n- id: attachment-local\n  config:\n    dshHome: ${JSON.stringify(backendRoot)}\n`, {mode: 0o600});
  const confined = confinedProcess(boundary, command, ['--profile', 'acp', '--patch', patch], task.cwd);
  return {backend, model, boundary, client: {...confined, cwd: task.cwd,
    env: {...env, ...confined.env, DSH_HOME: backendHome, DSH_PERMISSION_MODE: 'workspace-write', DSH_TOOLS_MODE: 'native'}, stderrFile: path.join(directory, 'acp.stderr')}};
}

export function createBackendClient(args, backend) {
  return backend === CODEX ? new CodexClient(args) : new AcpClient(args);
}
