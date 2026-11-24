import path from 'node:path';
import {bad, conflict, fields, jsonFile, loadModule, optional, own, Problem, readFile, replaceSource, sha} from './common.mjs';

const ACCESS = 'config/access-control.json';
const PERSONA = 'config/persona.json';
const MAX_ROLE = 64 * 1024;
const EMAIL = /^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/u;
const DATE = /^\d{4}-\d\d-\d\dT\d\d:\d\d(?::\d\d(?:\.\d{1,3})?)?(?:Z|[+-]\d\d:\d\d)$/u;
const ROLE_SLOTS = [
  ['soul', '共享角色', 'SOUL.md'],
  ['owner', '主人关系', 'USER.md · 主人'],
  ['member', '成员关系', 'USER.md · 成员'],
];

function same(a, b) {
  if (a === b) return true;
  if (a == null || b == null || typeof a !== 'object' || typeof b !== 'object'
      || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(k => own(b, k) && same(a[k], b[k]));
}

function readPolicy(deps) {
  const raw = readFile(deps.sourceRoot, ACCESS, undefined, {source: true});
  return {...raw, policy: deps.access.validatePolicy(JSON.parse(raw.text))};
}

const runtimePolicy = deps => optional(() => deps.access.accessPolicy(jsonFile(deps.runtimeRoot, 'openclaw.json')));

export async function loadChanges(sourceRoot, runtimeRoot) {
  const access = await loadModule(sourceRoot, 'chatbot/packages/access-control/index.js');
  const compile = await loadModule(sourceRoot, 'chatbot/packages/access-control/config.js');
  const {personaFiles} = await loadModule(sourceRoot, 'scripts/fusion/lib/persona-workspaces.mjs');
  const deps = {sourceRoot, runtimeRoot, access, compile, personaFiles};
  return {
    whitelist() {
      const current = readPolicy(deps);
      const live = runtimePolicy(deps);
      const rows = current.policy.subjects.map(source => {
        const effective = live?.subjects.find(row => row.kind === source.kind && row.qq === source.qq);
        return {source, effective: effective ?? null, aligned: live ? same(source, effective) : null};
      });
      const removed = live?.subjects.filter(r => !current.policy.subjects.some(s => s.kind === r.kind && s.qq === r.qq)) ?? [];
      return {
        revision: current.hash,
        sourceRevision: current.policy.revision,
        runtimeRevision: live?.revision ?? null,
        permissions: access.PERMISSIONS,
        sharedPermissions: access.SHARED_PERMISSIONS,
        rows, removed, aligned: live ? same(current.policy, live) : null,
      };
    },
    persona() {
      const persona = personaConfig(deps);
      const workspaces = optional(() => projection(deps));
      const states = workspaces?.flatMap(w => w.files.map(f => f.state)) ?? [];
      const aligned = states.includes('different') || states.includes('missing') ? false :
        states.length && states.every(state => state === 'match') ? true : null;
      return {
        identity: persona.value.identityName,
        revision: persona.hash,
        aligned,
        slots: ROLE_SLOTS.filter(([key]) => roleRelative(persona.value, key)).map(([key, label, target]) => ({
          key, label, target, source: roleRelative(persona.value, key),
        })),
        workspaces: workspaces ?? [],
      };
    },
    managedLists() {
      const read = (root, file) => optional(() => jsonFile(root, file, 4 * 1024 * 1024));
      const source = read(sourceRoot, 'config/runtime.config.json');
      const runtime = read(runtimeRoot, 'openclaw.json');
      return Object.fromEntries(Object.entries(managedLists).map(([key, select]) => {
        const a = source ? optional(() => select(source)) : null;
        const b = runtime ? optional(() => select(runtime)) : null;
        return [key, {source: a, runtime: b, aligned: a && b ? same(a, b) : null}];
      }));
    },
    role(slot) {
      const persona = personaConfig(deps);
      const file = roleFile(deps, persona, slot);
      return {slot, source: file.relative, text: file.text, revision: file.hash, personaRevision: persona.hash};
    },
    preview(body) {
      if (body?.kind === 'persona') return personaChange(deps, body);
      if (body?.kind === 'member' || body?.kind === 'mail' || body?.kind === 'mail_sender') return policyChange(deps, body);
      throw bad('没有对应的变更类型。');
    },
    commit(change) {
      if (change.kind === 'persona') {
        // Reject a switched projection even when the previous role file still exists.
        const persona = personaConfig(deps);
        if (persona.hash !== change.personaRevision || roleRelative(persona.value, change.slot) !== change.relative) throw conflict();
      } else {
        const runtime = readFile(sourceRoot, 'config/runtime.config.json');
        if (change.configRevision !== runtime.hash) throw conflict();
      }
      replaceSource(sourceRoot, change.relative, change.revision, change.content, change.kind === 'persona' ? MAX_ROLE : undefined);
    },
  };
}

const bounded = (value, max) => typeof value === 'string' && value.length <= max && !/[\x00-\x1f\x7f]/u.test(value);
const directoryName = value => bounded(value, 4096) && path.isAbsolute(value);
const values = (value, test) => {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every(test)) throw Error('Invalid registered list');
  return [...new Set(value)].sort();
};

const managedLists = {
  tools: config => values(config.agents?.entries?.main?.tools?.alsoAllow,
    x => typeof x === 'string' && /^[a-z][a-z0-9_.:-]{0,109}$/iu.test(x)),
  directories: config => values(config.plugins?.entries?.['kurumi-host-control']?.config?.exec?.writeBoundary?.additionalRoots, directoryName),
  projects: config => {
    const list = config.plugins?.entries?.['kurumi-coding']?.config?.projects ?? [];
    if (!Array.isArray(list)) throw Error('Invalid project registry');
    return list.map(row => {
      const kind = row.kind ?? 'git';
      if (typeof row.id !== 'string' || !/^[a-z][a-z0-9-]{0,39}$/u.test(row.id) ||
          !directoryName(row.root) || !['git', 'directory'].includes(kind) ||
          (kind === 'git' && !bounded(row.branch, 255)) || !Array.isArray(row.checks)) throw Error('Invalid project');
      return {id: row.id, root: row.root, kind, branch: kind === 'git' ? row.branch : null,
        checks: row.checks.map(check => bounded(check.name, 130) ? check.name : '未命名检查'),
        // Compare the complete check plan without returning its command or arguments.
        checkRevision: sha(JSON.stringify(row.checks))};
    }).sort((a, b) => a.id.localeCompare(b.id));
  },
};

function projection({sourceRoot, runtimeRoot, personaFiles}) {
  const {files} = personaFiles(sourceRoot, runtimeRoot);
  const workspaces = new Map();
  for (const [absolute, text] of files) {
    const relative = path.relative(runtimeRoot, absolute);
    const match = /^(workspace|users\/(\d{5,12})\/workspace)\/(SOUL|IDENTITY|USER|AGENTS)\.md$/u.exec(relative);
    if (!match) throw Error('Invalid projection path');
    const [, key, member, file] = match;
    if (!workspaces.has(key)) workspaces.set(key, {label: member ? '成员 · ' + member : '主人', files: []});
    let state;
    try {
      state = readFile(runtimeRoot, relative, 256 * 1024).text === text ? 'match' : 'different';
    } catch (error) {
      state = error.code === 'ENOENT' ? 'missing' : 'unavailable';
    }
    workspaces.get(key).files.push({name: file + '.md', state});
  }
  return [...workspaces.values()];
}

function personaConfig({sourceRoot}) {
  const file = readFile(sourceRoot, PERSONA);
  const value = JSON.parse(file.text);
  if (typeof value.identityName !== 'string' || !value.identityName.trim()) throw Error('Invalid persona configuration');
  return {...file, value};
}

function roleRelative(persona, key) {
  if (key === 'soul') return persona.roleFile;
  if (key === 'owner' || key === 'member') return persona.relationshipFiles?.[key];
  return undefined;
}

function roleFile({sourceRoot}, persona, slot) {
  const relative = roleRelative(persona.value, slot);
  if (!relative) throw new Problem(404, '人格素材不存在。');
  if (typeof relative !== 'string' || !relative.startsWith('roles/') || !relative.endsWith('.md') || /[\\\0]/u.test(relative)) {
    throw Error('Invalid role path');
  }
  return {...readFile(sourceRoot, relative, MAX_ROLE, {source: true}), relative};
}

function personaChange(deps, input) {
  fields(input, ['kind', 'slot', 'text', 'revision', 'personaRevision']);
  const persona = personaConfig(deps);
  if (persona.hash !== input.personaRevision) throw conflict();
  const file = roleFile(deps, persona, input.slot);
  if (file.hash !== input.revision) throw conflict();
  if (typeof input.text !== 'string' || !input.text.trim() || /\{\{[^}]*\}\}|\x00/u.test(input.text) ||
      Buffer.byteLength(input.text, 'utf8') > MAX_ROLE || !input.text.isWellFormed()) {
    throw bad('素材必须是非空 Markdown，最大 64 KiB，不能包含未替换的模板占位符。');
  }
  if (file.text === input.text) throw bad('内容没有变化。');
  return {
    kind: 'persona', operation: 'edit', slot: input.slot, relative: file.relative, revision: file.hash,
    personaRevision: persona.hash, content: input.text, before: file.text, after: input.text, label: file.relative,
  };
}

function memberChange(deps, policy, input) {
  fields(input, ['kind', 'operation', 'qq', 'revision', 'enabled', 'permissions', 'note', 'expiresAt']);
  const {operation, qq} = input;
  if (!['add', 'edit', 'remove'].includes(operation) || typeof qq !== 'string' || !deps.access.QQ_ID.test(qq)) throw bad('成员 QQ 号应为 5 至 12 位数字。');
  const index = policy.subjects.findIndex(row => row.kind === 'user' && row.qq === qq);
  const before = policy.subjects[index] ?? null;
  if (before?.role === 'owner') throw new Problem(403, '主人账号在这里仅可查看。');
  if (operation === 'add' ? before : !before) throw conflict();
  if (operation === 'remove') {
    policy.subjects.splice(index, 1);
    return {before, after: null, label: 'QQ · ' + qq, target: 'QQ · …' + qq.slice(-4)};
  }
  if (typeof input.enabled !== 'boolean' || !Array.isArray(input.permissions) || input.permissions.length > deps.access.SHARED_PERMISSIONS.length ||
      new Set(input.permissions).size !== input.permissions.length ||
      input.permissions.some(p => !deps.access.SHARED_PERMISSIONS.includes(p)) ||
      (input.note !== undefined && (typeof input.note !== 'string' || input.note.length > 500)) ||
      (input.expiresAt != null && (typeof input.expiresAt !== 'string' || !DATE.test(input.expiresAt) || !Number.isFinite(Date.parse(input.expiresAt))))) {
    throw bad('成员只能使用可分配权限；备注最多 500 字，到期时间需包含时区。');
  }
  const selected = new Set(input.permissions);
  const permissions = {...before?.permissions};
  for (const permission of deps.access.SHARED_PERMISSIONS) {
    if (selected.has(permission) || own(permissions, permission)) permissions[permission] = selected.has(permission);
  }
  const after = {...before, qq, kind: 'user', role: 'member', enabled: input.enabled, permissions, mailRecipients: []};
  if (input.note?.trim()) after.note = input.note.trim();
  else delete after.note;
  if (input.expiresAt != null) after.expiresAt = new Date(input.expiresAt).toISOString();
  else delete after.expiresAt;
  if (before && same(before, after)) throw bad('成员信息没有变化。');
  if (index >= 0) policy.subjects[index] = after;
  else policy.subjects.push(after);
  return {before, after, label: 'QQ · ' + qq, target: 'QQ · …' + qq.slice(-4)};
}

function mailChange(policy, input, kind) {
  fields(input, ['kind', 'operation', 'address', 'nextAddress', 'revision']);
  const {operation} = input;
  const sender = kind === 'mail_sender';
  if (!['add', 'edit', 'remove'].includes(operation)) throw bad(sender ? '无效的发件人操作。' : '无效的收件人操作。');
  const normalize = address => {
    const normalized = typeof address === 'string' ? address.trim().toLowerCase() : '';
    if (!EMAIL.test(normalized) || normalized.length > 254 || /[\p{Cc}\p{Cf}]/u.test(normalized)) throw bad('请输入一个完整的邮箱地址。');
    return normalized;
  };
  const before = operation === 'add' ? null : normalize(input.address);
  const after = operation === 'remove' ? null : normalize(input.nextAddress);
  const owner = policy.subjects.find(row => row.role === 'owner');
  const key = sender ? 'mailSenders' : 'mailRecipients';
  const current = owner[key] ?? [];
  if (before && !current.includes(before)) throw conflict();
  if (after && current.includes(after)) throw bad('邮箱已经在白名单中。');
  owner[key] = before
    ? current.flatMap(address => address !== before ? [address] : after ? [after] : [])
    : [...current, after];
  return {before, after, label: sender ? '邮件发件人' : '邮件收件人', target: '地址 · ' + sha(before ?? after).slice(0, 8)};
}

function policyChange(deps, input) {
  const source = readPolicy(deps);
  if (source.hash !== input.revision) throw conflict();
  const policy = structuredClone(source.policy);
  const diff = input.kind === 'member' ? memberChange(deps, policy, input) : mailChange(policy, input, input.kind);
  policy.revision++;
  const runtime = readFile(deps.sourceRoot, 'config/runtime.config.json');
  try {
    deps.compile.compileAccessConfig(JSON.parse(runtime.text), policy);
  } catch {
    throw bad('候选设置未通过 Fusion 权限配置校验。请检查条目和数量。');
  }
  const content = JSON.stringify(policy, null, 2) + '\n';
  if (Buffer.byteLength(content, 'utf8') > 1024 * 1024) throw bad('候选权限配置超出文件大小限制。');
  return {
    kind: input.kind, operation: input.operation, revision: source.hash, relative: ACCESS, configRevision: runtime.hash,
    content, sourceRevision: policy.revision, ...diff,
  };
}
