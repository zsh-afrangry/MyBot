import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {businessFeedback} from '../../packages/feedback-core/index.js';
import {readStructuredFile} from '../../packages/office-reader/index.js';
import {
  LEASE_DOMAIN,
  assertFields as assertLeaseFields,
  buildLeasePreview,
  fail as failLease,
  leaseIdPattern as validLeaseIdPattern,
  proposalIdPattern as validLeaseProposalPattern,
  validateLeasePlan,
} from '../../packages/scoped-lease/index.js';
import {
  FILES_DOMAIN,
  FILES_TOOL,
  FilesError,
  assertFields,
  buildFilesPreview,
  fail,
  proposalIdPattern,
  sha256,
  sha256Pattern,
  snapshotIdPattern,
  validateFilesConfig,
} from './policy.js';
import {buildOperationPlan, verifyPlanNotDrifted} from './plan.js';
import {
  buildRedlineSet,
  canApplyLeaseToTierInfo,
  classifyNormalizedPath,
  resolveSafePath,
} from './tiers.js';

const FILE_ACTIONS = Object.freeze({
  roots: ['action'],
  list: ['action', 'path', 'maxEntries'],
  stat: ['action', 'path'],
  read: ['action', 'path', 'offset', 'limit'],
  read_structured: ['action', 'path', 'format', 'sheet', 'offset', 'limit', 'query'],
  search: ['action', 'path', 'pattern', 'query', 'maxResults'],
  snapshots: ['action', 'pathPrefix', 'limit'],
  status: ['action', 'proposalId'],
  mkdir: ['action', 'path', 'recursive', 'leaseId'],
  write: ['action', 'path', 'content', 'mode', 'expectedSha256', 'leaseId'],
  edit: ['action', 'path', 'oldText', 'newText', 'replaceAll', 'expectedSha256', 'leaseId'],
  copy: ['action', 'sourcePath', 'targetPath', 'overwrite', 'leaseId'],
  move: ['action', 'sourcePath', 'targetPath', 'overwrite', 'leaseId'],
  delete: ['action', 'path', 'expectedSha256', 'leaseId'],
  restore: ['action', 'snapshotId', 'targetPath', 'overwrite', 'leaseId'],
  propose: ['action', 'operation', 'path', 'sourcePath', 'targetPath', 'paths', 'items', 'content', 'mode', 'oldText', 'newText', 'replaceAll', 'overwrite', 'expectedSha256', 'pattern', 'includeRoot', 'allowOversizeSkip'],
  commit: ['action', 'proposalId'],
  apply_leased: ['action', 'leaseId', 'operation', 'path', 'sourcePath', 'targetPath', 'paths', 'items', 'content', 'mode', 'oldText', 'newText', 'replaceAll', 'overwrite', 'expectedSha256', 'pattern', 'includeRoot', 'allowOversizeSkip', 'snapshotId', 'recursive'],
});

const LEASE_ACTIONS = Object.freeze({
  list: ['action', 'includeInactive', 'limit'],
  status: ['action', 'leaseId', 'proposalId'],
  propose: ['action', 'label', 'actions', 'roots', 'maxOps', 'maxBytes', 'ttlSeconds'],
  commit: ['action', 'proposalId'],
  revoke: ['action', 'leaseId', 'reason'],
  revoke_all: ['action', 'reason'],
});

const SINGLE_OPERATIONS = new Set(['write', 'edit', 'delete', 'move', 'copy', 'restore', 'mkdir']);

function writeFileAtomic(targetPath, data, mode = 0o644) {
  const dir = path.dirname(targetPath);
  const temp = path.join(dir, `.kurumi-tmp-${process.pid}-${randomUUID()}`);
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data, 'utf8');
  const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, mode);
  try {
    let written = 0;
    while (written < buf.length) {
      written += fs.writeSync(fd, buf, written, buf.length - written);
    }
    fs.fsyncSync(fd);
  } catch (error) {
    fs.closeSync(fd);
    fs.rmSync(temp, {force: true});
    throw error;
  }
  fs.closeSync(fd);
  try {
    fs.renameSync(temp, targetPath);
  } catch (error) {
    fs.rmSync(temp, {force: true});
    throw error;
  }
  return buf.length;
}

function moveFileSafe(sourcePath, targetPath) {
  try {
    fs.renameSync(sourcePath, targetPath);
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
    const st = fs.lstatSync(sourcePath);
    if (!st.isFile()) throw error;
    const data = fs.readFileSync(sourcePath);
    writeFileAtomic(targetPath, data, st.mode & 0o777);
    fs.unlinkSync(sourcePath);
  }
}

function assertDirTreeSafeForMove(dirPath, cfg, redlineList) {
  const children = fs.readdirSync(dirPath, {withFileTypes: true});
  for (const child of children) {
    const childPath = path.join(dirPath, child.name);
    const lstat = fs.lstatSync(childPath);
    if (lstat.isSymbolicLink()) fail('files_symlink_not_allowed');
    const info = classifyNormalizedPath(childPath, cfg, redlineList);
    if (info.tier === 'T3') fail('files_redline_denied');
    if (info.tier === 'T2') fail('files_t2_subitem_blocked_in_cleanup');
    if (lstat.isDirectory()) assertDirTreeSafeForMove(childPath, cfg, redlineList);
  }
}

function compileSearchMatcher(pattern) {
  if (!pattern) return null;
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(pattern.includes('*') || pattern.includes('?') ? `^${escaped}$` : escaped, 'iu');
}

function assertParentDirReady(targetPath, {recursive = false, cfg, redlineList} = {}) {
  const parent = path.dirname(targetPath);
  let pStat;
  try {
    pStat = fs.lstatSync(parent);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (!recursive) fail('files_parent_not_found');
    const parentSafe = resolveSafePath(parent, cfg, redlineList, {forWrite: true});
    fs.mkdirSync(parentSafe.path, {recursive: true});
    return;
  }
  if (pStat.isSymbolicLink() || !pStat.isDirectory()) fail('files_parent_not_directory');
}

function assertExpectedSha(filePath, expectedSha256) {
  if (expectedSha256 === undefined || expectedSha256 === null) return;
  if (typeof expectedSha256 !== 'string' || !sha256Pattern.test(expectedSha256)) {
    fail('invalid_files_arguments');
  }
  const actual = sha256(fs.readFileSync(filePath));
  if (actual !== expectedSha256) fail('files_expected_sha_mismatch');
}

function authorizeMutation({
  leaseAction,
  tierInfos,
  paths,
  byteCount,
  leaseId,
  actor,
  check,
  isInteractiveOwner,
  leaseStore,
  targetSummary,
}) {
  if (tierInfos.some(t => t.readOnly)) fail('files_t2_readonly_denied');
  const needsLeaseForT2 = tierInfos.some(t => t.tier === 'T2');
  if (needsLeaseForT2 && !leaseId) fail('files_confirmation_required');
  if (needsLeaseForT2 && tierInfos.some(t => t.tier === 'T2' && !canApplyLeaseToTierInfo(t))) {
    fail('files_lease_not_eligible');
  }
  check();
  if (!leaseId) return null;
  if (!leaseStore) fail('files_lease_unavailable');
  return leaseStore.consume(leaseId, actor.id, {
    action: leaseAction,
    paths,
    opCount: 1,
    byteCount,
    tool: FILES_TOOL,
    targetSummary,
    isInteractiveOwner,
  });
}

function emitTrace(trace, payload) {
  try { trace?.(payload); } catch { /* Telemetry does not alter operation outcomes. */ }
}

function executeFrozenPlan(plan, {filesStore, actor, authMode, proposalId = null, leaseId = null}) {
  const snapshots = [];
  const results = [];
  const batchId = proposalId ?? leaseId;

  const snapIfRegular = (filePath, tier, opKind) => {
    const snap = filesStore.captureSnapshot(filePath, {
      owner: actor.id,
      opKind,
      tier,
      batchId,
      allowOversizeSkip: plan.allowOversizeSkip,
    });
    snapshots.push({path: filePath, ...snap});
    return snap.snapshotId ?? null;
  };

  switch (plan.operation) {
    case 'batch_delete':
    case 't2_delete': {
      const list = plan.operation === 't2_delete' ? [plan.entry] : plan.entries;
      for (const item of list) {
        const snapshotId = snapIfRegular(item.path, item.tier, plan.operation);
        fs.unlinkSync(item.path);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode,
          proposalId,
          leaseId,
          operation: plan.operation,
          tier: item.tier,
          targetPath: item.path,
          snapshotId,
          outcome: 'succeeded',
        });
        results.push({path: item.path, deleted: true, snapshotId});
      }
      break;
    }

    case 'batch_move':
    case 'batch_copy':
    case 't2_move': {
      const isCopy = plan.operation === 'batch_copy';
      const list = plan.operation === 't2_move' ? [plan.entry] : plan.entries;
      for (const item of list) {
        assertParentDirReady(item.targetPath);
        let snapshotId = null;
        if (item.overwrite && fs.existsSync(item.targetPath)) {
          snapshotId = snapIfRegular(item.targetPath, item.targetTier, `${plan.operation}.overwrite`);
        }
        if (isCopy) {
          const buf = fs.readFileSync(item.sourcePath);
          const srcStat = fs.lstatSync(item.sourcePath);
          writeFileAtomic(item.targetPath, buf, srcStat.mode & 0o777);
        } else {
          moveFileSafe(item.sourcePath, item.targetPath);
        }
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode,
          proposalId,
          leaseId,
          operation: plan.operation,
          tier: item.targetTier,
          targetPath: item.sourcePath,
          destinationPath: item.targetPath,
          snapshotId,
          outcome: 'succeeded',
        });
        results.push({sourcePath: item.sourcePath, targetPath: item.targetPath, snapshotId});
      }
      break;
    }

    case 'cleanup_dir': {
      for (const f of plan.files) {
        const snapshotId = snapIfRegular(f.path, f.tier, 'cleanup_dir');
        fs.unlinkSync(f.path);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode,
          proposalId,
          leaseId,
          operation: 'cleanup_dir',
          tier: f.tier,
          targetPath: f.path,
          snapshotId,
          outcome: 'succeeded',
        });
        results.push({path: f.path, kind: 'file', deleted: true, snapshotId});
      }
      for (const d of plan.dirs) {
        fs.rmdirSync(d.path);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode,
          proposalId,
          leaseId,
          operation: 'cleanup_dir.rmdir',
          tier: d.tier,
          targetPath: d.path,
          outcome: 'succeeded',
        });
        results.push({path: d.path, kind: 'dir', deleted: true});
      }
      break;
    }

    case 't2_write': {
      const item = plan.entry;
      assertParentDirReady(item.path);
      let snapshotId = null;
      let finalContent = item.content;
      if (item.fingerprint.exists) {
        if (item.expectedSha256) assertExpectedSha(item.path, item.expectedSha256);
        snapshotId = snapIfRegular(item.path, item.tier, 't2_write');
        if (item.mode === 'append') {
          finalContent = fs.readFileSync(item.path, 'utf8') + item.content;
        }
      }
      const bytesWritten = writeFileAtomic(item.path, finalContent);
      filesStore.recordAuditOp({
        owner: actor.id,
        authMode,
        proposalId,
        leaseId,
        operation: 't2_write',
        tier: item.tier,
        targetPath: item.path,
        snapshotId,
        outcome: 'succeeded',
        detail: {mode: item.mode, bytesWritten},
      });
      results.push({path: item.path, bytesWritten, snapshotId});
      break;
    }

    case 't2_edit': {
      const item = plan.entry;
      const snapshotId = snapIfRegular(item.path, item.tier, 't2_edit');
      const raw = fs.readFileSync(item.path, 'utf8');
      const parts = raw.split(item.oldText);
      const updated = item.replaceAll ? parts.join(item.newText) : parts[0] + item.newText + parts.slice(1).join(item.oldText);
      const bytesWritten = writeFileAtomic(item.path, updated);
      filesStore.recordAuditOp({
        owner: actor.id,
        authMode,
        proposalId,
        leaseId,
        operation: 't2_edit',
        tier: item.tier,
        targetPath: item.path,
        snapshotId,
        outcome: 'succeeded',
        detail: {replacements: item.replacements, bytesWritten},
      });
      results.push({path: item.path, bytesWritten, replacements: item.replacements, snapshotId});
      break;
    }

    default:
      fail('invalid_files_arguments');
  }

  return {snapshots, results};
}

export function createFilesService(rawConfig, filesStore, leaseStore, {stateRoot, trace, verifyRoots = true} = {}) {
  const inflight = new Set();
  const resolveConfig = () => {
    const raw = typeof rawConfig === 'function' ? rawConfig() : rawConfig;
    const cfg = validateFilesConfig(raw, {stateRoot, verifyRoots});
    return {cfg, redlineList: buildRedlineSet(cfg, stateRoot)};
  };

  async function runSingleAction(args, request, forcedLeaseId = null) {
    const {actor, check, correlation = {}, isInteractiveOwner} = request;
    const {cfg, redlineList} = resolveConfig();
    const leaseId = forcedLeaseId ?? args.leaseId ?? null;

    switch (args.action) {
      case 'mkdir': {
        const recursive = args.recursive === true;
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true});
        if (target.exists) fail('files_target_exists');
        if (!recursive) assertParentDirReady(target.path);
        else resolveSafePath(path.dirname(target.path), cfg, redlineList, {forWrite: true});

        const lease = authorizeMutation({
          leaseAction: 'files.write',
          tierInfos: [target],
          paths: [target.path],
          byteCount: 0,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: target.path,
        });
        fs.mkdirSync(target.path, {recursive});
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: 'mkdir',
          tier: target.tier,
          targetPath: target.path,
          outcome: 'succeeded',
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {operation: 'mkdir', tier: target.tier, authMode: lease ? 'lease' : 'direct', targetPath: target.path},
        });
        return {ok: true, action: 'mkdir', path: target.path, tier: target.tier, ...(lease ? {lease} : {})};
      }

      case 'write': {
        if (typeof args.content !== 'string') fail('invalid_files_arguments');
        const mode = args.mode ?? 'create';
        if (!['create', 'overwrite', 'append'].includes(mode)) fail('invalid_files_arguments');
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (mode === 'create' && target.exists) fail('files_target_exists');
        if (target.exists && !target.lstat?.isFile()) fail('files_not_regular_file');
        assertParentDirReady(target.path);
        if (target.exists && args.expectedSha256 !== undefined) assertExpectedSha(target.path, args.expectedSha256);

        let finalContent = args.content;
        if (mode === 'append' && target.exists) {
          const existingBuf = fs.readFileSync(target.path);
          if (existingBuf.includes(0)) fail('files_binary_not_supported');
          finalContent = existingBuf.toString('utf8') + args.content;
        }
        const byteCount = Buffer.byteLength(finalContent, 'utf8');
        if (byteCount > cfg.maxWriteBytes) fail('files_write_too_large');
        if (target.exists && target.lstat.size > cfg.maxSnapshotFileBytes && !leaseId) {
          fail('files_snapshot_too_large_requires_confirmation');
        }

        const lease = authorizeMutation({
          leaseAction: 'files.write',
          tierInfos: [target],
          paths: [target.path],
          byteCount,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: target.path,
        });

        let snapshot = null;
        if (target.exists) {
          snapshot = filesStore.captureSnapshot(target.path, {
            owner: actor.id,
            opKind: `write.${mode}`,
            tier: target.tier,
            batchId: leaseId,
            allowOversizeSkip: Boolean(leaseId && args.allowOversizeSkip === true),
          });
        }
        const bytesWritten = writeFileAtomic(target.path, finalContent);
        const digest = sha256(Buffer.from(finalContent, 'utf8'));
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: `write.${mode}`,
          tier: target.tier,
          targetPath: target.path,
          snapshotId: snapshot?.snapshotId ?? null,
          outcome: 'succeeded',
          detail: {bytesWritten},
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {
            operation: `write.${mode}`,
            tier: target.tier,
            authMode: lease ? 'lease' : 'direct',
            targetPath: target.path,
            snapshotId: snapshot?.snapshotId ?? null,
            bytesWritten,
          },
        });
        return {
          ok: true,
          action: 'write',
          path: target.path,
          tier: target.tier,
          created: !target.exists,
          bytesWritten,
          sha256: digest,
          ...(snapshot?.snapshotId ? {snapshotId: snapshot.snapshotId} : {}),
          ...(snapshot?.snapshotSkipped ? {snapshotSkipped: snapshot.snapshotSkipped} : {}),
          ...(lease ? {lease} : {}),
        };
      }

      case 'edit': {
        if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') {
          fail('invalid_files_arguments');
        }
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (!target.exists || !target.lstat?.isFile()) fail('files_not_regular_file');
        if (target.lstat.size > cfg.maxWriteBytes) fail('files_write_too_large');
        const buf = fs.readFileSync(target.path);
        if (buf.includes(0)) fail('files_binary_not_supported');
        if (args.expectedSha256 !== undefined) {
          if (typeof args.expectedSha256 !== 'string' || !sha256Pattern.test(args.expectedSha256)) {
            fail('invalid_files_arguments');
          }
          if (sha256(buf) !== args.expectedSha256) fail('files_expected_sha_mismatch');
        }
        const raw = buf.toString('utf8');
        const parts = raw.split(args.oldText);
        if (parts.length === 1) fail('files_edit_target_not_found');
        if (parts.length > 2 && args.replaceAll !== true) fail('files_edit_target_ambiguous');
        const updated = args.replaceAll === true
          ? parts.join(args.newText)
          : parts[0] + args.newText + parts.slice(1).join(args.oldText);
        const byteCount = Buffer.byteLength(updated, 'utf8');
        if (byteCount > cfg.maxWriteBytes) fail('files_write_too_large');
        if (target.lstat.size > cfg.maxSnapshotFileBytes && !leaseId) {
          fail('files_snapshot_too_large_requires_confirmation');
        }

        const lease = authorizeMutation({
          leaseAction: 'files.write',
          tierInfos: [target],
          paths: [target.path],
          byteCount,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: target.path,
        });

        const snapshot = filesStore.captureSnapshot(target.path, {
          owner: actor.id,
          opKind: 'edit',
          tier: target.tier,
          batchId: leaseId,
          allowOversizeSkip: Boolean(leaseId && args.allowOversizeSkip === true),
        });
        const bytesWritten = writeFileAtomic(target.path, updated);
        const replacements = args.replaceAll === true ? parts.length - 1 : 1;
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: 'edit',
          tier: target.tier,
          targetPath: target.path,
          snapshotId: snapshot.snapshotId ?? null,
          outcome: 'succeeded',
          detail: {replacements, bytesWritten},
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {operation: 'edit', tier: target.tier, authMode: lease ? 'lease' : 'direct', targetPath: target.path, snapshotId: snapshot.snapshotId ?? null},
        });
        return {
          ok: true,
          action: 'edit',
          path: target.path,
          tier: target.tier,
          replacements,
          bytesWritten,
          sha256: sha256(Buffer.from(updated, 'utf8')),
          ...(snapshot.snapshotId ? {snapshotId: snapshot.snapshotId} : {}),
          ...(lease ? {lease} : {}),
        };
      }

      case 'copy': {
        const src = resolveSafePath(args.sourcePath, cfg, redlineList, {forWrite: false, allowRootItself: false});
        if (!src.exists || !src.lstat?.isFile()) fail('files_not_regular_file');
        const dst = resolveSafePath(args.targetPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (src.canonicalPath === dst.path) fail('invalid_files_arguments');
        assertParentDirReady(dst.path);
        const overwrite = args.overwrite === true;
        if (dst.exists && !overwrite) fail('files_target_exists');
        if (dst.exists && !dst.lstat?.isFile()) fail('files_not_regular_file');
        if (src.lstat.size > cfg.maxWriteBytes) fail('files_write_too_large');
        if (dst.exists && dst.lstat.size > cfg.maxSnapshotFileBytes && !leaseId) {
          fail('files_snapshot_too_large_requires_confirmation');
        }

        const lease = authorizeMutation({
          leaseAction: 'files.copy',
          tierInfos: [dst],
          paths: [dst.path],
          byteCount: src.lstat.size,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: `${src.path} -> ${dst.path}`,
        });

        let snapshot = null;
        if (dst.exists) {
          snapshot = filesStore.captureSnapshot(dst.path, {
            owner: actor.id,
            opKind: 'copy.overwrite',
            tier: dst.tier,
            batchId: leaseId,
            allowOversizeSkip: Boolean(leaseId && args.allowOversizeSkip === true),
          });
        }
        const data = fs.readFileSync(src.canonicalPath);
        const bytesWritten = writeFileAtomic(dst.path, data, src.lstat.mode & 0o777);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: 'copy',
          tier: dst.tier,
          targetPath: src.path,
          destinationPath: dst.path,
          snapshotId: snapshot?.snapshotId ?? null,
          outcome: 'succeeded',
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {operation: 'copy', tier: dst.tier, authMode: lease ? 'lease' : 'direct', targetPath: src.path, destinationPath: dst.path, snapshotId: snapshot?.snapshotId ?? null},
        });
        return {
          ok: true,
          action: 'copy',
          sourcePath: src.path,
          targetPath: dst.path,
          tier: dst.tier,
          bytesWritten,
          ...(snapshot?.snapshotId ? {snapshotId: snapshot.snapshotId} : {}),
          ...(lease ? {lease} : {}),
        };
      }

      case 'move': {
        const src = resolveSafePath(args.sourcePath, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (!src.exists) fail('files_not_found');
        const dst = resolveSafePath(args.targetPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (src.path === dst.path) fail('invalid_files_arguments');
        assertParentDirReady(dst.path);
        const overwrite = args.overwrite === true;

        if (src.lstat?.isDirectory()) {
          if (dst.exists) fail('files_target_exists');
          assertDirTreeSafeForMove(src.path, cfg, redlineList);
        } else if (src.lstat?.isFile()) {
          if (dst.exists && !overwrite) fail('files_target_exists');
          if (dst.exists && !dst.lstat?.isFile()) fail('files_not_regular_file');
          if (dst.exists && dst.lstat.size > cfg.maxSnapshotFileBytes && !leaseId) {
            fail('files_snapshot_too_large_requires_confirmation');
          }
        } else {
          fail('files_not_regular_file');
        }

        const byteCount = src.lstat.isFile() ? src.lstat.size : 0;
        const lease = authorizeMutation({
          leaseAction: 'files.move',
          tierInfos: [src, dst],
          paths: [src.path, dst.path],
          byteCount,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: `${src.path} -> ${dst.path}`,
        });

        let snapshot = null;
        if (dst.exists && dst.lstat?.isFile()) {
          snapshot = filesStore.captureSnapshot(dst.path, {
            owner: actor.id,
            opKind: 'move.overwrite',
            tier: dst.tier,
            batchId: leaseId,
            allowOversizeSkip: Boolean(leaseId && args.allowOversizeSkip === true),
          });
        }
        moveFileSafe(src.path, dst.path);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: 'move',
          tier: dst.tier,
          targetPath: src.path,
          destinationPath: dst.path,
          snapshotId: snapshot?.snapshotId ?? null,
          outcome: 'succeeded',
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {operation: 'move', tier: dst.tier, authMode: lease ? 'lease' : 'direct', targetPath: src.path, destinationPath: dst.path, snapshotId: snapshot?.snapshotId ?? null},
        });
        return {
          ok: true,
          action: 'move',
          sourcePath: src.path,
          targetPath: dst.path,
          tier: dst.tier,
          ...(snapshot?.snapshotId ? {snapshotId: snapshot.snapshotId} : {}),
          ...(lease ? {lease} : {}),
        };
      }

      case 'delete': {
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (!target.exists) fail('files_not_found');

        if (target.lstat?.isDirectory()) {
          if (fs.readdirSync(target.path).length > 0) fail('files_directory_not_empty_use_cleanup');
          const lease = authorizeMutation({
            leaseAction: 'files.delete',
            tierInfos: [target],
            paths: [target.path],
            byteCount: 0,
            leaseId,
            actor,
            check,
            isInteractiveOwner,
            leaseStore,
            targetSummary: target.path,
          });
          fs.rmdirSync(target.path);
          filesStore.recordAuditOp({
            owner: actor.id,
            authMode: lease ? 'lease' : 'direct',
            leaseId,
            operation: 'delete.rmdir',
            tier: target.tier,
            targetPath: target.path,
            outcome: 'succeeded',
          });
          return {ok: true, action: 'delete', path: target.path, kind: 'dir', tier: target.tier, ...(lease ? {lease} : {})};
        }

        if (!target.lstat?.isFile()) fail('files_not_regular_file');
        if (args.expectedSha256 !== undefined) assertExpectedSha(target.path, args.expectedSha256);
        if (target.lstat.size > cfg.maxSnapshotFileBytes && !leaseId) {
          fail('files_snapshot_too_large_requires_confirmation');
        }

        const lease = authorizeMutation({
          leaseAction: 'files.delete',
          tierInfos: [target],
          paths: [target.path],
          byteCount: target.lstat.size,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: target.path,
        });

        const snapshot = filesStore.captureSnapshot(target.path, {
          owner: actor.id,
          opKind: 'delete',
          tier: target.tier,
          batchId: leaseId,
          allowOversizeSkip: Boolean(leaseId && args.allowOversizeSkip === true),
        });
        fs.unlinkSync(target.path);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: 'delete',
          tier: target.tier,
          targetPath: target.path,
          snapshotId: snapshot.snapshotId ?? null,
          outcome: 'succeeded',
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {operation: 'delete', tier: target.tier, authMode: lease ? 'lease' : 'direct', targetPath: target.path, snapshotId: snapshot.snapshotId ?? null},
        });
        return {
          ok: true,
          action: 'delete',
          path: target.path,
          kind: 'file',
          tier: target.tier,
          ...(snapshot.snapshotId ? {snapshotId: snapshot.snapshotId} : {}),
          ...(snapshot.snapshotSkipped ? {snapshotSkipped: snapshot.snapshotSkipped} : {}),
          ...(lease ? {lease} : {}),
        };
      }

      case 'restore': {
        const snap = filesStore.getSnapshot(args.snapshotId, actor.id);
        const destRaw = args.targetPath ?? snap.originalPath;
        const target = resolveSafePath(destRaw, cfg, redlineList, {forWrite: true, allowRootItself: false});
        assertParentDirReady(target.path, {recursive: true, cfg, redlineList});
        const overwrite = args.overwrite !== false;
        if (target.exists && !overwrite) fail('files_target_exists');
        if (target.exists && !target.lstat?.isFile()) fail('files_not_regular_file');

        const lease = authorizeMutation({
          leaseAction: 'files.restore',
          tierInfos: [target],
          paths: [target.path],
          byteCount: snap.sizeBytes,
          leaseId,
          actor,
          check,
          isInteractiveOwner,
          leaseStore,
          targetSummary: target.path,
        });

        let previousSnapshotId = null;
        if (target.exists) {
          const prev = filesStore.captureSnapshot(target.path, {
            owner: actor.id,
            opKind: 'restore.backup_current',
            tier: target.tier,
            batchId: leaseId,
          });
          previousSnapshotId = prev.snapshotId;
        }
        const bytesWritten = writeFileAtomic(target.path, snap.buffer, snap.mode || 0o644);
        filesStore.markSnapshotRestored(snap.snapshotId, actor.id);
        filesStore.recordAuditOp({
          owner: actor.id,
          authMode: lease ? 'lease' : 'direct',
          leaseId,
          operation: 'restore',
          tier: target.tier,
          targetPath: target.path,
          snapshotId: snap.snapshotId,
          outcome: 'succeeded',
          detail: {previousSnapshotId},
        });
        emitTrace(trace, {
          source: 'files',
          kind: 'files.op',
          correlation: {...correlation, subjectId: actor.id, ...(leaseId ? {leaseId} : {})},
          data: {operation: 'restore', tier: target.tier, targetPath: target.path, snapshotId: snap.snapshotId, previousSnapshotId},
        });
        return {
          ok: true,
          action: 'restore',
          snapshotId: snap.snapshotId,
          path: target.path,
          tier: target.tier,
          bytesWritten,
          ...(previousSnapshotId ? {previousSnapshotId} : {}),
          ...(lease ? {lease} : {}),
        };
      }

      default:
        fail('unknown_files_action');
    }
  }

  return async function execute(args, _config, request) {
    assertFields(args, typeof args?.action === 'string' && Object.hasOwn(FILE_ACTIONS, args.action) ? FILE_ACTIONS[args.action] : []);
    const {actor, scope, check, correlation = {}, isInteractiveOwner} = request;
    const {cfg, redlineList} = resolveConfig();

    switch (args.action) {
      case 'roots':
        return {
          ok: true,
          defaultWorkspace: cfg.defaultWorkspace ?? null,
          t0Roots: cfg.t0Roots.map(r => ({...r, tier: 'T0', exists: fs.existsSync(r.path)})),
          t1Roots: cfg.t1Roots.map(r => ({...r, tier: 'T1', exists: fs.existsSync(r.path)})),
          t2Roots: cfg.t2Roots.map(r => ({...r, tier: 'T2', exists: fs.existsSync(r.path)})),
          limits: {
            maxReadChars: cfg.maxReadChars,
            maxWriteBytes: cfg.maxWriteBytes,
            maxBatchItems: cfg.maxBatchItems,
            maxSnapshotFileBytes: cfg.maxSnapshotFileBytes,
          },
        };

      case 'list': {
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: false});
        if (!target.exists || !target.lstat?.isDirectory()) fail('files_not_directory');
        const maxEntries = Math.max(1, Math.min(500, Number.isSafeInteger(args.maxEntries) ? args.maxEntries : 200));
        const rawEntries = fs.readdirSync(target.canonicalPath, {withFileTypes: true})
          .sort((a, b) => a.name.localeCompare(b.name));
        const entries = [];
        let skippedRedlines = 0;
        let truncated = false;

        for (const entry of rawEntries) {
          const childPath = path.join(target.path, entry.name);
          const cls = classifyNormalizedPath(childPath, cfg, redlineList);
          if (cls.tier === 'T3') { skippedRedlines++; continue; }
          if (entry.isSymbolicLink()) {
            try {
              const real = fs.realpathSync(childPath);
              const realCls = classifyNormalizedPath(real, cfg, redlineList);
              if (realCls.tier === 'T3') { skippedRedlines++; continue; }
            } catch { /* Broken symlink still shows kind=symlink without exposing redline. */ }
          }
          if (entries.length >= maxEntries) { truncated = true; break; }
          let size = 0;
          let mtimeMs = null;
          try {
            const st = fs.lstatSync(path.join(target.canonicalPath, entry.name));
            size = st.isFile() ? st.size : 0;
            mtimeMs = Math.trunc(st.mtimeMs);
          } catch {}
          entries.push({
            path: childPath,
            name: entry.name,
            kind: entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'dir' : 'file',
            size,
            mtimeMs,
            tier: cls.tier,
            readOnly: cls.readOnly,
          });
        }
        return {ok: true, path: target.path, tier: target.tier, entries, truncated, skippedRedlines};
      }

      case 'stat': {
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: false});
        if (!target.exists) {
          return {ok: true, path: target.path, exists: false, tier: target.tier, readOnly: target.readOnly, allowLease: target.allowLease};
        }
        const st = fs.lstatSync(target.canonicalPath);
        const kind = target.lstat?.isSymbolicLink() ? 'symlink' : st.isDirectory() ? 'dir' : st.isFile() ? 'file' : 'other';
        return {
          ok: true,
          path: target.path,
          exists: true,
          kind,
          size: st.isFile() ? st.size : 0,
          mtimeMs: Math.trunc(st.mtimeMs),
          mode: st.mode & 0o777,
          tier: target.tier,
          readOnly: target.readOnly,
          allowLease: target.allowLease,
          ...(st.isFile() && st.size <= 2 * 1024 * 1024 ? {sha256: sha256(fs.readFileSync(target.canonicalPath))} : {}),
        };
      }

      case 'read': {
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: false});
        if (!target.exists) fail('files_not_found');
        const st = fs.lstatSync(target.canonicalPath);
        if (!st.isFile()) fail('files_not_regular_file');
        if (st.size > 16 * 1024 * 1024) fail('files_read_file_too_large');
        const buf = fs.readFileSync(target.canonicalPath);
        if (buf.includes(0)) fail('files_binary_not_supported');
        const text = buf.toString('utf8');
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid_files_arguments');
        const limit = args.limit ?? cfg.maxReadChars;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > cfg.maxReadChars) fail('invalid_files_arguments');
        const slice = text.slice(offset, offset + limit);
        const nextOffset = offset + slice.length < text.length ? offset + slice.length : null;
        return {
          ok: true,
          path: target.path,
          tier: target.tier,
          sizeBytes: buf.length,
          sha256: sha256(buf),
          totalChars: text.length,
          offset,
          nextOffset,
          hasMore: nextOffset !== null,
          content: slice,
        };
      }

      case 'read_structured': {
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: false});
        if (!target.exists) fail('files_not_found');
        const st = fs.lstatSync(target.canonicalPath);
        if (!st.isFile()) fail('files_not_regular_file');
        if (st.size > 16 * 1024 * 1024) fail('files_read_file_too_large');
        const offset = args.offset ?? 0;
        if (!Number.isSafeInteger(offset) || offset < 0) fail('invalid_files_arguments');
        const limit = args.limit ?? 50;
        if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('invalid_files_arguments');
        const format = args.format ?? 'auto';
        const sheet = typeof args.sheet === 'string' && args.sheet.trim() ? args.sheet.trim() : undefined;
        const query = typeof args.query === 'string' && args.query.trim() ? args.query.trim() : undefined;
        const buf = fs.readFileSync(target.canonicalPath);
        const parsed = readStructuredFile(buf, {
          filename: path.basename(target.canonicalPath),
          format,
          sheet,
          offset,
          limit,
          query,
        });
        emitTrace(trace, {
          source: 'trace-events',
          kind: 'files.read_structured',
          correlation,
          data: {
            tier: target.tier,
            format: parsed.format,
            sizeBytes: buf.length,
          },
        });
        return {
          ok: true,
          path: target.path,
          tier: target.tier,
          sizeBytes: buf.length,
          sha256: sha256(buf),
          ...parsed,
        };
      }

      case 'search': {
        const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: false});
        if (!target.exists || !target.lstat?.isDirectory()) fail('files_not_directory');
        const pattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : null;
        const query = typeof args.query === 'string' && args.query ? args.query : null;
        if (!pattern && !query) fail('invalid_files_arguments');
        const nameMatcher = compileSearchMatcher(pattern);
        const maxResults = Math.max(1, Math.min(100, Number.isSafeInteger(args.maxResults) ? args.maxResults : 30));
        const HEAVY_IGNORED_DIRS = new Set(['.git', 'node_modules', '__pycache__', '.venv']);
        const targetBase = path.basename(target.canonicalPath);

        const matches = [];
        let visited = 0;
        let skippedRedlines = 0;
        let truncated = false;
        const queue = [target.canonicalPath];
        while (queue.length > 0 && matches.length < maxResults && visited < 2000) {
          const dir = queue.shift();
          let children;
          try {
            children = fs.readdirSync(dir, {withFileTypes: true}).sort((a, b) => a.name.localeCompare(b.name));
          } catch {
            continue;
          }
          for (const child of children) {
            visited++;
            if (visited > 2000) { truncated = true; break; }
            const childPath = path.join(dir, child.name);
            const cls = classifyNormalizedPath(childPath, cfg, redlineList);
            if (cls.tier === 'T3') { skippedRedlines++; continue; }
            if (child.isSymbolicLink()) continue;

            if (child.isDirectory()) {
              const skipProtectedBranch = cls.readOnly && !target.readOnly;
              const skipHeavyBranch = HEAVY_IGNORED_DIRS.has(child.name) && targetBase !== child.name;
              if (!skipProtectedBranch && !skipHeavyBranch) {
                queue.push(childPath);
              }
              if (nameMatcher && !query && nameMatcher.test(child.name)) {
                matches.push({path: childPath, kind: 'dir', tier: cls.tier});
                if (matches.length >= maxResults) { truncated = true; break; }
              }
              continue;
            }
            if (!child.isFile()) continue;
            if (nameMatcher && !nameMatcher.test(child.name)) continue;

            if (!query) {
              matches.push({path: childPath, kind: 'file', tier: cls.tier});
            } else {
              let buf;
              try {
                const st = fs.lstatSync(childPath);
                if (st.size > 512 * 1024) continue;
                buf = fs.readFileSync(childPath);
              } catch {
                continue;
              }
              if (buf.includes(0)) continue;
              const lines = buf.toString('utf8').split(/\r?\n/u);
              const idx = lines.findIndex(line => line.includes(query));
              if (idx >= 0) {
                matches.push({
                  path: childPath,
                  kind: 'file',
                  tier: cls.tier,
                  line: idx + 1,
                  snippet: lines[idx].slice(0, 160),
                });
              }
            }
            if (matches.length >= maxResults) { truncated = true; break; }
          }
        }
        return {ok: true, path: target.path, matches, truncated, skippedRedlines};
      }

      case 'snapshots': {
        let prefix = args.pathPrefix;
        if (prefix !== undefined) {
          const resolved = resolveSafePath(prefix, cfg, redlineList, {forWrite: false});
          prefix = resolved.path;
        }
        return {
          ok: true,
          snapshots: filesStore.listSnapshots(actor.id, {limit: args.limit, pathPrefix: prefix}),
        };
      }

      case 'status': {
        if (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId)) {
          fail('invalid_proposal_id');
        }
        const row = filesStore.getProposal(args.proposalId, actor.id);
        let status = row.state;
        if (status === 'pending') {
          try { verifyPlanNotDrifted(row.plan, cfg, redlineList); }
          catch { status = 'stale'; }
        }
        if (status === 'executing') status = 'unknown';
        return {
          ok: true,
          proposalId: row.id,
          domain: FILES_DOMAIN,
          operation: row.operation,
          status,
          expiresAtUtc: row.expires_at_utc,
          ...(row.resultSummary ? {resultSummary: row.resultSummary} : {}),
          ...(row.error ? {code: row.error} : {}),
          feedback: businessFeedback(`files.${row.operation}`, status, {
            proposalId: row.id,
            ...(row.resultSummary ?? {}),
            ...(row.error ? {code: row.error} : {}),
          }),
        };
      }

      case 'mkdir':
      case 'write':
      case 'edit':
      case 'copy':
      case 'move':
      case 'delete':
      case 'restore':
        return runSingleAction(args, request, null);

      case 'propose': {
        if (typeof args.operation !== 'string') fail('invalid_files_arguments');
        const plan = buildOperationPlan(args.operation, args, cfg, redlineList);
        check();
        const proposalId = randomUUID();
        const proposal = filesStore.propose(plan, actor.id, scope, proposalId, cfg.proposalTtlSeconds);
        const {previewText, presentationFacts} = buildFilesPreview(plan);
        emitTrace(trace, {
          source: 'files',
          kind: 'files.proposed',
          correlation: {...correlation, subjectId: actor.id, proposalId: proposal.proposalId, payloadHash: proposal.payloadHash},
          data: {
            operation: plan.operation,
            itemCount: plan.itemCount,
            totalBytes: plan.totalBytes,
            summaryTarget: plan.summaryTarget,
          },
        });
        return {
          ok: true,
          status: 'pending',
          ...proposal,
          operation: plan.operation,
          itemCount: plan.itemCount,
          totalBytes: plan.totalBytes,
          previewText,
          presentationFacts,
        };
      }

      case 'commit': {
        if (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId)) {
          fail('invalid_proposal_id');
        }
        const id = args.proposalId;
        if (inflight.has(id)) fail('files_proposal_already_submitted');
        const row = filesStore.getProposal(id, actor.id);
        if (row.state === 'expired') fail('files_proposal_expired');
        if (row.state !== 'pending') fail('files_proposal_already_submitted');
        check();

        inflight.add(id);
        try {
          const claimed = filesStore.claimProposal(id, actor.id, scope, currentPlan => {
            const latest = resolveConfig();
            verifyPlanNotDrifted(currentPlan, latest.cfg, latest.redlineList);
            check();
          });

          let execResult;
          let outcomeState = 'succeeded';
          let outcomeCode = null;
          try {
            execResult = executeFrozenPlan(claimed.plan, {
              filesStore,
              actor,
              authMode: 'confirmed',
              proposalId: id,
            });
          } catch (error) {
            outcomeState = 'failed';
            outcomeCode = error instanceof FilesError ? error.code : 'files_commit_failed';
          }

          const summary = execResult
            ? {
                operation: claimed.plan.operation,
                itemCount: claimed.plan.itemCount,
                snapshotsCreated: execResult.snapshots.filter(s => s.snapshotId).length,
                snapshotIds: execResult.snapshots.map(s => s.snapshotId).filter(Boolean),
              }
            : null;
          filesStore.finishProposal(id, actor.id, {state: outcomeState, summary, code: outcomeCode});

          emitTrace(trace, {
            source: 'files',
            kind: 'files.committed',
            correlation: {...correlation, subjectId: actor.id, proposalId: id, payloadHash: claimed.hash},
            data: {
              operation: claimed.plan.operation,
              status: outcomeState,
              itemCount: claimed.plan.itemCount,
              snapshotsCreated: summary?.snapshotsCreated ?? 0,
              ...(outcomeCode ? {code: outcomeCode} : {}),
            },
          });

          if (outcomeState !== 'succeeded') {
            return {
              ok: false,
              status: outcomeState,
              code: outcomeCode,
              proposalId: id,
              operation: claimed.plan.operation,
              feedback: businessFeedback(`files.${claimed.plan.operation}`, outcomeState, {proposalId: id, code: outcomeCode}),
            };
          }

          return {
            ok: true,
            status: 'succeeded',
            proposalId: id,
            operation: claimed.plan.operation,
            itemCount: claimed.plan.itemCount,
            snapshotsCreated: summary.snapshotsCreated,
            snapshotIds: summary.snapshotIds,
            results: execResult.results,
            feedback: businessFeedback(`files.${claimed.plan.operation}`, 'succeeded', {
              proposalId: id,
              itemCount: claimed.plan.itemCount,
              snapshotsCreated: summary.snapshotsCreated,
            }),
          };
        } finally {
          inflight.delete(id);
        }
      }

      case 'apply_leased': {
        if (typeof args.leaseId !== 'string' || !validLeaseIdPattern.test(args.leaseId)) {
          fail('invalid_lease_id');
        }
        if (typeof args.operation !== 'string') fail('invalid_files_arguments');
        if (SINGLE_OPERATIONS.has(args.operation)) {
          const singleArgs = {...args, action: args.operation};
          delete singleArgs.operation;
          return runSingleAction(singleArgs, request, args.leaseId);
        }

        const plan = buildOperationPlan(args.operation, args, cfg, redlineList, {requireLeaseEligible: true});
        check();
        const lease = leaseStore.consume(args.leaseId, actor.id, {
          action: plan.leaseAction,
          paths: plan.affectedPaths,
          opCount: Math.max(1, plan.itemCount),
          byteCount: plan.totalBytes,
          tool: FILES_TOOL,
          targetSummary: plan.summaryTarget,
          isInteractiveOwner,
        });

        const execResult = executeFrozenPlan(plan, {
          filesStore,
          actor,
          authMode: 'lease',
          leaseId: args.leaseId,
        });
        const snapshotIds = execResult.snapshots.map(s => s.snapshotId).filter(Boolean);
        emitTrace(trace, {
          source: 'files',
          kind: 'files.leased_applied',
          correlation: {...correlation, subjectId: actor.id, leaseId: args.leaseId},
          data: {
            operation: plan.operation,
            itemCount: plan.itemCount,
            totalBytes: plan.totalBytes,
            snapshotsCreated: snapshotIds.length,
            remainingOps: lease.remainingOps,
            remainingBytes: lease.remainingBytes,
          },
        });
        return {
          ok: true,
          status: 'succeeded',
          leaseId: args.leaseId,
          operation: plan.operation,
          itemCount: plan.itemCount,
          snapshotsCreated: snapshotIds.length,
          snapshotIds,
          results: execResult.results,
          lease,
          feedback: businessFeedback(`files.${plan.operation}`, 'succeeded', {
            leaseId: args.leaseId,
            itemCount: plan.itemCount,
            snapshotsCreated: snapshotIds.length,
          }),
        };
      }

      default:
        fail('unknown_files_action');
    }
  };
}

export function createLeaseService(rawFilesConfig, leaseStore, {stateRoot, trace, verifyRoots = true} = {}) {
  const inflight = new Set();
  const resolveFilesPolicy = () => {
    const raw = typeof rawFilesConfig === 'function' ? rawFilesConfig() : rawFilesConfig;
    const cfg = validateFilesConfig(raw, {stateRoot, verifyRoots});
    return {cfg, redlineList: buildRedlineSet(cfg, stateRoot)};
  };

  const validateLeaseRoot = (rawRoot) => {
    const {cfg, redlineList} = resolveFilesPolicy();
    const resolved = resolveSafePath(rawRoot, cfg, redlineList, {forWrite: true});
    if (!resolved.exists || !resolved.lstat?.isDirectory()) failLease('lease_root_not_allowed');
    if (resolved.readOnly) failLease('files_t2_readonly_denied');
    if (!canApplyLeaseToTierInfo(resolved)) failLease('lease_root_not_eligible');
    return resolved.path;
  };

  return async function execute(args, _config, request) {
    assertLeaseFields(
      args,
      typeof args?.action === 'string' && Object.hasOwn(LEASE_ACTIONS, args.action) ? LEASE_ACTIONS[args.action] : [],
    );
    const {actor, scope, check, correlation = {}} = request;

    switch (args.action) {
      case 'list':
        return {
          ok: true,
          leases: leaseStore.listLeases(actor.id, {includeInactive: args.includeInactive === true, limit: args.limit}),
          recentProposals: leaseStore.listRecentProposals(actor.id, 10),
        };

      case 'status': {
        if (args.leaseId) {
          const lease = leaseStore.getLease(args.leaseId, actor.id);
          return {
            ok: true,
            lease,
            feedback: businessFeedback('lease.status', lease.state, {leaseId: lease.leaseId}),
          };
        }
        if (args.proposalId) {
          const row = leaseStore.getProposal(args.proposalId, actor.id);
          return {
            ok: true,
            proposalId: row.id,
            domain: LEASE_DOMAIN,
            status: row.state,
            expiresAtUtc: row.expires_at_utc,
            ...(row.lease_id ? {leaseId: row.lease_id} : {}),
          };
        }
        failLease('invalid_lease_arguments');
      }

      case 'propose': {
        const plan = validateLeasePlan({
          label: args.label,
          actions: args.actions,
          roots: args.roots,
          maxOps: args.maxOps,
          maxBytes: args.maxBytes,
          ttlSeconds: args.ttlSeconds,
        }, {validateRoot: validateLeaseRoot});
        check();
        const proposalId = randomUUID();
        const proposal = leaseStore.propose(plan, actor.id, scope, proposalId);
        const {previewText, presentationFacts} = buildLeasePreview(plan);
        emitTrace(trace, {
          source: 'scoped-lease',
          kind: 'lease.proposed',
          correlation: {...correlation, subjectId: actor.id, proposalId: proposal.proposalId, payloadHash: proposal.payloadHash},
          data: {label: plan.label, actions: plan.actions, roots: plan.roots, maxOps: plan.maxOps, maxBytes: plan.maxBytes, ttlSeconds: plan.ttlSeconds},
        });
        return {
          ok: true,
          status: 'pending',
          ...proposal,
          label: plan.label,
          actions: plan.actions,
          roots: plan.roots,
          maxOps: plan.maxOps,
          maxBytes: plan.maxBytes,
          ttlSeconds: plan.ttlSeconds,
          previewText,
          presentationFacts,
        };
      }

      case 'commit': {
        if (typeof args.proposalId !== 'string' || !validLeaseProposalPattern.test(args.proposalId)) {
          failLease('invalid_proposal_id');
        }
        const id = args.proposalId;
        if (inflight.has(id)) failLease('lease_proposal_already_submitted');
        check();
        inflight.add(id);
        try {
          const committed = leaseStore.commitProposal(id, actor.id, scope, scope.primary, currentPlan => {
            for (const root of currentPlan.roots) validateLeaseRoot(root);
            check();
          });
          emitTrace(trace, {
            source: 'scoped-lease',
            kind: 'lease.activated',
            correlation: {...correlation, subjectId: actor.id, proposalId: id, payloadHash: committed.payloadHash, leaseId: committed.lease.leaseId},
            data: {
              label: committed.lease.label,
              actions: committed.lease.actions,
              roots: committed.lease.roots,
              maxOps: committed.lease.maxOps,
              maxBytes: committed.lease.maxBytes,
              expiresAtUtc: committed.lease.expiresAtUtc,
            },
          });
          return {
            ok: true,
            status: 'active',
            proposalId: id,
            leaseId: committed.lease.leaseId,
            lease: committed.lease,
            feedback: businessFeedback('lease.activate', 'succeeded', {
              proposalId: id,
              leaseId: committed.lease.leaseId,
              expiresAtUtc: committed.lease.expiresAtUtc,
            }),
          };
        } finally {
          inflight.delete(id);
        }
      }

      case 'revoke': {
        if (typeof args.leaseId !== 'string' || !validLeaseIdPattern.test(args.leaseId)) {
          failLease('invalid_lease_id');
        }
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 120) : 'owner_revoked';
        const res = leaseStore.revoke(args.leaseId, actor.id, reason);
        emitTrace(trace, {
          source: 'scoped-lease',
          kind: 'lease.revoked',
          correlation: {...correlation, subjectId: actor.id, leaseId: res.leaseId},
          data: {state: res.state, alreadyInactive: res.alreadyInactive, reason},
        });
        return {
          ok: true,
          ...res,
          feedback: businessFeedback('lease.revoke', 'succeeded', {leaseId: res.leaseId, state: res.state}),
        };
      }

      case 'revoke_all': {
        const reason = typeof args.reason === 'string' && args.reason.trim() ? args.reason.trim().slice(0, 120) : 'owner_revoked_all';
        const res = leaseStore.revokeAll(actor.id, reason);
        emitTrace(trace, {
          source: 'scoped-lease',
          kind: 'lease.revoked_all',
          correlation: {...correlation, subjectId: actor.id},
          data: {revokedCount: res.revokedCount, revokedLeaseIds: res.revokedLeaseIds, reason},
        });
        return {
          ok: true,
          ...res,
          feedback: businessFeedback('lease.revoke_all', 'succeeded', {revokedCount: res.revokedCount}),
        };
      }

      default:
        failLease('unknown_lease_action');
    }
  };
}
