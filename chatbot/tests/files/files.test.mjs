// Offline unit and lifecycle tests for kurumi-files (docs/37 Stage 2A).
// Uses isolated temp directories and SQLite; verifies tiers, symlinks, snapshots, batch confirmation, leases, and lifecycle.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as core from '../../packages/confirmation-core/dist/index.js';
import {ScopedLeaseStore} from '../../packages/scoped-lease/index.js';
import {ownerFilesInvocation} from '../../plugins/kurumi-files/inbound.js';
import {createFilesPlugin} from '../../plugins/kurumi-files/index.js';
import {buildFilesPreview, sha256, validateFilesConfig} from '../../plugins/kurumi-files/policy.js';
import {createFilesService, createLeaseService} from '../../plugins/kurumi-files/service.js';
import {FilesStore} from '../../plugins/kurumi-files/store.js';
import {buildRedlineSet, classifyNormalizedPath, resolveSafePath} from '../../plugins/kurumi-files/tiers.js';
import {ownerPolicy, memberRow, context} from '../access-control/fixtures.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-files-test-'));
after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));

function setupEnv(prefix, cfgPatch = {}) {
  const root = fs.mkdtempSync(path.join(tmpRoot, prefix));
  const homeDir = path.join(root, 'home');
  const stateRoot = path.join(root, 'openclaw-state');
  const kurumiSpace = path.join(homeDir, 'kurumi-space');
  const downloads = path.join(homeDir, '下载');
  const documents = path.join(homeDir, '文档');
  const repoReadOnly = path.join(homeDir, 'repository');
  const t2Writable = path.join(homeDir, 't2-config');
  const t2Leaseable = path.join(homeDir, 't2-leaseable');
  const sshDir = path.join(homeDir, '.ssh');
  const outside = path.join(root, 'outside');

  for (const d of [
    stateRoot,
    kurumiSpace,
    downloads,
    documents,
    repoReadOnly,
    t2Writable,
    t2Leaseable,
    sshDir,
    outside,
  ]) {
    fs.mkdirSync(d, {recursive: true});
  }
  fs.writeFileSync(path.join(sshDir, 'id_ed25519'), 'PRIVATE_KEY_MATERIAL');
  fs.writeFileSync(path.join(homeDir, '.bashrc'), 'export PATH=$PATH\n');
  fs.writeFileSync(path.join(repoReadOnly, 'README.md'), 'repo-readme');
  fs.writeFileSync(path.join(outside, 'secret.txt'), 'outside-secret');

  const rawConfig = {
    homeDir,
    defaultWorkspace: kurumiSpace,
    t0Roots: [{path: kurumiSpace, label: 'Kurumi 草稿区'}],
    t1Roots: [
      {path: downloads, label: '下载'},
      {path: documents, label: '文档'},
    ],
    t2Roots: [
      {path: repoReadOnly, label: '代码仓只读区', readOnly: true, allowLease: false},
      {path: t2Writable, label: '受控配置区', readOnly: false, allowLease: false},
      {path: t2Leaseable, label: '可租约维护区', readOnly: false, allowLease: true},
    ],
    maxSnapshotFileBytes: 4096,
    maxSnapshotTotalBytes: 65536,
    ...cfgPatch,
  };
  return {
    root,
    homeDir,
    stateRoot,
    kurumiSpace,
    downloads,
    documents,
    repoReadOnly,
    t2Writable,
    t2Leaseable,
    sshDir,
    outside,
    rawConfig,
  };
}

function makeActor(qq = '365999865') {
  const row = ownerPolicy(qq).subjects[0];
  const ctx = context(row);
  const scope = core.scopeFromToolContext(ctx);
  return {
    row,
    ctx,
    actor: {id: qq, owner: true},
    scope,
    inbound(text = '确认') {
      return {
        channel: 'kurumi-qq',
        accountId: 'default',
        senderId: qq,
        conversationId: `user:${qq}`,
        sessionKey: ctx.sessionKey,
        messageId: 'msg-' + Math.random().toString(16).slice(2),
        timestamp: this.nowMs,
        content: text,
        isGroup: false,
      };
    },
    nowMs: 1_800_000_000_000,
  };
}

test('tier classification protects T3 redlines, dotfiles under Stage 2B homeDir, and symlink escapes', () => {
  const env = setupEnv('tiers-', {
    // Include Stage 2B scenario: broad homeDir in t1Roots must never unmask dotfiles or .ssh.
    t1Roots: [{path: path.join(tmpRoot, 'tiers-dummy-uninit'), label: 'tmp'}],
  });
  env.rawConfig.t1Roots = [{path: env.homeDir, label: '主目录一般文件'}];
  fs.rmSync(path.join(tmpRoot, 'tiers-dummy-uninit'), {recursive: true, force: true});

  const cfg = validateFilesConfig(env.rawConfig, {stateRoot: env.stateRoot, verifyRoots: false});
  const redlines = buildRedlineSet(cfg, env.stateRoot);

  assert.equal(classifyNormalizedPath(env.kurumiSpace, cfg, redlines).tier, 'T0');
  assert.equal(classifyNormalizedPath(path.join(env.homeDir, '下载/a.txt'), cfg, redlines).tier, 'T1');
  assert.equal(classifyNormalizedPath(env.repoReadOnly, cfg, redlines).tier, 'T2');
  assert.equal(classifyNormalizedPath(path.join(env.homeDir, '.bashrc'), cfg, redlines).tier, 'T2');
  assert.equal(classifyNormalizedPath(path.join(env.homeDir, '.bashrc'), cfg, redlines).readOnly, true);
  assert.equal(classifyNormalizedPath(path.join(env.sshDir, 'id_ed25519'), cfg, redlines).tier, 'T3');
  assert.equal(classifyNormalizedPath(path.join(env.downloads, '.env.local'), cfg, redlines).tier, 'T3');
  assert.equal(classifyNormalizedPath(path.join(env.downloads, '.env.example'), cfg, redlines).tier, 'T1');
  assert.equal(classifyNormalizedPath(path.join(env.stateRoot, 'openclaw.json'), cfg, redlines).tier, 'T3');
  assert.equal(classifyNormalizedPath('/etc/shadow', cfg, redlines).tier, 'T3');
  assert.equal(classifyNormalizedPath(path.join(env.outside, 'secret.txt'), cfg, redlines).tier, 'outside');

  // Symlink inside T1 pointing into T3 or outside fails on both read and write.
  const linkToSsh = path.join(env.downloads, 'to-ssh');
  const linkToOutside = path.join(env.downloads, 'to-outside.txt');
  fs.symlinkSync(path.join(env.sshDir, 'id_ed25519'), linkToSsh);
  fs.symlinkSync(path.join(env.outside, 'secret.txt'), linkToOutside);

  assert.throws(() => resolveSafePath(linkToSsh, cfg, redlines, {forWrite: false}), {code: 'files_redline_denied'});
  assert.throws(() => resolveSafePath(linkToOutside, cfg, redlines, {forWrite: false}), {code: 'files_path_outside_policy'});
  assert.throws(() => resolveSafePath(linkToOutside, cfg, redlines, {forWrite: true}), {code: 'files_symlink_not_allowed'});
  assert.throws(() => resolveSafePath(env.homeDir, cfg, redlines, {forWrite: true, allowRootItself: false}), {code: 'files_tier_root_protected'});
  assert.throws(() => resolveSafePath(env.kurumiSpace, cfg, redlines, {forWrite: true, allowRootItself: false}), {code: 'files_tier_root_protected'});
});

test('T0/T1 single-file CRUD, snapshots, oversize guard, restore integrity, and T2/T3 gates', async t => {
  const env = setupEnv('crud-');
  let nowMs = 1_800_000_000_000;
  const cfg = validateFilesConfig(env.rawConfig, {stateRoot: env.stateRoot});
  const filesStore = new FilesStore(env.stateRoot, cfg, () => nowMs);
  const leaseStore = new ScopedLeaseStore(env.stateRoot, () => nowMs);
  t.after(() => { filesStore.close(); leaseStore.close(); });

  const service = createFilesService(env.rawConfig, filesStore, leaseStore, {stateRoot: env.stateRoot, trace() {}});
  const helper = makeActor();
  const req = {actor: helper.actor, scope: helper.scope, check() {}, isInteractiveOwner: true};
  const cfgObj = {channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: ownerPolicy(helper.row.qq)}}};

  // Member and wake sessions rejected at inbound boundary.
  const mRow = memberRow();
  const cfgWithMember = structuredClone(cfgObj);
  cfgWithMember.channels['kurumi-qq'].accessControl.subjects.push(mRow);
  assert.throws(() => ownerFilesInvocation(context(mRow), cfgWithMember, 'kurumi_files', {action: 'roots'}), {code: 'capability_not_allowed'});
  assert.throws(() => ownerFilesInvocation({...helper.ctx, sessionKey: `agent:main:kurumi-proactive:${helper.row.qq}`}, cfgObj, 'kurumi_files', {action: 'roots'}), {code: 'untrusted_identity_context'});

  // Write, read pagination, edit, copy, move, delete with snapshots in T0/T1.
  const f1 = path.join(env.kurumiSpace, 'note.txt');
  const created = await service({action: 'write', path: f1, content: '第一行\n第二行\n', mode: 'create'}, cfgObj, req);
  assert.equal(created.ok, true);
  assert.equal(created.tier, 'T0');
  assert.equal(created.snapshotId, undefined);

  // Overwriting existing file without mode='overwrite' fails safely.
  await assert.rejects(() => service({action: 'write', path: f1, content: 'x'}, cfgObj, req), {code: 'files_target_exists'});

  const edited = await service({action: 'edit', path: f1, oldText: '第二行', newText: '已编辑第二行'}, cfgObj, req);
  assert.equal(edited.ok, true);
  assert(edited.snapshotId);
  assert.equal(fs.readFileSync(f1, 'utf8'), '第一行\n已编辑第二行\n');

  const copied = await service({action: 'copy', sourcePath: f1, targetPath: path.join(env.downloads, 'copy.txt')}, cfgObj, req);
  assert.equal(copied.tier, 'T1');

  const movedPath = path.join(env.documents, 'renamed.md');
  await service({action: 'move', sourcePath: copied.targetPath, targetPath: movedPath}, cfgObj, req);
  assert(!fs.existsSync(copied.targetPath));

  // Paginated read & search.
  const page1 = await service({action: 'read', path: movedPath, offset: 0, limit: 3}, cfgObj, req);
  assert.equal(page1.hasMore, true);
  assert.equal(page1.nextOffset, 3);
  const found = await service({action: 'search', path: env.documents, query: '已编辑'}, cfgObj, req);
  assert.equal(found.matches.length, 1);

  // Non-empty directory delete refused; empty file delete succeeds with snapshot, and restore rolls back.
  const subDir = path.join(env.downloads, 'folder');
  await service({action: 'mkdir', path: subDir}, cfgObj, req);
  await service({action: 'write', path: path.join(subDir, 'inside.txt'), content: 'keep'}, cfgObj, req);
  await assert.rejects(() => service({action: 'delete', path: subDir}, cfgObj, req), {code: 'files_directory_not_empty_use_cleanup'});

  const deleted = await service({action: 'delete', path: movedPath}, cfgObj, req);
  assert.equal(deleted.ok, true);
  assert(deleted.snapshotId);
  assert(!fs.existsSync(movedPath));

  const snaps = await service({action: 'snapshots', pathPrefix: env.documents}, cfgObj, req);
  assert.equal(snaps.snapshots[0].snapshotId, deleted.snapshotId);

  // Restore recovers the deleted file identically.
  const restored = await service({action: 'restore', snapshotId: deleted.snapshotId}, cfgObj, req);
  assert.equal(restored.ok, true);
  assert.equal(fs.readFileSync(movedPath, 'utf8'), '第一行\n已编辑第二行\n');

  // Snapshot integrity check detects blob tampering.
  const snapRow = filesStore.db.prepare('SELECT blob_rel_path FROM file_snapshots WHERE snapshot_id=?').get(edited.snapshotId);
  fs.writeFileSync(path.join(filesStore.snapshotsDir, snapRow.blob_rel_path), 'CORRUPTED');
  await assert.rejects(() => service({action: 'restore', snapshotId: edited.snapshotId}, cfgObj, req), {code: 'files_snapshot_corrupted'});

  // Binary file read rejected; oversize single-file overwrite refuses direct execution without confirmation.
  const binFile = path.join(env.downloads, 'raw.bin');
  fs.writeFileSync(binFile, Buffer.from([1, 2, 0, 3]));
  await assert.rejects(() => service({action: 'read', path: binFile}, cfgObj, req), {code: 'files_binary_not_supported'});

  const bigFile = path.join(env.downloads, 'big.txt');
  fs.writeFileSync(bigFile, 'X'.repeat(5000));
  await assert.rejects(() => service({action: 'delete', path: bigFile}, cfgObj, req), {code: 'files_snapshot_too_large_requires_confirmation'});

  // T2 read-only refuses writes & proposals; writable T2 refuses direct write without lease/confirmation.
  const roFile = path.join(env.repoReadOnly, 'README.md');
  assert.equal((await service({action: 'read', path: roFile}, cfgObj, req)).content, 'repo-readme');
  await assert.rejects(() => service({action: 'write', path: path.join(env.repoReadOnly, 'new.txt'), content: 'x'}, cfgObj, req), {code: 'files_t2_readonly_denied'});
  await assert.rejects(() => service({action: 'propose', operation: 't2_write', path: path.join(env.repoReadOnly, 'new.txt'), content: 'x'}, cfgObj, req), {code: 'files_t2_readonly_denied'});
  await assert.rejects(() => service({action: 'write', path: path.join(env.t2Writable, 'app.conf'), content: 'k=v'}, cfgObj, req), {code: 'files_confirmation_required'});
});

test('batch cleanup confirmation, drift detection, no replay, and leased batch/T2 operations', async t => {
  const env = setupEnv('batch-');
  let nowMs = 1_800_000_000_000;
  const cfg = validateFilesConfig(env.rawConfig, {stateRoot: env.stateRoot});
  const filesStore = new FilesStore(env.stateRoot, cfg, () => nowMs);
  const leaseStore = new ScopedLeaseStore(env.stateRoot, () => nowMs);
  t.after(() => { filesStore.close(); leaseStore.close(); });

  const regFiles = core.registerConfirmationBackend({
    id: 'test-files',
    open: () => ({natural: filesStore.natural, listInboundConfirmationCandidates: () => [], recordInboundConfirmation: () => false, close() {}}),
  });
  const regLease = core.registerConfirmationBackend({
    id: 'test-lease',
    open: () => ({natural: leaseStore.natural, listInboundConfirmationCandidates: () => [], recordInboundConfirmation: () => false, close() {}}),
  });
  t.after(() => { regFiles(); regLease(); });

  const filesService = createFilesService(env.rawConfig, filesStore, leaseStore, {stateRoot: env.stateRoot, trace() {}});
  const leaseService = createLeaseService(env.rawConfig, leaseStore, {stateRoot: env.stateRoot, trace() {}});
  const helper = makeActor();
  const req = {actor: helper.actor, scope: helper.scope, check() {}, isInteractiveOwner: true};
  const cfgObj = {channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: ownerPolicy(helper.row.qq)}}};

  const confirmAndDeliver = (proposal, domain, previewText, presentationFacts) => {
    assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(previewText));
    assert(!/[a-f0-9]{32,}/iu.test(previewText));
    const pv = {...helper.inbound('请求操作'), timestamp: nowMs};
    assert.equal(core.prepareConfirmationPreview(pv, {domain, proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}, previewText, presentationFacts), true);
    core.recordConfirmationDelivery({
      accountId: 'default', conversationId: pv.conversationId, sourceMessageId: pv.messageId, messageId: 'pv-' + proposal.proposalId, text: previewText,
    });
    nowMs += 2000;
    helper.nowMs = nowMs;
    const cf = {...helper.inbound('确认'), timestamp: nowMs};
    core.captureNaturalConfirmationRequest(cf);
    assert.equal(core.confirmNaturalProposal(cf, {domain, proposalId: proposal.proposalId, payloadHash: proposal.payloadHash}, nowMs).ok, true);
  };

  // Cleanup containing symlink inside target dir must be refused completely.
  const dirtyDir = path.join(env.downloads, 'cleanup-a');
  fs.mkdirSync(dirtyDir);
  fs.writeFileSync(path.join(dirtyDir, 'a.log'), 'log1');
  fs.symlinkSync(path.join(env.outside, 'secret.txt'), path.join(dirtyDir, 'bad-link'));
  await assert.rejects(() => filesService({action: 'propose', operation: 'cleanup_dir', path: dirtyDir, includeRoot: true}, cfgObj, req), {code: 'files_symlink_not_allowed'});
  fs.unlinkSync(path.join(dirtyDir, 'bad-link'));
  fs.writeFileSync(path.join(dirtyDir, 'b.log'), 'log2');

  // Propose cleanup, test drift, then clean re-propose + confirm + commit.
  const pDrift = await filesService({action: 'propose', operation: 'cleanup_dir', path: dirtyDir, includeRoot: true}, cfgObj, req);
  confirmAndDeliver(pDrift, 'host_files', pDrift.previewText, pDrift.presentationFacts);
  fs.writeFileSync(path.join(dirtyDir, 'a.log'), 'MODIFIED_DURING_CONFIRM');
  await assert.rejects(() => filesService({action: 'commit', proposalId: pDrift.proposalId}, cfgObj, req), {code: 'files_plan_drifted'});

  const pClean = await filesService({action: 'propose', operation: 'cleanup_dir', path: dirtyDir, includeRoot: true}, cfgObj, req);
  const checkedPreview = buildFilesPreview({
    operation: 'cleanup_dir', summaryTarget: dirtyDir, itemCount: pClean.itemCount, totalBytes: pClean.totalBytes, sampleNames: ['a.log'], hasOversizeFiles: false,
  });
  assert.equal(checkedPreview.presentationFacts.join('\n'), checkedPreview.previewText);
  confirmAndDeliver(pClean, 'host_files', pClean.previewText, pClean.presentationFacts);

  const committed = await filesService({action: 'commit', proposalId: pClean.proposalId}, cfgObj, req);
  assert.equal(committed.ok, true);
  assert.equal(committed.snapshotsCreated, 2);
  assert(!fs.existsSync(dirtyDir));
  await assert.rejects(() => filesService({action: 'commit', proposalId: pClean.proposalId}, cfgObj, req), {code: 'files_proposal_already_submitted'});

  // Verify restore works for cleaned files too.
  await filesService({action: 'restore', snapshotId: committed.snapshotIds[0]}, cfgObj, req);
  assert(fs.existsSync(path.join(dirtyDir, 'a.log')));

  // Lease cannot target read-only or allowLease=false T2 directories.
  await assert.rejects(() => leaseService({
    action: 'propose', label: '只读区', actions: ['files.write'], roots: [env.repoReadOnly], maxOps: 5, maxBytes: 4096, ttlSeconds: 300,
  }, cfgObj, req), {code: 'files_t2_readonly_denied'});
  await assert.rejects(() => leaseService({
    action: 'propose', label: '禁止租约T2', actions: ['files.write'], roots: [env.t2Writable], maxOps: 5, maxBytes: 4096, ttlSeconds: 300,
  }, cfgObj, req), {code: 'lease_root_not_eligible'});

  // Propose + confirm + commit lease for downloads & allowLease T2.
  const lp = await leaseService({
    action: 'propose',
    label: '清理与配置维护',
    actions: ['files.write', 'files.batch_delete'],
    roots: [env.downloads, env.t2Leaseable],
    maxOps: 5,
    maxBytes: 65536,
    ttlSeconds: 600,
  }, cfgObj, req);
  confirmAndDeliver(lp, 'scoped_lease', lp.previewText, lp.presentationFacts);
  const lc = await leaseService({action: 'commit', proposalId: lp.proposalId}, cfgObj, req);
  assert.equal(lc.status, 'active');

  // Direct write in allowLease=true T2 works with leaseId; batch_delete in downloads consumes ops.
  const t2File = path.join(env.t2Leaseable, 'settings.json');
  const wRes = await filesService({action: 'write', path: t2File, content: '{"v":1}', leaseId: lc.leaseId}, cfgObj, req);
  assert.equal(wRes.ok, true);
  assert.equal(wRes.lease.usedOps, 1);

  const b1 = path.join(env.downloads, 'd1.tmp');
  const b2 = path.join(env.downloads, 'd2.tmp');
  fs.writeFileSync(b1, '111');
  fs.writeFileSync(b2, '2222');
  const bRes = await filesService({
    action: 'apply_leased',
    leaseId: lc.leaseId,
    operation: 'batch_delete',
    paths: [b1, b2],
  }, cfgObj, req);
  assert.equal(bRes.ok, true);
  assert.equal(bRes.snapshotsCreated, 2);
  assert.equal(bRes.lease.usedOps, 3);

  // Applying lease with an uncovered action or outside scoped roots fails cleanly without quota deduction.
  const outDoc = path.join(env.documents, 'untouched.txt');
  const dlKeep = path.join(env.downloads, 'stay.txt');
  fs.writeFileSync(outDoc, 'stay');
  fs.writeFileSync(dlKeep, 'stay-dl');
  await assert.rejects(() => filesService({
    action: 'apply_leased', leaseId: lc.leaseId, operation: 'copy', sourcePath: dlKeep, targetPath: path.join(env.downloads, 'copied.txt'),
  }, cfgObj, req), {code: 'lease_action_not_covered'});
  await assert.rejects(() => filesService({
    action: 'apply_leased', leaseId: lc.leaseId, operation: 'batch_delete', paths: [outDoc],
  }, cfgObj, req), {code: 'lease_scope_violation'});
  assert(fs.existsSync(outDoc));

  // Writable non-leaseable T2 requires propose + confirm + commit flow.
  const t2Conf = path.join(env.t2Writable, 'app.ini');
  const t2Prop = await filesService({action: 'propose', operation: 't2_write', path: t2Conf, content: '[app]\nmode=safe\n', mode: 'create'}, cfgObj, req);
  confirmAndDeliver(t2Prop, 'host_files', t2Prop.previewText, t2Prop.presentationFacts);
  const t2Done = await filesService({action: 'commit', proposalId: t2Prop.proposalId}, cfgObj, req);
  assert.equal(t2Done.ok, true);
  assert.equal(fs.readFileSync(t2Conf, 'utf8'), '[app]\nmode=safe\n');
  const t2Status = await filesService({action: 'status', proposalId: t2Prop.proposalId}, cfgObj, req);
  assert.equal(t2Status.status, 'succeeded');

  // Revoke and verify immediate denial.
  await leaseService({action: 'revoke', leaseId: lc.leaseId}, cfgObj, req);
  await assert.rejects(() => filesService({
    action: 'write', path: t2File, content: '{"v":2}', mode: 'overwrite', leaseId: lc.leaseId,
  }, cfgObj, req), {code: 'lease_revoked'});
});

test('Stage 2B homeDir broad T1 protects dotfiles, toolchains, nested redlines, search budget, and cleanup', async t => {
  const env = setupEnv('stage2b-');
  const desktop = path.join(env.homeDir, '桌面');
  const miniconda = path.join(env.homeDir, 'miniconda3', 'envs', 'py');
  const xwechat = path.join(env.homeDir, '.xwechat');
  const keyrings = path.join(env.homeDir, '.local', 'share', 'keyrings');
  const kmConfig = path.join(env.homeDir, '.config', 'knowledgemap');
  const cacheDir = path.join(env.homeDir, '.cache', 'pip');
  for (const dir of [desktop, miniconda, xwechat, keyrings, kmConfig, cacheDir]) {
    fs.mkdirSync(dir, {recursive: true});
  }
  fs.writeFileSync(path.join(xwechat, 'session.db'), 'WECHAT_SECRET');
  fs.writeFileSync(path.join(keyrings, 'login.keyring'), 'KEYRING_SECRET');
  fs.writeFileSync(path.join(kmConfig, 'tokens.json'), 'KM_TOKEN');
  fs.writeFileSync(path.join(miniconda, 'conda.txt'), 'needle-ignore-in-toolchain');
  fs.writeFileSync(path.join(cacheDir, 'wheel.txt'), 'needle-ignore-in-cache');
  fs.writeFileSync(path.join(env.repoReadOnly, 'notes.md'), 'needle-ignore-in-repo');
  fs.writeFileSync(path.join(desktop, 'todo.md'), 'needle-in-desktop\n');

  const stage2bConfig = {
    ...env.rawConfig,
    t1Roots: [{path: env.homeDir, label: '主目录一般工作区'}],
  };
  let nowMs = 1_800_000_000_000;
  const cfg = validateFilesConfig(stage2bConfig, {stateRoot: env.stateRoot});
  const filesStore = new FilesStore(env.stateRoot, cfg, () => nowMs);
  const leaseStore = new ScopedLeaseStore(env.stateRoot, () => nowMs);
  t.after(() => { filesStore.close(); leaseStore.close(); });

  const service = createFilesService(stage2bConfig, filesStore, leaseStore, {stateRoot: env.stateRoot, trace() {}});
  const helper = makeActor();
  const req = {actor: helper.actor, scope: helper.scope, check() {}, isInteractiveOwner: true};
  const cfgObj = {channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: ownerPolicy(helper.row.qq)}}};

  // Writable desktop/downloads work directly under T1 with auto-snapshots, while dotfiles/toolchains stay protected.
  const desktopNote = path.join(desktop, 'summary.txt');
  const created = await service({action: 'write', path: desktopNote, content: 'v1', mode: 'create'}, cfgObj, req);
  assert.equal(created.tier, 'T1');
  const edited = await service({action: 'write', path: desktopNote, content: 'v2', mode: 'overwrite'}, cfgObj, req);
  assert(edited.snapshotId);

  // Nested sensitive T3 directories stay invisible and unreadable even with homeDir as T1.
  for (const redPath of [
    path.join(xwechat, 'session.db'),
    path.join(keyrings, 'login.keyring'),
    path.join(kmConfig, 'tokens.json'),
    path.join(desktop, '.env.prod'),
  ]) {
    await assert.rejects(() => service({action: 'read', path: redPath}, cfgObj, req), {code: 'files_redline_denied'});
  }
  await assert.rejects(() => service({
    action: 'write', path: path.join(desktop, '.env.prod'), content: 'SECRET=1', mode: 'create',
  }, cfgObj, req), {code: 'files_redline_denied'});

  // Modifying/creating dotfiles directly under homeDir or writing inside miniconda3 is blocked as readOnly T2.
  for (const [protectedPath, mode] of [
    [path.join(env.homeDir, '.bashrc'), 'overwrite'],
    [path.join(env.homeDir, '.evil-profile'), 'create'],
    [path.join(miniconda, 'site.py'), 'create'],
  ]) {
    await assert.rejects(() => service({
      action: 'write', path: protectedPath, content: 'blocked', mode,
    }, cfgObj, req), {code: 'files_t2_readonly_denied'});
  }
  await assert.rejects(() => service({
    action: 'mkdir', path: path.join(env.homeDir, '.hidden-evil-dir'),
  }, cfgObj, req), {code: 'files_t2_readonly_denied'});

  // Listing homeDir skips T3 redlines and labels miniconda3/.bashrc as readOnly T2, kurumi-space as T0, 桌面 as T1.
  const listing = await service({action: 'list', path: env.homeDir}, cfgObj, req);
  const byName = new Map(listing.entries.map(e => [e.name, e]));
  assert(!byName.has('.ssh'));
  assert(!byName.has('.xwechat'));
  assert.equal(byName.get('kurumi-space')?.tier, 'T0');
  assert.equal(byName.get('桌面')?.tier, 'T1');
  assert.equal(byName.get('桌面')?.readOnly, false);
  assert.equal(byName.get('.bashrc')?.tier, 'T2');
  assert.equal(byName.get('.bashrc')?.readOnly, true);
  assert.equal(byName.get('miniconda3')?.tier, 'T2');
  assert.equal(byName.get('miniconda3')?.readOnly, true);

  // Searching homeDir skips readOnly subtrees (.cache, miniconda3, repository) and finds 桌面/todo.md cleanly.
  const foundHome = await service({action: 'search', path: env.homeDir, query: 'needle-'}, cfgObj, req);
  assert.deepEqual(foundHome.matches.map(m => m.path), [path.join(desktop, 'todo.md')]);

  // Explicit search inside readOnly repository still works.
  const foundRepo = await service({action: 'search', path: env.repoReadOnly, query: 'needle-'}, cfgObj, req);
  assert.deepEqual(foundRepo.matches.map(m => m.path), [path.join(env.repoReadOnly, 'notes.md')]);

  // cleanup_dir directly on homeDir (even includeRoot: false + pattern) must always fail closed.
  await assert.rejects(() => service({
    action: 'propose', operation: 'cleanup_dir', path: env.homeDir, includeRoot: false, pattern: '*.tmp',
  }, cfgObj, req), {code: 'files_tier_root_protected'});
});

test('OpenClaw service manager starts/stops kurumi-files and cleans both confirmation backends', async t => {
  const sdkDist = path.dirname(fileURLToPath(import.meta.resolve('openclaw')));
  const bundles = fs.readdirSync(sdkDist).filter(name => /^services-.*\.mjs$/.test(name)
    && fs.readFileSync(path.join(sdkDist, name), 'utf8').includes('function startPluginServices('));
  assert.equal(bundles.length, 1);
  const manager = await import(pathToFileURL(path.join(sdkDist, bundles[0])).href);
  const {GatewayScheduler} = await import(pathToFileURL(path.join(sdkDist, 'infra/gateway-scheduler.js')).href);
  const startPluginServices = Object.values(manager).find(value => typeof value === 'function' && value.name === 'startPluginServices');

  const env = setupEnv('lifecycle-');
  const cfg = {plugins: {entries: {'kurumi-files': {enabled: true, config: env.rawConfig}}}};
  const plugin = createFilesPlugin({trace() {}});

  const discoveryTools = [];
  plugin.register({
    config: cfg, pluginConfig: env.rawConfig, registrationMode: 'discovery',
    logger: {info() {}, warn() {}},
    registerService() { throw Error('discovery must not register service'); },
    registerTool(factory) { discoveryTools.push(factory); },
  });
  assert.equal(discoveryTools.length, 2);

  const services = [];
  const toolFactories = new Map();
  plugin.register({
    config: cfg, pluginConfig: env.rawConfig, registrationMode: 'full',
    logger: {info() {}, warn() {}},
    runtime: {state: {resolveStateDir: () => env.stateRoot}},
    registerService(service) { services.push(service); },
    registerTool(factory, opts) { toolFactories.set(opts.name, factory); },
  });

  const before = core.confirmationBackendIds();
  const host = await startPluginServices({
    scheduler: new GatewayScheduler(), config: cfg, workspaceDir: env.stateRoot, throwOnStartError: true,
    registry: {plugins: [], services: services.map(service => ({pluginId: service.id, id: service.id, service}))},
  });
  t.after(() => host.stop());
  assert.deepEqual(core.confirmationBackendIds(), [...before, 'kurumi-files', 'kurumi-scoped-lease'].sort());

  await host.stop();
  assert.deepEqual(core.confirmationBackendIds(), before);

  const helper = makeActor();
  const ownerCfg = {channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: ownerPolicy(helper.row.qq)}}};
  const fTool = toolFactories.get('kurumi_files').create({...helper.ctx, getRuntimeConfig: () => ownerCfg});
  const lTool = toolFactories.get('kurumi_lease').create({...helper.ctx, getRuntimeConfig: () => ownerCfg});
  assert.deepEqual((await fTool.execute('s1', {action: 'roots'})).details, {ok: false, code: 'files_unavailable'});
  assert.deepEqual((await lTool.execute('s2', {action: 'list'})).details, {ok: false, code: 'lease_unavailable'});
});
