import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {AccessError, toolPermissions} from '../../packages/access-control/index.js';
import {validateWriteFence, writeFenceRoots} from '../../packages/coding-runtime/write-fence.js';
import {stringListChange, stringListPreview, stringListView} from './policy.js';

const protectedTools = new Set(['kurumi_access', 'personal_confirmation']);
const mainTools = cfg => cfg.agents?.entries?.main?.tools;

function toolName(name) {
  if (typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/u.test(name)) throw new AccessError('invalid_owner_tool');
  return name;
}

function toolEntries(cfg) {
  const list = mainTools(cfg)?.alsoAllow;
  if (!Array.isArray(list) || list.some(name => typeof name !== 'string')) throw new AccessError('invalid_owner_tool_allowlist');
  return list;
}

function withTools(cfg, alsoAllow) {
  return {...cfg, agents: {...cfg.agents, entries: {...cfg.agents.entries,
    main: {...cfg.agents.entries.main, tools: {...mainTools(cfg), alsoAllow}}}}};
}

const granted = (name, env) => toolPermissions(name).some(permission =>
  env.owner.permissions[permission] === true && env.runtimeOwner.permissions[permission] === true);

async function inspectTools(cfg, env) {
  if (!env.toolSurface) throw new AccessError('owner_tool_catalog_unavailable');
  try { return new Set(await env.toolSurface(cfg)); }
  catch { throw new AccessError('owner_tool_catalog_unavailable'); }
}

export const ownerToolCategory = {
  target: 'runtime',
  arg: 'key',
  parseKey: toolName,
  key: entry => entry,
  list: cfg => stringListView(toolEntries(cfg)),
  live: (_policy, cfg) => stringListView(toolEntries(cfg)),
  build(cfg, change, env) {
    const draft = stringListChange(toolEntries(cfg), change, toolName);
    if (protectedTools.has(draft.before) || protectedTools.has(draft.after)) throw new AccessError('access_management_tool_protected');
    if (draft.after && !granted(draft.after, env)) throw new AccessError('owner_tool_not_granted');
    const next = withTools(cfg, draft.entries);
    return {...draft, next};
  },
  async inspect(env, draft) {
    if (draft) {
      // Resolve names with the real host tool factory and just the proposed alsoAllow value.
      // No descriptor is executed, and the active runtime config is not mutated.
      const names = await inspectTools(withTools(env.config, draft.entries), env);
      if (draft.after && !names.has(draft.after)) throw new AccessError('owner_tool_unavailable');
      return {remainsAvailable: draft.before !== null && granted(draft.before, env) && names.has(draft.before)};
    }
    const current = toolEntries(env.config);
    const filter = names => [...names].filter(name => !protectedTools.has(name) && granted(name, env)).sort();
    const [available, inherited] = await Promise.all([
      inspectTools(env.config, env),
      inspectTools(withTools(env.config, current.filter(name => protectedTools.has(name))), env),
    ]);
    return {available: filter(available), outsideAlsoAllow: filter(inherited)};
  },
  preview: ({before, after}, _revision, facts) => stringListPreview('主人工具', before, after,
    facts.remainsAvailable
      ? '移除的工具仍由其他规则提供；现有业务权限照常校验。'
      : '只更新主人工具的附加名单；业务权限和禁用策略照常校验。'),
};

const hostExec = cfg => cfg.plugins?.entries?.['kurumi-host-control']?.config?.exec;
const admin = cfg => cfg.plugins?.entries?.['kurumi-access-admin']?.config;
const within = (candidate, base) => candidate === base || candidate.startsWith(base + path.sep);
const overlapping = (a, b) => within(a, b) || within(b, a);
const systemRoots = ['/bin', '/boot', '/dev', '/etc', '/lib', '/lib64', '/opt', '/proc', '/root', '/run',
  '/sbin', '/sys', '/usr', '/var'];

function directoryKey(value) {
  if (typeof value !== 'string' || value.length > 4096 || !path.isAbsolute(value) || path.resolve(value) !== value
    || value === '/' || /[\x00-\x1f\x7f]/u.test(value)) throw new AccessError('invalid_exec_directory');
  return value;
}

function directoryEntries(cfg) {
  const entries = hostExec(cfg)?.writeBoundary?.additionalRoots ?? [];
  if (!Array.isArray(entries) || entries.some(entry => typeof entry !== 'string')) throw new AccessError('invalid_exec_directory');
  return entries;
}

function protectedRoots(cfg, env) {
  const home = os.homedir(), coding = cfg.plugins?.entries?.['kurumi-coding']?.config;
  return [
    ...systemRoots, env.sourceRoot, env.stateRoot, admin(cfg)?.sourceRoot,
    path.join(home, 'kurumi-backups'), path.join(home, 'kurumi-archive'),
    ...(cfg.plugins?.load?.paths ?? []),
    ...Object.values(cfg.agents?.entries ?? {}).map(entry => entry.workspace),
    cfg.agents?.defaults?.workspace, coding?.writeBoundary?.root, coding?.dsh?.home,
  ].filter(value => typeof value === 'string' && path.isAbsolute(value));
}

function assertOrdinaryDirectory(key, cfg, env) {
  if (within(os.homedir(), key) || key === os.tmpdir() || key.split(path.sep).some(part => part.startsWith('.'))
    || protectedRoots(cfg, env).some(root => overlapping(key, root))) throw new AccessError('exec_directory_protected');
  try {
    if (fs.realpathSync(key) === key) {
      const stat = fs.statSync(key, {bigint: true});
      if (stat.isDirectory()) return {device: String(stat.dev), inode: String(stat.ino)};
    }
  } catch { /* Refuse a missing or replaced directory. */ }
  throw new AccessError('invalid_exec_directory');
}

function approvedBases(env) {
  const source = admin(env.intent)?.execDirectoryBases;
  const active = admin(env.config)?.execDirectoryBases;
  if (!Array.isArray(source) || !Array.isArray(active)) return [];
  return stringListView(source.filter(base => {
    if (!active.includes(base)) return false;
    try {
      const key = directoryKey(base);
      assertOrdinaryDirectory(key, env.intent, env);
      assertOrdinaryDirectory(key, env.config, env);
      return true;
    } catch { return false; }
  }));
}

export const execRootCategory = {
  target: 'runtime',
  arg: 'key',
  parseKey: directoryKey,
  key: entry => entry,
  list: cfg => stringListView(directoryEntries(cfg)),
  live: (_policy, cfg) => stringListView(directoryEntries(cfg)),
  build(cfg, change, env) {
    const exec = hostExec(cfg);
    if (!exec?.writeBoundary || !hostExec(env.config)?.writeBoundary) throw new AccessError('owner_exec_disabled');
    const draft = stringListChange(directoryEntries(cfg), change, directoryKey);
    let facts;
    if (draft.after !== null) {
      if (!env.owner.permissions['host.exec'] || !env.runtimeOwner.permissions['host.exec']) {
        throw new AccessError('host_exec_not_granted');
      }
      facts = assertOrdinaryDirectory(draft.after, cfg, env);
      assertOrdinaryDirectory(draft.after, env.config, env);
      if (!approvedBases(env).some(base => within(draft.after, base))) {
        throw new AccessError('exec_directory_not_approved');
      }
    }
    const boundary = {...exec.writeBoundary, additionalRoots: draft.entries};
    try {
      validateWriteFence(boundary);
      if (!writeFenceRoots(boundary).some(root => within(fs.realpathSync(exec.workdir), root))) {
        throw new Error('default workdir removed');
      }
    } catch { throw new AccessError('exec_directory_boundary_invalid'); }
    const next = structuredClone(cfg);
    hostExec(next).writeBoundary.additionalRoots = draft.entries;
    return {...draft, next, facts};
  },
  inspect: (env, draft) => draft ? draft.facts : {approvedBases: approvedBases(env)},
  preview: ({before, after}) => stringListPreview('可写目录', before, after,
    '同步后只变更主人原生 exec 的普通文件写入范围；编码执行器的边界保持原样。'),
};
