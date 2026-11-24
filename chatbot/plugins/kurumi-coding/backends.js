// Extensible coding backend adapter registry and operator-bound write fences.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {AcpClient} from '../../packages/coding-runtime/acp-client.js';
import {CliClient} from '../../packages/coding-runtime/cli-client.js';
import {CodexClient} from '../../packages/coding-runtime/codex-client.js';
import {confinedProcess, fencedDirectory} from '../../packages/coding-runtime/write-fence.js';
import {fail} from './policy.js';

export const DSH = 'dsh-acp', CODEX = 'codex-app-server';

export const BACKEND_PRESETS = Object.freeze({
  [DSH]: Object.freeze({driver: 'acp', label: 'DeepSeek Harness (ACP)', protocol: 'acp', supportsResume: true}),
  [CODEX]: Object.freeze({driver: 'codex', label: 'Codex App Server', protocol: 'codex-stdio', supportsResume: true}),
  'claude-code': Object.freeze({driver: 'cli', label: 'Claude Code CLI', protocol: 'cli-stdio', supportsResume: false}),
  'gemini-cli': Object.freeze({driver: 'cli', label: 'Gemini CLI', protocol: 'cli-stdio', supportsResume: false}),
  opencode: Object.freeze({driver: 'acp', label: 'OpenCode ACP', protocol: 'acp', supportsResume: true}),
});

export const ADAPTER_DRIVERS = Object.freeze({
  acp: Object.freeze({protocol: 'acp', supportsResume: true}),
  codex: Object.freeze({protocol: 'codex-stdio', supportsResume: true}),
  cli: Object.freeze({protocol: 'cli-stdio', supportsResume: false}),
});

const BACKEND_ID_PATTERN = /^[a-z][a-z0-9-]{0,39}$/;
const MODEL_STRING_PATTERN = /^[a-z0-9][a-z0-9_.:/-]{0,99}$/i;
const FORBIDDEN_ENV_KEYS = new Set([
  'PATH', 'HOME', 'TMPDIR', 'TMP', 'TEMP', 'XDG_CACHE_HOME', 'XDG_CONFIG_HOME', 'XDG_DATA_HOME',
  'LD_PRELOAD', 'LD_LIBRARY_PATH', 'NODE_OPTIONS',
]);

function validateExecutable(command, boundaryRoot, errorCode = 'invalid_coding_backend') {
  if (typeof command !== 'string' || !path.isAbsolute(command) || path.resolve(command) !== command
    || command.startsWith(boundaryRoot + path.sep) || !fs.statSync(command, {throwIfNoEntry: false})?.isFile()
    || fs.realpathSync(command).startsWith(boundaryRoot + path.sep)) {
    throw fail(errorCode);
  }
}

function validateModel(model, errorCode = 'invalid_coding_backend') {
  if (model === undefined) return undefined;
  if (typeof model === 'string') {
    if (!MODEL_STRING_PATTERN.test(model)) throw fail(errorCode);
    return model;
  }
  if (Array.isArray(model) && model.length === 2 && model.every(v => typeof v === 'string' && v && v.length <= 100)) {
    return model;
  }
  throw fail(errorCode);
}

function validateSafeEnv(env, errorCode = 'invalid_coding_backend') {
  if (env === undefined) return {};
  if (!env || typeof env !== 'object' || Array.isArray(env)) throw fail(errorCode);
  const out = {};
  for (const [k, v] of Object.entries(env)) {
    if (!/^[A-Z0-9_]{1,64}$/i.test(k) || typeof v !== 'string' || v.includes('\0')
      || FORBIDDEN_ENV_KEYS.has(k.toUpperCase()) || k.toUpperCase().startsWith('GIT_')) {
      throw fail(errorCode);
    }
    out[k] = v;
  }
  return out;
}

export function validateCodex(config) {
  if (config.codex === undefined) return;
  const {command, model} = config.codex ?? {};
  const home = path.join(config.root, 'backend', 'codex-home');
  const stat = fs.statSync(home, {throwIfNoEntry: false});
  const root = config.writeBoundary.root;
  validateExecutable(command, root, 'invalid_codex_config');
  if (!stat?.isDirectory() || fs.realpathSync(home) !== home || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()
    || (model !== undefined && (typeof model !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{0,99}$/i.test(model)))) {
    throw fail('invalid_codex_config');
  }
  return {command, home, model};
}

function validateCustomEntry(id, entry, config) {
  if (!BACKEND_ID_PATTERN.test(id) || id === DSH) throw fail('invalid_coding_backend');
  if (id === CODEX && config.codex !== undefined) throw fail('invalid_coding_backend');
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw fail('invalid_coding_backend');
  const driver = entry.driver;
  if (!Object.hasOwn(ADAPTER_DRIVERS, driver)) throw fail('invalid_coding_backend');
  const boundaryRoot = config.writeBoundary.root;
  validateExecutable(entry.command, boundaryRoot, 'invalid_coding_backend');
  const args = entry.args ?? [];
  if (!Array.isArray(args) || args.length > 32 || args.some(a => typeof a !== 'string' || a.includes('\0'))) {
    throw fail('invalid_coding_backend');
  }
  const model = validateModel(entry.model, 'invalid_coding_backend');
  const env = validateSafeEnv(entry.env, 'invalid_coding_backend');
  const promptMode = entry.promptMode ?? 'stdin';
  if (!['stdin', 'arg', 'flag'].includes(promptMode)) throw fail('invalid_coding_backend');
  const promptFlag = entry.promptFlag ?? '--prompt';
  if (typeof promptFlag !== 'string' || !promptFlag || promptFlag.includes('\0')) throw fail('invalid_coding_backend');
  if (entry.label !== undefined && (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 80)) {
    throw fail('invalid_coding_backend');
  }
  if (entry.homeDir !== undefined) {
    const stat = fs.statSync(entry.homeDir, {throwIfNoEntry: false});
    if (typeof entry.homeDir !== 'string' || !path.isAbsolute(entry.homeDir) || !stat?.isDirectory()
      || fs.realpathSync(entry.homeDir) !== entry.homeDir || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw fail('invalid_coding_backend');
    }
  }
  if (driver === 'codex') {
    const home = entry.homeDir ?? path.join(config.root, 'backend', `${id}-home`);
    const stat = fs.statSync(home, {throwIfNoEntry: false});
    if (!stat?.isDirectory() || fs.realpathSync(home) !== home || (stat.mode & 0o077) !== 0 || stat.uid !== process.getuid()) {
      throw fail('invalid_coding_backend');
    }
  }
  const preset = BACKEND_PRESETS[id];
  return {
    id,
    driver,
    label: entry.label ?? preset?.label ?? id,
    protocol: ADAPTER_DRIVERS[driver].protocol,
    supportsResume: ADAPTER_DRIVERS[driver].supportsResume,
    command: entry.command,
    args,
    model,
    promptMode,
    promptFlag,
    homeDir: entry.homeDir,
    env,
  };
}

export function validateBackends(config) {
  const specs = new Map();
  specs.set(DSH, {
    id: DSH,
    driver: 'acp',
    label: BACKEND_PRESETS[DSH].label,
    protocol: 'acp',
    supportsResume: true,
    command: config.dsh.command,
    home: config.dsh.home,
    model: config.dsh.model,
  });
  if (config.codex !== undefined) {
    const validated = validateCodex(config);
    specs.set(CODEX, {
      id: CODEX,
      driver: 'codex',
      label: BACKEND_PRESETS[CODEX].label,
      protocol: 'codex-stdio',
      supportsResume: true,
      ...validated,
    });
  }
  if (config.backends !== undefined) {
    if (!config.backends || typeof config.backends !== 'object' || Array.isArray(config.backends)) {
      throw fail('invalid_coding_backend');
    }
    for (const [id, entry] of Object.entries(config.backends)) {
      specs.set(id, validateCustomEntry(id, entry, config));
    }
  }
  return specs;
}

export const availableBackends = config => {
  const list = [DSH];
  if (config.codex !== undefined) list.push(CODEX);
  if (config.backends && typeof config.backends === 'object' && !Array.isArray(config.backends)) {
    for (const id of Object.keys(config.backends).sort()) {
      if (!list.includes(id)) list.push(id);
    }
  }
  return list;
};

export function describeBackends(config) {
  const list = [
    {id: DSH, ...BACKEND_PRESETS[DSH], ...(config.dsh?.model ? {model: config.dsh.model} : {})},
  ];
  if (config.codex !== undefined) {
    list.push({id: CODEX, ...BACKEND_PRESETS[CODEX], ...(config.codex?.model ? {model: config.codex.model} : {})});
  }
  if (config.backends && typeof config.backends === 'object' && !Array.isArray(config.backends)) {
    for (const id of Object.keys(config.backends).sort()) {
      const entry = config.backends[id];
      const preset = BACKEND_PRESETS[id];
      const driver = entry?.driver ?? preset?.driver ?? 'cli';
      list.push({
        id,
        driver,
        label: entry?.label ?? preset?.label ?? id,
        protocol: ADAPTER_DRIVERS[driver]?.protocol ?? driver,
        supportsResume: ADAPTER_DRIVERS[driver]?.supportsResume ?? false,
        ...(entry?.model !== undefined ? {model: entry.model} : {}),
      });
    }
  }
  return list;
}

export const taskBackend = task => task.backend ?? DSH;

export function selectBackend(config, backend = DSH) {
  if (typeof backend !== 'string' || !BACKEND_ID_PATTERN.test(backend)) throw fail('unknown_coding_backend');
  const known = availableBackends(config);
  if (!known.includes(backend)) {
    throw fail(Object.hasOwn(BACKEND_PRESETS, backend) ? 'coding_backend_not_enabled' : 'unknown_coding_backend');
  }
  return backend;
}

function resolveIsolatedHome(config, id, explicitHome) {
  if (explicitHome) return explicitHome;
  const rel = path.relative(config.writeBoundary.root, path.join(config.root, 'backend', `${id}-home`));
  return fencedDirectory(config.writeBoundary, rel);
}

export function launchOptions(config, task, directory, env) {
  const backend = selectBackend(config, taskBackend(task));
  const spec = validateBackends(config).get(backend);

  if (spec.driver === 'codex') {
    const home = spec.id === CODEX ? spec.home : (spec.homeDir ?? path.join(config.root, 'backend', `${backend}-home`));
    const boundary = {root: home, additionalRoots: [task.cwd], launcher: config.writeBoundary.launcher};
    const probe = confinedProcess(boundary, spec.command, ['sandbox', '-P', ':workspace', '--cd', task.cwd, '--', '/usr/bin/true'], task.cwd);
    const sandbox = spawnSync(probe.command, probe.args, {
      cwd: task.cwd,
      env: {...env, ...probe.env, ...spec.env, HOME: home, CODEX_HOME: home},
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    if (sandbox.status !== 0) {
      const diag = [sandbox.stdout, sandbox.stderr].filter(Boolean).join('\n').trim();
      if (diag) {
        try { fs.appendFileSync(path.join(directory, 'codex.stderr'), `[sandbox-probe status=${sandbox.status}] ${diag}\n`, {mode: 0o600}); } catch {}
      }
      throw fail('codex_sandbox_unavailable');
    }
    const confined = confinedProcess(boundary, spec.command, ['app-server', '--listen', 'stdio://',
      '-c', 'check_for_update_on_startup=false', '-c', 'analytics.enabled=false', '-c', 'allow_login_shell=false',
      '-c', 'sandbox_workspace_write.network_access=false', '-c', 'sandbox_workspace_write.writable_roots=[]',
      ...(spec.args ?? [])], task.cwd);
    return {
      backend,
      driver: 'codex',
      model: spec.model,
      boundary,
      client: {
        ...confined,
        cwd: task.cwd,
        codexHome: home,
        env: {...env, ...confined.env, ...spec.env, HOME: home, CODEX_HOME: home},
        stderrFile: path.join(directory, 'codex.stderr'),
      },
    };
  }

  if (spec.id === DSH) {
    const {command, home, model} = config.dsh;
    const boundary = config.writeBoundary;
    const patch = path.join(directory, 'acp.patch.yml');
    const backendRoot = path.join(config.root, 'backend');
    const backendHome = fencedDirectory(boundary, path.relative(boundary.root, path.join(backendRoot, 'dsh-home')));
    fs.writeFileSync(patch, `- id: session-title-llm\n  disabled: true\n- id: credentials\n  config:\n    path: ${JSON.stringify(path.join(home, '.credentials.yaml'))}\n    watch: false\n- id: session-persistence-jsonl\n  config:\n    root: ${JSON.stringify(path.join(backendRoot, 'sessions'))}\n- id: storage-json\n  config:\n    root: ${JSON.stringify(path.join(backendRoot, 'storages'))}\n- id: attachment-local\n  config:\n    dshHome: ${JSON.stringify(backendRoot)}\n`, {mode: 0o600});
    const confined = confinedProcess(boundary, command, ['--profile', 'acp', '--patch', patch], task.cwd);
    return {
      backend,
      driver: 'acp',
      model,
      boundary,
      client: {
        ...confined,
        cwd: task.cwd,
        env: {...env, ...confined.env, DSH_HOME: backendHome, DSH_PERMISSION_MODE: 'workspace-write', DSH_TOOLS_MODE: 'native'},
        stderrFile: path.join(directory, 'acp.stderr'),
      },
    };
  }

  // Non-DSH ACP or headless CLI backends get an isolated per-backend home + task.cwd Landlock fence.
  const home = resolveIsolatedHome(config, spec.id, spec.homeDir);
  const boundary = {root: home, additionalRoots: [task.cwd], launcher: config.writeBoundary.launcher};
  if (spec.driver === 'acp') {
    const confined = confinedProcess(boundary, spec.command, spec.args ?? [], task.cwd);
    return {
      backend,
      driver: 'acp',
      model: spec.model,
      boundary,
      client: {
        ...confined,
        cwd: task.cwd,
        env: {...env, ...confined.env, ...spec.env, HOME: home},
        stderrFile: path.join(directory, `${spec.id}.stderr`),
      },
    };
  }

  const confined = confinedProcess(boundary, spec.command, spec.args ?? [], task.cwd);
  return {
    backend,
    driver: 'cli',
    model: spec.model,
    boundary,
    client: {
      ...confined,
      cwd: task.cwd,
      promptMode: spec.promptMode,
      promptFlag: spec.promptFlag,
      model: spec.model,
      env: {...env, ...confined.env, ...spec.env, HOME: home},
      stderrFile: path.join(directory, `${spec.id}.stderr`),
    },
  };
}

export function createBackendClient(args, backend, config) {
  const driver = config ? validateBackends(config).get(backend)?.driver : (backend === CODEX ? 'codex' : 'acp');
  if (driver === 'codex') return new CodexClient(args);
  if (driver === 'cli') return new CliClient(args);
  return new AcpClient(args);
}
