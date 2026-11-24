import {
  DEFAULT_FILES_LIMITS as DEFAULT_LIMITS,
  FilesError,
  filesFail as fail,
  validateFilesConfig,
} from '../../packages/scoped-lease/tiers.js';
import {formatBytes, sha256} from '../../packages/scoped-lease/index.js';

export const FILES_DOMAIN = 'host_files';
export const FILES_TOOL = 'kurumi_files';
export const DEFAULT_PROPOSAL_TTL_SECONDS = 1800;

export const proposalIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const snapshotIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const leaseIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/u;
export const sha256Pattern = /^[a-f0-9]{64}$/u;

export {DEFAULT_LIMITS, FilesError, fail, sha256, validateFilesConfig};

export function assertFields(value, keys, errorCode = 'invalid_files_arguments') {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) {
    fail(errorCode);
  }
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
