import fs from 'node:fs';
import path from 'node:path';
import {insideRoot} from '../../packages/scoped-lease/index.js';
import {fail, filesPolicyFingerprint, sha256} from './policy.js';
import {
  assertNotTierRoot,
  canApplyLeaseToTierInfo,
  classifyNormalizedPath,
  isInsideRedlineTree,
  resolveSafePath,
} from './tiers.js';

const SMALL_HASH_LIMIT = 2 * 1024 * 1024;

function fileFingerprint(filePath, lstat) {
  if (!lstat) return {exists: false};
  return {
    exists: true,
    kind: lstat.isDirectory() ? 'dir' : 'file',
    sizeBytes: lstat.isFile() ? lstat.size : 0,
    mtimeMs: Math.trunc(lstat.mtimeMs),
    ...(lstat.isFile() && lstat.size <= SMALL_HASH_LIMIT ? {sha256: sha256(fs.readFileSync(filePath))} : {}),
  };
}

function sameFingerprint(actual, expected) {
  if (!expected || actual.exists !== expected.exists) return false;
  if (!expected.exists) return true;
  if (actual.kind !== expected.kind) return false;
  if (actual.sizeBytes !== expected.sizeBytes || actual.mtimeMs !== expected.mtimeMs) return false;
  if (expected.sha256 && actual.sha256 !== expected.sha256) return false;
  return true;
}

function compileNameGlob(pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/gu, '\\$&')
    .replaceAll('*', '.*')
    .replaceAll('?', '.');
  return new RegExp(`^${escaped}$`, 'u');
}

function scanCleanupEntries(dirPath, {includeRoot, namePattern, maxItems}, cfg, redlineList) {
  if (isInsideRedlineTree(dirPath, redlineList)) {
    const hasChildRedline = redlineList.some(red => insideRoot(red, dirPath) && red !== dirPath);
    if (hasChildRedline) fail('files_redline_denied');
  }
  const matcher = namePattern ? compileNameGlob(namePattern) : null;
  const files = [];
  const dirs = [];

  function walk(currentDir, depth) {
    if (depth > 32) fail('files_batch_too_large');
    const children = fs.readdirSync(currentDir, {withFileTypes: true})
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const child of children) {
      const childPath = path.join(currentDir, child.name);
      const lstat = fs.lstatSync(childPath);
      if (lstat.isSymbolicLink()) fail('files_symlink_not_allowed');
      const info = classifyNormalizedPath(childPath, cfg, redlineList);
      if (info.tier === 'T3') fail('files_redline_denied');
      if (info.tier === 'T2') fail('files_t2_subitem_blocked_in_cleanup');
      if (info.tier === 'outside') fail('files_path_outside_policy');

      if (lstat.isDirectory()) {
        walk(childPath, depth + 1);
        if (!matcher) dirs.push({path: childPath, tier: info.tier});
      } else if (lstat.isFile()) {
        if (matcher && !matcher.test(child.name)) continue;
        files.push({
          path: childPath,
          tier: info.tier,
          sizeBytes: lstat.size,
          fingerprint: fileFingerprint(childPath, lstat),
        });
        if (files.length > maxItems) fail('files_batch_too_large');
      } else {
        fail('files_not_regular_file');
      }
    }
  }

  walk(dirPath, 0);
  if (includeRoot && !matcher) {
    assertNotTierRoot(dirPath, cfg);
    const rootInfo = classifyNormalizedPath(dirPath, cfg, redlineList);
    dirs.push({path: dirPath, tier: rootInfo.tier});
  }
  dirs.sort((a, b) => b.path.length - a.path.length);
  if (files.length === 0 && dirs.length === 0) fail('files_cleanup_empty');
  return {files, dirs};
}

function assertPlanTierAllowed(info, requireT2, requireLeaseEligible) {
  if (info.readOnly) fail('files_t2_readonly_denied');
  if (requireT2 && info.tier !== 'T2') fail('invalid_files_arguments');
  if (!requireT2 && info.tier === 'T2') fail('files_t2_requires_dedicated_operation');
  if (requireLeaseEligible && !canApplyLeaseToTierInfo(info)) fail('files_lease_not_eligible');
}

function normalizePairItems(rawItems, operation, cfg, redlineList, {requireT2 = false, requireLeaseEligible = false} = {}) {
  if (!Array.isArray(rawItems) || rawItems.length === 0 || rawItems.length > cfg.maxBatchItems) {
    fail('invalid_files_arguments');
  }
  const seenTargets = new Set();
  const seenSources = new Set();
  const entries = [];
  let totalBytes = 0;
  let hasOversizeFiles = false;

  for (const item of rawItems) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) fail('invalid_files_arguments');
    const sourceForWrite = operation !== 'batch_copy';
    const src = resolveSafePath(item.sourcePath, cfg, redlineList, {forWrite: sourceForWrite, allowRootItself: false});
    const dst = resolveSafePath(item.targetPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
    if (!src.exists || !src.lstat?.isFile()) fail('files_not_regular_file');
    if (sourceForWrite) assertPlanTierAllowed(src, requireT2, requireLeaseEligible);
    assertPlanTierAllowed(dst, requireT2, requireLeaseEligible);
    if (src.path === dst.path) fail('invalid_files_arguments');
    if (sourceForWrite && seenSources.has(src.path)) fail('invalid_files_arguments');
    if (seenTargets.has(dst.path)) fail('invalid_files_arguments');
    seenSources.add(src.path);
    seenTargets.add(dst.path);

    const overwrite = item.overwrite === true;
    if (dst.exists) {
      if (!overwrite) fail('files_target_exists');
      if (!dst.lstat?.isFile()) fail('files_not_regular_file');
      if (dst.lstat.size > cfg.maxSnapshotFileBytes) hasOversizeFiles = true;
    }

    totalBytes += src.lstat.size;
    entries.push({
      sourcePath: src.path,
      sourceTier: src.tier,
      sourceFingerprint: fileFingerprint(src.path, src.lstat),
      targetPath: dst.path,
      targetTier: dst.tier,
      overwrite,
      targetFingerprint: fileFingerprint(dst.path, dst.lstat),
      sizeBytes: src.lstat.size,
    });
  }
  return {entries, totalBytes, hasOversizeFiles};
}

export function buildOperationPlan(operation, args, cfg, redlineList, {requireLeaseEligible = false} = {}) {
  const allowOversizeSkip = args.allowOversizeSkip === true;
  const policyFingerprint = filesPolicyFingerprint(cfg);

  switch (operation) {
    case 'batch_delete': {
      if (!Array.isArray(args.paths) || args.paths.length === 0 || args.paths.length > cfg.maxBatchItems) {
        fail('invalid_files_arguments');
      }
      const seen = new Set();
      const entries = [];
      let totalBytes = 0;
      let hasOversizeFiles = false;
      for (const rawPath of args.paths) {
        const target = resolveSafePath(rawPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
        assertPlanTierAllowed(target, false, requireLeaseEligible);
        if (!target.exists || !target.lstat?.isFile()) fail('files_not_regular_file');
        if (seen.has(target.path)) fail('invalid_files_arguments');
        seen.add(target.path);
        if (target.lstat.size > cfg.maxSnapshotFileBytes) hasOversizeFiles = true;
        totalBytes += target.lstat.size;
        entries.push({
          path: target.path,
          tier: target.tier,
          sizeBytes: target.lstat.size,
          fingerprint: fileFingerprint(target.path, target.lstat),
        });
      }
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: 'files.batch_delete',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        summaryTarget: entries.length === 1 ? path.dirname(entries[0].path) : `${path.dirname(entries[0].path)} 等目录`,
        itemCount: entries.length,
        totalBytes,
        sampleNames: entries.slice(0, 3).map(e => path.basename(e.path)),
        affectedPaths: entries.map(e => e.path),
        entries,
      };
    }

    case 'batch_move':
    case 'batch_copy': {
      const {entries, totalBytes, hasOversizeFiles} = normalizePairItems(args.items, operation, cfg, redlineList, {
        requireT2: false,
        requireLeaseEligible,
      });
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: operation === 'batch_move' ? 'files.batch_move' : 'files.batch_copy',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        summaryTarget: path.dirname(entries[0].targetPath),
        itemCount: entries.length,
        totalBytes,
        sampleNames: entries.slice(0, 3).map(e => path.basename(e.sourcePath)),
        affectedPaths: entries.flatMap(e => operation === 'batch_move' ? [e.sourcePath, e.targetPath] : [e.targetPath]),
        entries,
      };
    }

    case 'cleanup_dir': {
      const includeRoot = args.includeRoot === true;
      const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: !includeRoot});
      if (cfg.homeDir && target.canonicalPath === cfg.homeDir) fail('files_tier_root_protected');
      assertPlanTierAllowed(target, false, requireLeaseEligible);
      if (!target.exists || !target.lstat?.isDirectory()) fail('files_not_directory');
      const namePattern = typeof args.pattern === 'string' && args.pattern.trim() ? args.pattern.trim() : null;
      const {files, dirs} = scanCleanupEntries(
        target.path,
        {includeRoot, namePattern, maxItems: cfg.maxBatchItems},
        cfg,
        redlineList,
      );
      const totalBytes = files.reduce((sum, f) => sum + f.sizeBytes, 0);
      const hasOversizeFiles = files.some(f => f.sizeBytes > cfg.maxSnapshotFileBytes);
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: 'files.cleanup_dir',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        targetDir: target.path,
        includeRoot,
        namePattern,
        summaryTarget: target.path,
        itemCount: files.length + dirs.length,
        totalBytes,
        sampleNames: files.slice(0, 3).map(f => path.relative(target.path, f.path) || path.basename(f.path)),
        affectedPaths: [target.path, ...files.map(f => f.path), ...dirs.map(d => d.path)],
        files,
        dirs,
      };
    }

    case 't2_write': {
      const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
      assertPlanTierAllowed(target, true, requireLeaseEligible);
      if (typeof args.content !== 'string') fail('invalid_files_arguments');
      const mode = args.mode ?? 'create';
      if (!['create', 'overwrite', 'append'].includes(mode)) fail('invalid_files_arguments');
      if (mode === 'create' && target.exists) fail('files_target_exists');
      if (target.exists && !target.lstat?.isFile()) fail('files_not_regular_file');
      const existingBytes = target.exists ? target.lstat.size : 0;
      const writeBytes = Buffer.byteLength(args.content, 'utf8');
      const finalBytes = mode === 'append' ? existingBytes + writeBytes : writeBytes;
      if (finalBytes > cfg.maxWriteBytes) fail('files_write_too_large');
      const hasOversizeFiles = target.exists && existingBytes > cfg.maxSnapshotFileBytes;
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: 'files.write',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        summaryTarget: target.path,
        itemCount: 1,
        totalBytes: finalBytes,
        sampleNames: [path.basename(target.path)],
        affectedPaths: [target.path],
        entry: {
          path: target.path,
          tier: target.tier,
          mode,
          content: args.content,
          expectedSha256: args.expectedSha256 ?? null,
          fingerprint: fileFingerprint(target.path, target.lstat),
        },
      };
    }

    case 't2_edit': {
      const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
      assertPlanTierAllowed(target, true, requireLeaseEligible);
      if (!target.exists || !target.lstat?.isFile()) fail('files_not_regular_file');
      if (typeof args.oldText !== 'string' || !args.oldText || typeof args.newText !== 'string') fail('invalid_files_arguments');
      if (target.lstat.size > cfg.maxWriteBytes) fail('files_write_too_large');
      const buf = fs.readFileSync(target.path);
      if (buf.includes(0)) fail('files_binary_not_supported');
      const raw = buf.toString('utf8');
      const parts = raw.split(args.oldText);
      if (parts.length === 1) fail('files_edit_target_not_found');
      if (parts.length > 2 && args.replaceAll !== true) fail('files_edit_target_ambiguous');
      const updated = args.replaceAll === true ? parts.join(args.newText) : parts[0] + args.newText + parts.slice(1).join(args.oldText);
      if (Buffer.byteLength(updated, 'utf8') > cfg.maxWriteBytes) fail('files_write_too_large');
      const hasOversizeFiles = target.lstat.size > cfg.maxSnapshotFileBytes;
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: 'files.write',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        summaryTarget: target.path,
        itemCount: 1,
        totalBytes: Buffer.byteLength(updated, 'utf8'),
        sampleNames: [path.basename(target.path)],
        affectedPaths: [target.path],
        entry: {
          path: target.path,
          tier: target.tier,
          oldText: args.oldText,
          newText: args.newText,
          replaceAll: args.replaceAll === true,
          replacements: args.replaceAll === true ? parts.length - 1 : 1,
          fingerprint: fileFingerprint(target.path, target.lstat),
        },
      };
    }

    case 't2_delete': {
      const target = resolveSafePath(args.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
      assertPlanTierAllowed(target, true, requireLeaseEligible);
      if (!target.exists || !target.lstat?.isFile()) fail('files_not_regular_file');
      const hasOversizeFiles = target.lstat.size > cfg.maxSnapshotFileBytes;
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: 'files.delete',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        summaryTarget: target.path,
        itemCount: 1,
        totalBytes: target.lstat.size,
        sampleNames: [path.basename(target.path)],
        affectedPaths: [target.path],
        entry: {
          path: target.path,
          tier: target.tier,
          expectedSha256: args.expectedSha256 ?? null,
          fingerprint: fileFingerprint(target.path, target.lstat),
        },
      };
    }

    case 't2_move': {
      const src = resolveSafePath(args.sourcePath, cfg, redlineList, {forWrite: true, allowRootItself: false});
      const dst = resolveSafePath(args.targetPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
      if (src.tier !== 'T2' && dst.tier !== 'T2') fail('invalid_files_arguments');
      if (src.readOnly || dst.readOnly) fail('files_t2_readonly_denied');
      if (requireLeaseEligible && (!canApplyLeaseToTierInfo(src) || !canApplyLeaseToTierInfo(dst))) {
        fail('files_lease_not_eligible');
      }
      if (!src.exists || !src.lstat?.isFile()) fail('files_not_regular_file');
      if (src.path === dst.path) fail('invalid_files_arguments');
      const overwrite = args.overwrite === true;
      if (dst.exists && !overwrite) fail('files_target_exists');
      if (dst.exists && !dst.lstat?.isFile()) fail('files_not_regular_file');
      const hasOversizeFiles = dst.exists && dst.lstat.size > cfg.maxSnapshotFileBytes;
      if (hasOversizeFiles && !allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {
        operation,
        leaseAction: 'files.move',
        policyFingerprint,
        allowOversizeSkip,
        hasOversizeFiles,
        summaryTarget: `${src.path} -> ${dst.path}`,
        itemCount: 1,
        totalBytes: src.lstat.size,
        sampleNames: [path.basename(src.path)],
        affectedPaths: [src.path, dst.path],
        entry: {
          sourcePath: src.path,
          sourceTier: src.tier,
          sourceFingerprint: fileFingerprint(src.path, src.lstat),
          targetPath: dst.path,
          targetTier: dst.tier,
          overwrite,
          targetFingerprint: fileFingerprint(dst.path, dst.lstat),
        },
      };
    }

    default:
      fail('invalid_files_arguments');
  }
}

export function verifyPlanNotDrifted(plan, cfg, redlineList) {
  if (filesPolicyFingerprint(cfg) !== plan.policyFingerprint) {
    fail('files_plan_drifted');
  }
  try {
    switch (plan.operation) {
      case 'batch_delete':
        for (const item of plan.entries) {
          const target = resolveSafePath(item.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
          if (target.readOnly || !sameFingerprint(fileFingerprint(target.path, target.lstat), item.fingerprint)) {
            fail('files_plan_drifted');
          }
        }
        return;

      case 'batch_move':
      case 'batch_copy':
        for (const item of plan.entries) {
          const src = resolveSafePath(item.sourcePath, cfg, redlineList, {forWrite: plan.operation === 'batch_move', allowRootItself: false});
          const dst = resolveSafePath(item.targetPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
          if ((plan.operation === 'batch_move' && src.readOnly) || dst.readOnly) fail('files_plan_drifted');
          if (!sameFingerprint(fileFingerprint(src.path, src.lstat), item.sourceFingerprint)
            || !sameFingerprint(fileFingerprint(dst.path, dst.lstat), item.targetFingerprint)) {
            fail('files_plan_drifted');
          }
        }
        return;

      case 'cleanup_dir': {
        const target = resolveSafePath(plan.targetDir, cfg, redlineList, {forWrite: true, allowRootItself: !plan.includeRoot});
        if (target.readOnly || !target.exists || !target.lstat?.isDirectory()) fail('files_plan_drifted');
        const current = scanCleanupEntries(
          target.path,
          {includeRoot: plan.includeRoot, namePattern: plan.namePattern, maxItems: cfg.maxBatchItems},
          cfg,
          redlineList,
        );
        if (current.files.length !== plan.files.length || current.dirs.length !== plan.dirs.length) {
          fail('files_plan_drifted');
        }
        for (let i = 0; i < plan.files.length; i++) {
          const a = current.files[i];
          const b = plan.files[i];
          if (a.path !== b.path || !sameFingerprint(a.fingerprint, b.fingerprint)) {
            fail('files_plan_drifted');
          }
        }
        return;
      }

      case 't2_write':
      case 't2_edit':
      case 't2_delete': {
        const item = plan.entry;
        const target = resolveSafePath(item.path, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (target.readOnly || target.tier !== 'T2'
          || !sameFingerprint(fileFingerprint(target.path, target.lstat), item.fingerprint)) {
          fail('files_plan_drifted');
        }
        return;
      }

      case 't2_move': {
        const item = plan.entry;
        const src = resolveSafePath(item.sourcePath, cfg, redlineList, {forWrite: true, allowRootItself: false});
        const dst = resolveSafePath(item.targetPath, cfg, redlineList, {forWrite: true, allowRootItself: false});
        if (src.readOnly || dst.readOnly
          || !sameFingerprint(fileFingerprint(src.path, src.lstat), item.sourceFingerprint)
          || !sameFingerprint(fileFingerprint(dst.path, dst.lstat), item.targetFingerprint)) {
          fail('files_plan_drifted');
        }
        return;
      }

      default:
        fail('files_plan_drifted');
    }
  } catch (error) {
    if (error?.code === 'files_plan_drifted') throw error;
    fail('files_plan_drifted');
  }
}
