// Offline unit tests for @kurumi/scoped-lease (docs/37 Stage 2A).
// Uses temporary SQLite; verifies bounds, N3/Cron refusal, natural confirmation, quota consumption, and revocation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import * as core from '../../packages/confirmation-core/dist/index.js';
import {
  ELIGIBLE_LEASE_ACTIONS,
  LEASE_DOMAIN,
  LEASE_LIMITS,
  ScopedLeaseStore,
  assertInteractiveLeaseContext,
  buildLeasePreview,
  validateLeasePlan,
} from '../../packages/scoped-lease/index.js';
import {ownerPolicy, memberRow, context} from '../access-control/fixtures.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-scoped-lease-test-'));
after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));

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

test('validateLeasePlan enforces action allowlist, safe roots, and upper/lower quota bounds', () => {
  const validDir = path.join(tmpRoot, 'downloads');
  const nestedDir = path.join(tmpRoot, 'downloads/sub');
  const linkDir = path.join(tmpRoot, 'downloads-link');
  fs.mkdirSync(nestedDir, {recursive: true});
  fs.symlinkSync(validDir, linkDir);

  const plan = validateLeasePlan({
    label: '整理下载目录',
    actions: ['files.move', 'files.delete', 'files.move'],
    roots: [validDir],
    maxOps: 10,
    maxBytes: 1024 * 1024,
    ttlSeconds: 600,
  }, {validateRoot: r => r});

  assert.equal(plan.label, '整理下载目录');
  assert.deepEqual(plan.actions, ['files.delete', 'files.move']);
  assert.deepEqual(plan.roots, [validDir]);
  assert.equal(plan.maxOps, 10);
  assert.equal(plan.ttlSeconds, 600);

  assert.throws(() => validateLeasePlan({
    label: '禁止高危动作',
    actions: ['coding.merge'],
    roots: [validDir],
    maxOps: 5,
    maxBytes: 4096,
    ttlSeconds: 300,
  }, {validateRoot: r => r}), {code: 'lease_action_not_eligible'});

  assert.throws(() => validateLeasePlan({
    label: '禁止系统目录',
    actions: ['host_sudo.etc.write'],
    roots: [validDir],
    maxOps: 5,
    maxBytes: 4096,
    ttlSeconds: 300,
  }, {validateRoot: r => r}), {code: 'lease_action_not_eligible'});

  assert.throws(() => validateLeasePlan({
    label: '软链根目录',
    actions: ['files.write'],
    roots: [linkDir],
    maxOps: 5,
    maxBytes: 4096,
    ttlSeconds: 300,
  }, {validateRoot: r => r}), {code: 'lease_root_not_allowed'});

  for (const patch of [
    {maxOps: 0},
    {maxOps: LEASE_LIMITS.maxMaxOps + 1},
    {maxBytes: 512},
    {maxBytes: LEASE_LIMITS.maxMaxBytes + 1},
    {ttlSeconds: 10},
    {ttlSeconds: LEASE_LIMITS.maxTtlSeconds + 1},
  ]) {
    assert.throws(() => validateLeasePlan({
      label: '超限测试',
      actions: ['files.write'],
      roots: [validDir],
      ...patch,
    }, {validateRoot: r => r}), {code: 'lease_quota_out_of_range'});
  }
});

test('buildLeasePreview stays concise without raw UUIDs or SHA256 hashes', () => {
  const dir = path.join(tmpRoot, 'preview-dir');
  fs.mkdirSync(dir, {recursive: true});
  const plan = validateLeasePlan({
    label: '批量归档 PDF',
    actions: ['files.move', 'files.copy'],
    roots: [dir],
    maxOps: 15,
    maxBytes: 10 * 1024 * 1024,
    ttlSeconds: 1800,
  }, {validateRoot: r => r});
  const {previewText, presentationFacts} = buildLeasePreview(plan);
  assert.equal(presentationFacts.join('\n'), previewText);
  assert(previewText.includes('批量归档 PDF'));
  assert(previewText.includes('最多 15 次操作'));
  assert(previewText.includes('后台唤醒不继承'));
  assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(previewText));
  assert(!/[a-f0-9]{32,}/iu.test(previewText));
});

test('assertInteractiveLeaseContext refuses N3 proactive wake sessions, Cron lanes, and non-main sessions', () => {
  const ownerCtx = makeActor().ctx;
  assert.doesNotThrow(() => assertInteractiveLeaseContext(ownerCtx));

  assert.throws(() => assertInteractiveLeaseContext({
    ...ownerCtx,
    sessionKey: 'agent:main:kurumi-proactive:365999865',
  }), {code: 'lease_forbidden_in_wake_session'});

  assert.throws(() => assertInteractiveLeaseContext({
    ...ownerCtx,
    sessionKey: 'agent:main:cron:12345678-1234-4234-8234-123456789abc',
  }), {code: 'lease_forbidden_in_wake_session'});

  assert.throws(() => assertInteractiveLeaseContext({
    ...context(memberRow()),
  }), {code: 'lease_requires_owner_chat'});
});

test('ScopedLeaseStore confirms once, enforces boundaries/quotas/expiry/revocation, and blocks wake consumption', async t => {
  const stateRoot = fs.mkdtempSync(path.join(tmpRoot, 'lease-store-'));
  const downloads = path.join(tmpRoot, 'store-downloads');
  const downloadsSibling = path.join(tmpRoot, 'store-downloads-sibling');
  fs.mkdirSync(downloads, {recursive: true});
  fs.mkdirSync(downloadsSibling, {recursive: true});

  let nowMs = 1_800_000_000_000;
  const store = new ScopedLeaseStore(stateRoot, () => nowMs);
  t.after(() => store.close());
  const unregister = core.registerConfirmationBackend({
    id: 'test-lease-store',
    open: () => ({
      natural: store.natural,
      listInboundConfirmationCandidates: () => [],
      recordInboundConfirmation: () => false,
      close() {},
    }),
  });
  t.after(unregister);

  const helper = makeActor();
  helper.nowMs = nowMs;
  const plan = validateLeasePlan({
    label: '下载清理租约',
    actions: ['files.delete', 'files.move'],
    roots: [downloads],
    maxOps: 3,
    maxBytes: 1024,
    ttlSeconds: 120,
  }, {validateRoot: r => r});

  const proposed = store.propose(plan, helper.actor.id, helper.scope);
  assert.equal(proposed.domain, LEASE_DOMAIN);
  const {previewText, presentationFacts} = buildLeasePreview(plan);

  // Unconfirmed commit fails closed.
  assert.throws(
    () => store.commitProposal(proposed.proposalId, helper.actor.id, helper.scope, helper.ctx.sessionKey, () => {}),
    {code: 'approval_required'},
  );

  // Present preview and confirm in later owner message.
  const pv = {...helper.inbound('建一个清理租约'), timestamp: nowMs};
  assert.equal(core.prepareConfirmationPreview(pv, proposed, previewText, presentationFacts), true);
  core.recordConfirmationDelivery({
    accountId: 'default',
    conversationId: pv.conversationId,
    sourceMessageId: pv.messageId,
    messageId: 'delivered-lease-pv',
    text: previewText,
  });

  nowMs += 3000;
  helper.nowMs = nowMs;
  const cf = {...helper.inbound('确认'), timestamp: nowMs};
  core.captureNaturalConfirmationRequest(cf);
  assert.equal(core.confirmNaturalProposal(cf, proposed, nowMs).ok, true);

  const activated = store.commitProposal(proposed.proposalId, helper.actor.id, helper.scope, helper.ctx.sessionKey, () => {});
  const leaseId = activated.lease.leaseId;
  assert.equal(activated.lease.state, 'active');
  assert.equal(activated.lease.remainingOps, 3);
  assert.equal(activated.lease.remainingBytes, 1024);

  // Cannot replay commit.
  assert.throws(
    () => store.commitProposal(proposed.proposalId, helper.actor.id, helper.scope, helper.ctx.sessionKey, () => {}),
    {code: 'lease_proposal_already_submitted'},
  );

  // Wake context cannot consume even an active lease.
  assert.throws(() => store.consume(leaseId, helper.actor.id, {
    action: 'files.delete',
    paths: [path.join(downloads, 'a.txt')],
    opCount: 1,
    byteCount: 10,
    isInteractiveOwner: false,
  }), {code: 'lease_forbidden_in_wake_session'});

  // Sibling prefix lookalike directory is strictly rejected without consuming quota.
  assert.throws(() => store.consume(leaseId, helper.actor.id, {
    action: 'files.delete',
    paths: [path.join(downloadsSibling, 'a.txt')],
    opCount: 1,
    byteCount: 10,
  }), {code: 'lease_scope_violation'});

  // Uncovered action rejected without consuming quota.
  assert.throws(() => store.consume(leaseId, helper.actor.id, {
    action: 'files.cleanup_dir',
    paths: [path.join(downloads, 'a.txt')],
    opCount: 1,
    byteCount: 10,
  }), {code: 'lease_action_not_covered'});

  // Quota exceeded is atomic (zero partial consumption).
  assert.throws(() => store.consume(leaseId, helper.actor.id, {
    action: 'files.delete',
    paths: [path.join(downloads, 'big.bin')],
    opCount: 1,
    byteCount: 1500,
  }), {code: 'lease_quota_exceeded'});

  assert.equal(store.getLease(leaseId, helper.actor.id).usedOps, 0);

  // Valid consumptions deduct ops and bytes cleanly.
  const afterOne = store.consume(leaseId, helper.actor.id, {
    action: 'files.delete',
    paths: [path.join(downloads, 'one.txt')],
    opCount: 1,
    byteCount: 120,
    targetSummary: 'one.txt',
  });
  assert.equal(afterOne.usedOps, 1);
  assert.equal(afterOne.remainingOps, 2);
  assert.equal(afterOne.remainingBytes, 904);

  // Instant revocation blocks subsequent usage immediately.
  const revoked = store.revoke(leaseId, helper.actor.id, 'done_early');
  assert.equal(revoked.state, 'revoked');
  assert.equal(revoked.alreadyInactive, false);
  assert.throws(() => store.consume(leaseId, helper.actor.id, {
    action: 'files.delete',
    paths: [path.join(downloads, 'two.txt')],
    opCount: 1,
    byteCount: 10,
  }), {code: 'lease_revoked'});

  // Expiry transition test on a fresh lease.
  const plan2 = validateLeasePlan({
    label: '短时租约',
    actions: ELIGIBLE_LEASE_ACTIONS.slice(0, 2),
    roots: [downloads],
    maxOps: 2,
    maxBytes: 4096,
    ttlSeconds: 60,
  }, {validateRoot: r => r});
  const p2 = store.propose(plan2, helper.actor.id, helper.scope);
  const pv2 = {...helper.inbound('再开短租约'), timestamp: nowMs};
  const pr2 = buildLeasePreview(plan2);
  core.prepareConfirmationPreview(pv2, p2, pr2.previewText, pr2.presentationFacts);
  core.recordConfirmationDelivery({
    accountId: 'default', conversationId: pv2.conversationId, sourceMessageId: pv2.messageId, messageId: 'pv2', text: pr2.previewText,
  });
  nowMs += 2000;
  const cf2 = {...helper.inbound('确认'), timestamp: nowMs};
  core.captureNaturalConfirmationRequest(cf2);
  core.confirmNaturalProposal(cf2, p2, nowMs);
  const act2 = store.commitProposal(p2.proposalId, helper.actor.id, helper.scope, helper.ctx.sessionKey, () => {});
  nowMs += 65_000;
  assert.throws(() => store.consume(act2.lease.leaseId, helper.actor.id, {
    action: 'files.write',
    paths: [path.join(downloads, 'x.txt')],
    opCount: 1,
    byteCount: 10,
  }), {code: 'lease_expired'});
  assert.equal(store.getLease(act2.lease.leaseId, helper.actor.id).state, 'expired');
});
