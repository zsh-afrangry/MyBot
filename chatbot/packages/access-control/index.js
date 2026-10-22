// Shared identity/capability checks; no filesystem I/O, model parsing or default-allow fallback.
// Runtime policy is compiled from config/access-control.json by sync-config. See docs/24.
import {PERMISSIONS, OWNER_PERMISSIONS, toolPermission} from './permissions.js';
export {PERMISSIONS, SHARED_PERMISSIONS, OWNER_PERMISSIONS, MEMBER_TOOLS, toolPermission} from './permissions.js';
export const CHANNEL = 'kurumi-qq';
export const QQ_ID = /^[0-9]{5,12}$/;
export class AccessError extends Error {
  constructor(code = 'access_denied') { super(code); this.code = code; }
}
const deny = code => { throw new AccessError(code); };
const obj = x => x && typeof x === 'object' && !Array.isArray(x);
const keysOnly = (x, keys) => obj(x) && Object.keys(x).every(k => keys.includes(k));
export const subjectKey = (id, kind = 'user') => `qq:${kind}:${id}`;
export const agentFor = row => row.role === 'owner' ? 'main' : `qq-user-${row.qq}`;
export const sessionFor = row => `agent:${agentFor(row)}:${CHANNEL}:direct:${row.qq}`;

export function validatePolicy(value) {
  if (!keysOnly(value, ['version', 'revision', 'subjects']) || value.version !== 1 || !Number.isSafeInteger(value.revision) || value.revision < 1 || !Array.isArray(value.subjects) || value.subjects.length > 100) deny('invalid_access_policy');
  const policy = structuredClone(value), ids = new Set();
  for (const row of policy.subjects) {
    if (!keysOnly(row, ['qq', 'kind', 'role', 'enabled', 'permissions', 'mailRecipients', 'note', 'expiresAt'])
      || typeof row.qq !== 'string' || !QQ_ID.test(row.qq) || !['user','group'].includes(row.kind)
      || !['owner','member'].includes(row.role) || typeof row.enabled !== 'boolean' || !obj(row.permissions)
      || Object.entries(row.permissions).some(([p,v]) => !PERMISSIONS.includes(p) || typeof v !== 'boolean')
      || (row.note !== undefined && (typeof row.note !== 'string' || row.note.length > 500))
      || (row.expiresAt != null && (typeof row.expiresAt !== 'string' || !/^\d{4}-\d\d-\d\dT/.test(row.expiresAt) || !Number.isFinite(Date.parse(row.expiresAt))))
      || !Array.isArray(row.mailRecipients) || row.mailRecipients.length > 20 || row.mailRecipients.some(s => typeof s !== 'string' || s !== s.trim().toLowerCase() || !/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(s))) deny('invalid_access_subject');
    const key = subjectKey(row.qq, row.kind);
    if (ids.has(key)) deny('duplicate_access_subject'); ids.add(key);
    if (row.role !== 'owner' && (OWNER_PERMISSIONS.some(p => row.permissions[p] === true) || row.mailRecipients.length)) deny('capability_requires_owner_isolation');
    if (row.kind === 'group' && (row.role === 'owner' || row.enabled || Object.values(row.permissions).some(Boolean))) deny('group_support_not_enabled');
  }
  const owners = policy.subjects.filter(r => r.role === 'owner');
  if (owners.length !== 1 || owners[0].kind !== 'user' || !owners[0].enabled || owners[0].expiresAt != null) deny('invalid_primary_owner');
  return policy;
}
export function accessPolicy(cfg) {
  const account = cfg?.channels?.[CHANNEL] ?? cfg;
  const policy = validatePolicy(account?.accessControl);
  if (account.ownerId !== policy.subjects.find(r => r.role === 'owner').qq) deny('owner_policy_mismatch');
  return policy;
}
export const primaryOwner = cfg => accessPolicy(cfg).subjects.find(r => r.role === 'owner');
export function activeSubject(cfg, id, permission, now = Date.now()) {
  const row = accessPolicy(cfg).subjects.find(r => r.kind === 'user' && r.qq === id);
  if (!row || !row.enabled || (row.expiresAt && Date.parse(row.expiresAt) <= now)) deny('identity_not_enabled');
  if (permission && (!PERMISSIONS.includes(permission) || row.permissions[permission] !== true)) deny('capability_not_allowed');
  return row;
}
export function actorFromContext(ctx, cfg) {
  const channel = ctx?.messageChannel ?? ctx?.deliveryContext?.channel;
  const id = ctx?.requesterSenderId;
  if (channel !== CHANNEL || typeof id !== 'string' || !QQ_ID.test(id) || (ctx.agentAccountId && ctx.agentAccountId !== 'default') || (ctx.deliveryContext?.accountId && ctx.deliveryContext.accountId !== 'default')) deny('untrusted_identity_context');
  const row = activeSubject(cfg, id, 'chat.use');
  if (ctx.sessionKey !== sessionFor(row) || (ctx.agentId && ctx.agentId !== agentFor(row)) || (ctx.deliveryContext?.to && ctx.deliveryContext.to !== `user:${id}`)
    || (row.role === 'owner' ? ctx.senderIsOwner !== true : ctx.senderIsOwner === true)) deny('untrusted_identity_context');
  return Object.freeze({id, key: subjectKey(id), kind: 'user', owner: row.role === 'owner', agentId: agentFor(row), sessionKey: ctx.sessionKey, accountId: 'default'});
}
export function assertCapability(actor, cfg, permission) {
  if (!actor || actor.key !== subjectKey(actor.id) || actor.kind !== 'user') deny('untrusted_identity_context');
  return activeSubject(cfg, actor.id, permission);
}
export function assertToolAccess(ctx, cfg, name, args = {}) {
  const actor = actorFromContext(ctx, cfg), permission = toolPermission(name, args);
  if (!permission) deny('unmapped_tool');
  assertCapability(actor, cfg, permission);
  if(name==='session_status' && !actor.owner && ((args.sessionKey && args.sessionKey!==actor.sessionKey)||args.model))deny('session_scope_not_allowed');
  return actor;
}
export function authorizedOwner(ctx, cfg, permission) {
  try { const actor = actorFromContext(ctx, cfg); if (!actor.owner) return false; if (permission) assertCapability(actor, cfg, permission); return true; } catch { return false; }
}
export function targetSubject(to, cfg, permission = 'qq.reply') {
  if (typeof to !== 'string') deny('invalid_delivery_target');
  const id = to.replace(/^kurumi-qq:/,'').replace(/^user:/,'');
  if (!QQ_ID.test(id)) deny('invalid_delivery_target');
  activeSubject(cfg, id, 'chat.use');
  return activeSubject(cfg, id, permission);
}
export function allowedMembers(cfg) {
  return accessPolicy(cfg).subjects.filter(r => r.kind === 'user' && r.enabled && r.permissions['chat.use'] && (!r.expiresAt || Date.parse(r.expiresAt) > Date.now()));
}
export function mailRecipients(cfg) { return [...primaryOwner(cfg).mailRecipients]; }

// A mandatory trusted host tool policy also covers built-in tools. Domain adapters recheck effects.
export function toolPolicyDecision(event, ctx, cfg) {
  try {
    const requester = ctx.requester;
    const owner = primaryOwner(cfg);
    // Gateway task handoff preserves trusted channel/account/owner authority but
    // omits senderId. Accept that explicit owner delegation only in minted task/
    // Cron lanes; a missing sender or partial requester alone grants nothing.
    const delegatedRequester = requester == null || (requester.channel === CHANNEL
      && (requester.senderId == null || requester.senderId === owner.qq) && requester.senderIsOwner === true
      && (!requester.accountId || requester.accountId === 'default'));
    const task = /^agent:(researcher|project-[a-z0-9-]+):kurumi-task-[a-f0-9]{24}$/.exec(ctx.sessionKey ?? '');
    // Background lanes are minted by the owner-only task tool/Gateway, and carry no member authority.
    if (task && ctx.agentId===task[1] && delegatedRequester) {
      activeSubject(cfg,owner.qq,'chat.use');activeSubject(cfg,owner.qq,task[1]==='researcher'?'tasks.research':'tasks.code');
      const tools=cfg.agents?.entries?.[ctx.agentId]?.tools?.allow??[];
      if(tools.includes(event.toolName)||['tool_search','tool_describe','tool_call'].includes(event.toolName))return;
      deny('unmapped_background_tool');
    }
    // OpenClaw Cron runs carry only the delivery channel/account, no sender fields
    // (2026-10-20 weather denials). That bare context counts as the system call in
    // the weather lane only; any sender id or owner flag still needs delegation.
    const cronDelivery = requester != null && requester.channel === CHANNEL && requester.senderId == null
      && requester.senderIsOwner == null && (!requester.accountId || requester.accountId === 'default');
    if (ctx.agentId === 'main' && /^agent:main:cron:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}(?::run:[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})?$/.test(ctx.sessionKey ?? '') && (delegatedRequester || cronDelivery)
      && ['personal_weather_get_brief','tool_search','tool_describe','tool_call'].includes(event.toolName)) {
      activeSubject(cfg,owner.qq,'chat.use');activeSubject(cfg,owner.qq,'weather.read');return;
    }
    if (requester?.channel===CHANNEL) {
      assertToolAccess({messageChannel:requester.channel,agentAccountId:requester.accountId,
        requesterSenderId:requester.senderId,senderIsOwner:requester.senderIsOwner,
        agentId:ctx.agentId,sessionKey:ctx.sessionKey},cfg,event.toolName,event.params);
      return;
    }
    deny('untrusted_identity_context');
  } catch (error) { return {block: true, blockReason: error instanceof AccessError ? error.code : 'invalid_access_policy'}; }
}
