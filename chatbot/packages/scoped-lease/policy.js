import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {isWakeSession} from '../proactive-core/policy.js';

export const LEASE_DOMAIN = 'scoped_lease';
export const LEASE_TOOL = 'kurumi_lease';

export const proposalIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const leaseIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;

export const LEASE_LIMITS = Object.freeze({
  minTtlSeconds: 60,
  maxTtlSeconds: 14400,
  defaultTtlSeconds: 1800,
  minMaxOps: 1,
  maxMaxOps: 200,
  defaultMaxOps: 20,
  minMaxBytes: 1024,
  maxMaxBytes: 256 * 1024 * 1024,
  defaultMaxBytes: 32 * 1024 * 1024,
  maxRoots: 16,
  maxActions: 16,
  proposalTtlSeconds: 1800,
});

export const ELIGIBLE_LEASE_ACTIONS = Object.freeze([
  'files.write',
  'files.delete',
  'files.move',
  'files.copy',
  'files.batch_delete',
  'files.batch_move',
  'files.batch_copy',
  'files.cleanup_dir',
  'files.restore',
]);

const ACTION_LABELS = Object.freeze({
  'files.write': '文件写入/编辑',
  'files.delete': '单文件删除',
  'files.move': '单文件移动/改名',
  'files.copy': '单文件复制',
  'files.batch_delete': '批量删除',
  'files.batch_move': '批量移动/改名',
  'files.batch_copy': '批量复制',
  'files.cleanup_dir': '目录清理',
  'files.restore': '快照恢复',
});

export class ScopedLeaseError extends Error {
  constructor(code = 'scoped_lease_failed') {
    super(code);
    this.code = code;
  }
}

export function fail(code) {
  throw new ScopedLeaseError(code);
}

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function insideRoot(candidate, root) {
  return candidate === root || candidate.startsWith(root + path.sep);
}

export function assertFields(value, keys, errorCode = 'invalid_lease_arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    fail(errorCode);
  }
}

/** Reject proactive wake / Cron contexts: Stage 2A leases are interactive-only. */
export function assertInteractiveLeaseContext(ctx) {
  const sessionKey = typeof ctx?.sessionKey === 'string' ? ctx.sessionKey : '';
  if (isWakeSession(ctx) || /^agent:main:cron:/u.test(sessionKey)) {
    fail('lease_forbidden_in_wake_session');
  }
  if (ctx?.agentId !== 'main' || typeof ctx?.sessionId !== 'string' || !ctx.sessionId) {
    fail('lease_requires_owner_chat');
  }
}

function validateLabel(value) {
  if (typeof value !== 'string') fail('invalid_lease_plan');
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > 80 || /[\x00-\x1f\x7f]/u.test(trimmed)) {
    fail('invalid_lease_plan');
  }
  return trimmed;
}

export function validateLeasePlan(raw, {validateRoot, eligibleActions = ELIGIBLE_LEASE_ACTIONS} = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid_lease_plan');
  assertFields(raw, ['label', 'actions', 'roots', 'maxOps', 'maxBytes', 'ttlSeconds'], 'invalid_lease_plan');
  if (typeof validateRoot !== 'function') fail('invalid_lease_configuration');

  const label = validateLabel(raw.label);
  const allowedActions = new Set(eligibleActions);
  if (!Array.isArray(raw.actions) || raw.actions.length === 0 || raw.actions.length > LEASE_LIMITS.maxActions) {
    fail('invalid_lease_plan');
  }
  const actions = [];
  const seenActions = new Set();
  for (const item of raw.actions) {
    if (typeof item !== 'string' || !item.trim()) fail('invalid_lease_plan');
    const action = item.trim();
    if (!allowedActions.has(action)) fail('lease_action_not_eligible');
    if (!seenActions.has(action)) {
      seenActions.add(action);
      actions.push(action);
    }
  }
  actions.sort();

  if (!Array.isArray(raw.roots) || raw.roots.length === 0 || raw.roots.length > LEASE_LIMITS.maxRoots) {
    fail('invalid_lease_plan');
  }
  const roots = [];
  const seenRoots = new Set();
  for (const item of raw.roots) {
    if (typeof item !== 'string' || !item || !path.isAbsolute(item) || /[\x00-\x1f\x7f]/u.test(item)) {
      fail('invalid_lease_plan');
    }
    const resolved = validateRoot(item);
    if (typeof resolved !== 'string' || !path.isAbsolute(resolved)) fail('lease_root_not_allowed');
    let canonical;
    try {
      const lstat = fs.lstatSync(resolved);
      if (lstat.isSymbolicLink() || !lstat.isDirectory()) fail('lease_root_not_allowed');
      canonical = fs.realpathSync(resolved);
      if (canonical !== resolved) fail('lease_root_not_allowed');
    } catch (error) {
      if (error instanceof ScopedLeaseError) throw error;
      fail('lease_root_not_allowed');
    }
    if (!seenRoots.has(canonical)) {
      seenRoots.add(canonical);
      roots.push(canonical);
    }
  }
  roots.sort();

  const maxOps = raw.maxOps ?? LEASE_LIMITS.defaultMaxOps;
  if (!Number.isSafeInteger(maxOps) || maxOps < LEASE_LIMITS.minMaxOps || maxOps > LEASE_LIMITS.maxMaxOps) {
    fail('lease_quota_out_of_range');
  }

  const maxBytes = raw.maxBytes ?? LEASE_LIMITS.defaultMaxBytes;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < LEASE_LIMITS.minMaxBytes || maxBytes > LEASE_LIMITS.maxMaxBytes) {
    fail('lease_quota_out_of_range');
  }

  const ttlSeconds = raw.ttlSeconds ?? LEASE_LIMITS.defaultTtlSeconds;
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds < LEASE_LIMITS.minTtlSeconds || ttlSeconds > LEASE_LIMITS.maxTtlSeconds) {
    fail('lease_quota_out_of_range');
  }

  return Object.freeze({
    label,
    actions: Object.freeze(actions),
    roots: Object.freeze(roots),
    maxOps,
    maxBytes,
    ttlSeconds,
  });
}

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round((bytes / 1024) * 10) / 10} KB`;
  return `${Math.round((bytes / (1024 * 1024)) * 10) / 10} MB`;
}

export function formatDuration(seconds) {
  if (seconds < 60) return `${seconds} 秒`;
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  const rem = mins % 60;
  return rem === 0 ? `${hours} 小时` : `${hours} 小时 ${rem} 分钟`;
}

export function buildLeasePreview(plan) {
  const actionLabels = plan.actions.map(name => ACTION_LABELS[name] ?? name).join('、');
  const rootSummary = plan.roots.length <= 2
    ? plan.roots.join('、')
    : `${plan.roots.slice(0, 2).join('、')} 等 ${plan.roots.length} 个目录`;
  const lines = [
    '有界任务租约待确认',
    `用途：${plan.label}`,
    `允许动作：${actionLabels}`,
    `作用目录：${rootSummary}`,
    `配额上限：最多 ${plan.maxOps} 次操作 / 累计 ${formatBytes(plan.maxBytes)}，有效期 ${formatDuration(plan.ttlSeconds)}`,
    '约束：仅限当前交互会话使用、随时可吊销，不放开红线目录，后台唤醒不继承。',
  ];
  return {previewText: lines.join('\n'), presentationFacts: lines};
}
