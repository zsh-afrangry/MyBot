import {createHash} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import {AccessError, QQ_ID, SHARED_PERMISSIONS, validatePolicy} from '../../packages/access-control/index.js';

export const DOMAIN = 'access';
export const TOOL = 'kurumi_access';
export const proposalIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const shared = new Set(SHARED_PERMISSIONS);
const reject = code => { throw new AccessError(code); };

export function assertFields(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) reject('invalid_access_admin_arguments');
}

export function assertQq(qq) {
  if (typeof qq !== 'string' || !QQ_ID.test(qq)) reject('invalid_member_qq');
}

function validatePermissions(permissions) {
  if (!Array.isArray(permissions) || permissions.length > shared.size
    || permissions.some(permission => !shared.has(permission))) reject('invalid_member_permissions');
  if (permissions.length !== new Set(permissions).size) reject('duplicate_member_permission');
}

function normalizeExpiry(value) {
  if (typeof value !== 'string'
    || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/u.test(value)) {
    reject('invalid_member_expiry');
  }
  const day = value.slice(0, 10);
  const midnight = Date.parse(`${day}T00:00:00Z`);
  const timestamp = Date.parse(value);
  if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== day
    || !Number.isFinite(timestamp)) reject('invalid_member_expiry');
  const iso = new Date(timestamp).toISOString();
  if (!/^\d{4}-/u.test(iso)) reject('invalid_member_expiry');
  return iso;
}

export function memberView(row) {
  return row ? {
    qq: row.qq,
    enabled: row.enabled,
    permissions: SHARED_PERMISSIONS.filter(permission => row.permissions[permission] === true),
    expiresAt: row.expiresAt ?? null,
    note: row.note ?? null,
  } : null;
}

export function buildMemberChange(policy, change) {
  assertFields(change, ['op', 'qq', 'grant', 'revoke', 'enabled', 'note', 'expiresAt']);
  assertQq(change.qq);
  const {op, qq, grant, revoke, enabled, note, expiresAt} = change;
  if (!['add', 'update', 'remove'].includes(op)) reject('unknown_member_operation');
  if (op === 'remove') assertFields(change, ['op', 'qq']);
  if (op === 'add') {
    assertFields(change, ['op', 'qq', 'grant', 'enabled', 'note', 'expiresAt']);
  }
  if (op === 'add' || grant !== undefined) validatePermissions(grant);
  if (revoke !== undefined) validatePermissions(revoke);
  if (grant?.some(permission => revoke?.includes(permission))) reject('conflicting_member_permissions');
  if (enabled !== undefined && typeof enabled !== 'boolean') reject('invalid_member_enabled');
  if (note != null && (typeof note !== 'string' || note.length > 500)) reject('invalid_member_note');
  const expiry = expiresAt == null ? expiresAt : normalizeExpiry(expiresAt);

  const next = validatePolicy(policy);
  const existing = next.subjects.find(row => row.kind === 'user' && row.qq === qq);
  if (existing?.role === 'owner') reject('owner_record_protected');
  if (op === 'add' ? existing : !existing) reject(op === 'add' ? 'member_already_exists' : 'member_not_found');
  const before = memberView(existing);
  let after = null;
  if (op === 'remove') {
    next.subjects.splice(next.subjects.indexOf(existing), 1);
  } else {
    const row = existing ?? {qq, kind: 'user', role: 'member', enabled: true, permissions: {}, mailRecipients: []};
    for (const permission of grant ?? []) row.permissions[permission] = true;
    for (const permission of revoke ?? []) delete row.permissions[permission];
    if (enabled !== undefined) row.enabled = enabled;
    if (note === null) delete row.note;
    else if (note !== undefined) row.note = note;
    if (expiry === null) delete row.expiresAt;
    else if (expiry !== undefined) row.expiresAt = expiry;
    if (!existing) next.subjects.push(row);
    after = memberView(row);
  }
  if (isDeepStrictEqual(before, after)) reject('access_change_noop');
  next.revision += 1;
  validatePolicy(next);
  return {next, before, after};
}

function describeMember(row) {
  if (!row) return '无记录';
  return [
    row.enabled ? '启用' : '停用',
    '权限 ' + (row.permissions.join('、') || '无'),
    '到期 ' + (row.expiresAt ?? '无期限'),
    '备注 ' + (row.note === null ? '无' : JSON.stringify(row.note)),
  ].join('，');
}

export function memberPreview(change, before, after, revision) {
  const verb = {add: '登记', update: '调整', remove: '移除'}[change.op];
  return [
    'QQ 成员白名单预览 · ' + verb + ' ' + change.qq,
    '修改前：' + describeMember(before),
    '修改后：' + describeMember(after),
    '配置版本：' + revision + ' → ' + (revision + 1),
    ...(change.op === 'remove' ? ['该成员的会话、文档及任务记录保留。'] : []),
    '确认后保存到仓库，按名单同步流程生效。',
  ].join('\n');
}

export function recipientKey(value) {
  if (typeof value !== 'string' || /[\r\n]/u.test(value)) reject('invalid_mail_recipient');
  const key = value.trim().toLowerCase();
  // One mailbox only. In particular no wildcard, display name or recipient list.
  const [local, domain] = key.split('@');
  if (key.length > 254 || !domain || key.indexOf('@') !== key.lastIndexOf('@') || local.length > 64
    || !/^[a-z0-9!#$%&'+/=^_\x60{|}~-]+(?:\.[a-z0-9!#$%&'+/=^_\x60{|}~-]+)*$/u.test(local)
    || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u.test(domain)) {
    reject('invalid_mail_recipient');
  }
  return key;
}

export function stringListChange(entries, change, parseKey) {
  const op = change?.op;
  assertFields(change, op === 'replace' ? ['op', 'key', 'replacement'] : ['op', 'key']);
  if (!['add', 'remove', 'replace'].includes(op)) reject('unknown_access_list_operation');
  const key = parseKey(change.key);
  const replacement = op === 'replace' ? parseKey(change.replacement) : undefined;
  const exists = entries.includes(key);
  if (op === 'add' ? exists : !exists) reject(op === 'add' ? 'access_entry_already_exists' : 'access_entry_not_found');
  if (replacement === key) reject('access_change_noop');
  if (replacement !== undefined && entries.includes(replacement)) reject('access_entry_already_exists');
  return {
    entries: op === 'add' ? [...entries, key] : entries.flatMap(entry => entry !== key ? [entry] : replacement ? [replacement] : []),
    change: {op, key, ...(replacement === undefined ? {} : {replacement})},
    before: op === 'add' ? null : key,
    after: op === 'remove' ? null : replacement ?? key,
  };
}

export function stringListView(entries) {
  return [...new Set(entries)].sort();
}

export function stringListPreview(label, before, after, effect, revision,
  activation = '确认后保存到仓库，按名单同步流程生效。') {
  return [
    label + '白名单预览',
    '修改前：' + (before === null ? '无记录' : JSON.stringify(before)),
    '修改后：' + (after === null ? '无记录' : JSON.stringify(after)),
    ...(revision === undefined ? [] : ['配置版本：' + revision + ' → ' + (revision + 1)]),
    effect,
    activation,
  ].join('\n');
}
