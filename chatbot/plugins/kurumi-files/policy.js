import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {formatBytes, insideRoot} from '../../packages/scoped-lease/index.js';

export const FILES_DOMAIN = 'host_files';
export const FILES_TOOL = 'kurumi_files';
export const DEFAULT_PROPOSAL_TTL_SECONDS = 1800;

export const proposalIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const snapshotIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const leaseIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const sha256Pattern = /^[a-f0-9]{64}$/u;

export const DEFAULT_LIMITS = Object.freeze({
  maxReadChars: 32000,
  maxWriteBytes: 4 * 1024 * 1024,
  maxBatchItems: 100,
  maxSnapshotFileBytes: 10 * 1024 * 1024,
  maxSnapshotTotalBytes: 200 * 1024 * 1024,
  snapshotRetentionDays: 7,
  proposalTtlSeconds: DEFAULT_PROPOSAL_TTL_SECONDS,
});

export class FilesError extends Error {
  constructor(code = 'files_operation_failed') {
    super(code);
    this.code = code;
  }
}

export function fail(code) {
  throw new FilesError(code);
}

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export function assertFields(value, keys, errorCode = 'invalid_files_arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    fail(errorCode);
  }
}

function validateText(value, maxLength, code) {
  if (typeof value !== 'string') fail(code);
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > maxLength || /[\x00-\x1f\x7f]/u.test(trimmed)) fail(code);
  return trimmed;
}

function normalizeAbsoluteDirectory(rawPath, code, {verifyRoots = true, mustNotBeSymlink = true} = {}) {
  if (typeof rawPath !== 'string' || !rawPath || rawPath.length > 4096 || /[\x00-\x1f\x7f]/u.test(rawPath)) {
    fail(code);
  }
  if (!path.isAbsolute(rawPath)) fail(code);
  const normalized = path.resolve(rawPath);
  if (normalized === '/') fail(code);
  if (verifyRoots) {
    try {
      const lstat = fs.lstatSync(normalized);
      if (mustNotBeSymlink && lstat.isSymbolicLink()) fail(code);
      if (!lstat.isDirectory()) fail(code);
      if (fs.realpathSync(normalized) !== normalized) fail(code);
    } catch (error) {
      if (error instanceof FilesError) throw error;
      if (error.code !== 'ENOENT') fail(code);
    }
  }
  return normalized;
}

function normalizeRootEntries(list, tier, {verifyRoots = true} = {}) {
  if (list === undefined) return Object.freeze([]);
  if (!Array.isArray(list) || list.length > 32) fail('invalid_files_config');
  const seen = new Set();
  const out = [];
  const allowedKeys = ['path', 'label', 'readOnly', 'allowLease'];
  for (const item of list) {
    if (!item || typeof item !== 'object' || Array.isArray(item)
      || Object.keys(item).some(key => !allowedKeys.includes(key))) {
      fail('invalid_files_config');
    }
    const dir = normalizeAbsoluteDirectory(item.path, 'invalid_files_config', {verifyRoots});
    if (seen.has(dir)) fail('invalid_files_config');
    seen.add(dir);
    if (item.readOnly !== undefined && typeof item.readOnly !== 'boolean') fail('invalid_files_config');
    if (item.allowLease !== undefined && typeof item.allowLease !== 'boolean') fail('invalid_files_config');
    const readOnly = item.readOnly === true;
    const allowLease = item.allowLease === true;
    if (tier !== 'T2' && readOnly) fail('invalid_files_config');
    if (readOnly && allowLease) fail('invalid_files_config');
    out.push(Object.freeze({
      path: dir,
      label: validateText(item.label, 80, 'invalid_files_config'),
      readOnly,
      allowLease: tier === 'T2' ? allowLease : !readOnly,
    }));
  }
  return Object.freeze(out);
}

function validateInt(value, fallback, min, max) {
  const num = value ?? fallback;
  if (!Number.isSafeInteger(num) || num < min || num > max) fail('invalid_files_config');
  return num;
}

export function validateFilesConfig(raw, {stateRoot, verifyRoots = true} = {}) {
  const config = raw ?? {};
  if (typeof config !== 'object' || Array.isArray(config)) fail('invalid_files_config');
  const allowedTop = [
    'homeDir', 'defaultWorkspace', 't0Roots', 't1Roots', 't2Roots', 't3Roots',
    'maxReadChars', 'maxWriteBytes', 'maxBatchItems',
    'maxSnapshotFileBytes', 'maxSnapshotTotalBytes', 'snapshotRetentionDays', 'proposalTtlSeconds',
  ];
  if (Object.keys(config).some(key => !allowedTop.includes(key))) fail('invalid_files_config');

  const homeDir = config.homeDir !== undefined
    ? normalizeAbsoluteDirectory(config.homeDir, 'invalid_files_config', {verifyRoots})
    : undefined;

  const t0Roots = normalizeRootEntries(config.t0Roots, 'T0', {verifyRoots});
  const t1Roots = normalizeRootEntries(config.t1Roots, 'T1', {verifyRoots});
  const t2Roots = normalizeRootEntries(config.t2Roots, 'T2', {verifyRoots});

  const t3Roots = [];
  if (config.t3Roots !== undefined) {
    if (!Array.isArray(config.t3Roots) || config.t3Roots.length > 64) fail('invalid_files_config');
    for (const entry of config.t3Roots) {
      if (typeof entry !== 'string' || !entry || !path.isAbsolute(entry) || /[\x00-\x1f\x7f]/u.test(entry)) {
        fail('invalid_files_config');
      }
      t3Roots.push(path.resolve(entry));
    }
  }

  let defaultWorkspace;
  if (config.defaultWorkspace !== undefined) {
    defaultWorkspace = normalizeAbsoluteDirectory(config.defaultWorkspace, 'invalid_files_config', {verifyRoots});
    if (!t0Roots.some(r => insideRoot(defaultWorkspace, r.path))) {
      fail('invalid_files_config');
    }
  } else if (t0Roots.length > 0) {
    defaultWorkspace = t0Roots[0].path;
  }

  if (stateRoot) {
    const normState = path.resolve(stateRoot);
    for (const root of [...t0Roots, ...t1Roots, ...t2Roots]) {
      if (insideRoot(root.path, normState)) fail('invalid_files_config');
    }
  }

  return Object.freeze({
    homeDir,
    defaultWorkspace,
    t0Roots,
    t1Roots,
    t2Roots,
    t3Roots: Object.freeze([...new Set(t3Roots)]),
    maxReadChars: validateInt(config.maxReadChars, DEFAULT_LIMITS.maxReadChars, 1000, 200000),
    maxWriteBytes: validateInt(config.maxWriteBytes, DEFAULT_LIMITS.maxWriteBytes, 1024, 67108864),
    maxBatchItems: validateInt(config.maxBatchItems, DEFAULT_LIMITS.maxBatchItems, 1, 500),
    maxSnapshotFileBytes: validateInt(config.maxSnapshotFileBytes, DEFAULT_LIMITS.maxSnapshotFileBytes, 1024, 134217728),
    maxSnapshotTotalBytes: validateInt(config.maxSnapshotTotalBytes, DEFAULT_LIMITS.maxSnapshotTotalBytes, 65536, 2147483648),
    snapshotRetentionDays: validateInt(config.snapshotRetentionDays, DEFAULT_LIMITS.snapshotRetentionDays, 1, 365),
    proposalTtlSeconds: validateInt(config.proposalTtlSeconds, DEFAULT_LIMITS.proposalTtlSeconds, 60, 86400),
  });
}

export function filesPolicyFingerprint(cfg) {
  return sha256(JSON.stringify({
    homeDir: cfg.homeDir ?? null,
    t0Roots: cfg.t0Roots,
    t1Roots: cfg.t1Roots,
    t2Roots: cfg.t2Roots,
    t3Roots: cfg.t3Roots,
  }));
}

const OP_LABELS = Object.freeze({
  batch_delete: '批量删除',
  batch_move: '批量移动/改名',
  batch_copy: '批量复制',
  cleanup_dir: '目录清理',
  t2_write: '受控敏感区写入',
  t2_edit: '受控敏感区编辑',
  t2_delete: '受控敏感区删除',
  t2_move: '受控敏感区移动',
});

function shortSample(name) {
  const s = String(name);
  return s.length <= 42 ? s : '...' + s.slice(-39);
}

export function buildFilesPreview(plan) {
  const label = OP_LABELS[plan.operation] ?? plan.operation;
  const samples = (plan.sampleNames ?? []).slice(0, 3).map(shortSample);
  const more = plan.itemCount > samples.length ? ` 等共 ${plan.itemCount} 项` : '';
  const sampleLine = samples.length ? `${samples.join('、')}${more}` : `共 ${plan.itemCount} 项`;
  const snapshotNote = plan.hasOversizeFiles
    ? '执行前自动备份常规原件至私有恢复区；超限大文件已标记跳过快照。'
    : '执行前自动备份受影响原件至私有恢复区，可按快照恢复。';
  const lines = [
    '受控文件操作待确认',
    `操作：${label}（${plan.summaryTarget}）`,
    `规模：涉及 ${plan.itemCount} 项（约 ${formatBytes(plan.totalBytes)}）`,
    `示例：${sampleLine}`,
    `兜底：${snapshotNote}`,
    '执行范围：仅处理本次冻结清单中的目标，不越权改动红线目录。',
  ];
  return {previewText: lines.join('\n'), presentationFacts: lines};
}
