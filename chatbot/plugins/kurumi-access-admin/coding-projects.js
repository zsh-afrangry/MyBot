import path from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {AccessError} from '../../packages/access-control/index.js';
import {inspectProjectMutation} from '../../packages/coding-runtime/project-registry.js';
import {assertFields, sha256} from './policy.js';

const coding = cfg => cfg.plugins?.entries?.['kurumi-coding'];
const profiles = cfg => cfg.plugins?.entries?.['kurumi-access-admin']?.config?.projectCheckProfiles ?? {};
const idPattern = /^[a-z][a-z0-9-]{0,39}$/u;
const fail = code => { throw new AccessError(code); };

function projectKey(value) {
  if (typeof value !== 'string' || !idPattern.test(value)) fail('invalid_project_id');
  return value;
}

function view(row, accepted) {
  if (!row) return null;
  const kind = row.kind ?? 'git';
  return {
    id: row.id, root: row.root, kind, ...(kind === 'git' ? {branch: row.branch} : {}),
    checkProfile: Object.keys(accepted).sort().find(id => isDeepStrictEqual(accepted[id], row.checks)) ?? null,
    checks: row.checks.map(check => check.name),
    checksHash: sha256(JSON.stringify(row.checks)),
    ...(row.registrationId ? {registrationId: row.registrationId} : {}),
  };
}

function entries(cfg) {
  const projects = coding(cfg)?.config?.projects;
  if (!Array.isArray(projects)) fail('coding_project_registry_unavailable');
  return projects;
}

function approvedProfiles(env) {
  const live = profiles(env.config);
  return Object.fromEntries(Object.entries(profiles(env.intent)).filter(([id, plan]) => idPattern.test(id)
    && Array.isArray(plan) && plan.length > 0 && Object.hasOwn(live, id) && isDeepStrictEqual(live[id], plan)));
}

export const codingProjectCategory = {
  target: 'runtime',
  arg: 'key',
  parseKey: projectKey,
  key: row => row.id,
  list: cfg => entries(cfg).map(row => view(row, profiles(cfg))).sort((a, b) => a.id.localeCompare(b.id)),
  live: (_policy, cfg) => codingProjectCategory.list(cfg),
  build(cfg, change, env) {
    const op = change?.op;
    assertFields(change, op === 'remove' ? ['op', 'key'] : ['op', 'key', 'root', 'kind', 'branch', 'checkProfile']);
    if (!['add', 'update', 'remove'].includes(op)) fail('unknown_project_operation');
    const id = projectKey(change.key), projects = entries(cfg), existing = projects.find(row => row.id === id);
    if (op === 'add' ? existing : !existing) fail(op === 'add' ? 'access_entry_already_exists' : 'access_entry_not_found');
    if (coding(cfg)?.enabled !== true || coding(env.config)?.enabled !== true) fail('coding_project_registry_unavailable');
    const accepted = approvedProfiles(env);
    let candidate = null;
    if (op !== 'remove') {
      if (!env.owner.permissions['tasks.code'] || !env.runtimeOwner.permissions['tasks.code']) fail('coding_project_not_granted');
      const root = change.root ?? existing?.root, oldKind = existing?.kind ?? 'git';
      const kind = change.kind ?? (existing ? oldKind : undefined);
      if (typeof root !== 'string' || root.length > 4096 || !path.isAbsolute(root) || path.resolve(root) !== root
        || root === '/' || /[\x00-\x1f\x7f]/u.test(root) || change.root === null) fail('invalid_project_root');
      if (change.kind === null || !['git', 'directory'].includes(kind)) fail('invalid_project_kind');
      const branch = change.branch ?? (oldKind === kind ? existing?.branch : undefined);
      if (kind === 'directory' ? change.branch !== undefined
        : (typeof branch !== 'string' || branch.length > 255 || !/^[a-zA-Z0-9][a-zA-Z0-9/_-]*$/u.test(branch)
          || change.branch === null)) fail('invalid_project_branch');
      let checks = existing?.checks;
      if (change.checkProfile !== undefined) {
        if (typeof change.checkProfile !== 'string' || !Object.hasOwn(accepted, change.checkProfile)) fail('coding_check_profile_not_approved');
        checks = accepted[change.checkProfile];
      } else if (!existing || root !== existing.root || kind !== oldKind) {
        fail('coding_check_profile_required');
      }
      if (existing && root === existing.root && kind === oldKind && (kind === 'directory' || branch === existing.branch)
        && isDeepStrictEqual(checks, existing.checks)) fail('access_change_noop');
      candidate = {id, root, kind, ...(kind === 'git' ? {branch} : {}), checks, registrationId: env.proposalId};
    }
    const updated = op === 'add' ? [...projects, candidate]
      : projects.flatMap(project => project.id !== id ? [project] : candidate ? [candidate] : []);
    let facts;
    try {
      facts = inspectProjectMutation(coding(env.config).config, coding(cfg).config, id, updated, candidate);
    } catch (error) {
      fail(typeof error.code === 'string' && /^[a-z_]+$/u.test(error.code) ? error.code : 'invalid_coding_project');
    }
    const next = structuredClone(cfg);
    coding(next).config.projects = updated;
    return {before: view(existing, profiles(cfg)), after: view(candidate, profiles(cfg)), next, facts};
  },
  inspect(env, draft) {
    if (draft) return draft.facts;
    return {checkProfiles: Object.entries(approvedProfiles(env)).map(([id, plan]) => ({id, checks: plan.map(check => check.name)}))
      .sort((a, b) => a.id.localeCompare(b.id))};
  },
  preview({before, after}) {
    const display = row => row ? [
      JSON.stringify(row.id), JSON.stringify(row.root), row.kind,
      ...(row.branch ? ['目标分支 ' + JSON.stringify(row.branch)] : []),
      '检查 ' + (row.checkProfile ? JSON.stringify(row.checkProfile) + '：' : '') + row.checks.map(name => JSON.stringify(name)).join('、'),
    ].join('；') : '无记录';
    return ['编码项目白名单预览', '修改前：' + display(before), '修改后：' + display(after),
      '确认后只写仓库配置；同步后旧任务及结果保留，旧登记的续接、合入和回写停用。',
    ].join('\n');
  },
};
