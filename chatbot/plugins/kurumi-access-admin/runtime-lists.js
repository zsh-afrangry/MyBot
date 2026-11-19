import {AccessError, toolPermissions} from '../../packages/access-control/index.js';
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
