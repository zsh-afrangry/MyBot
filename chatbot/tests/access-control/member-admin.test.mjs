import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  captureNaturalConfirmationRequest, clearNaturalConfirmationRequest, confirmNaturalProposal,
  prepareConfirmationPreview, registerConfirmationBackend,
} from '../../packages/confirmation-core/dist/index.js';
import {ownerInvocation} from '../../plugins/kurumi-access-admin/inbound.js';
import {createAccessAdminService} from '../../plugins/kurumi-access-admin/service.js';
import {openPolicySource} from '../../plugins/kurumi-access-admin/source.js';
import {AccessChangeStore} from '../../plugins/kurumi-access-admin/store.js';
import {context, MEMBER, memberRow, OTHER, OWNER, ownerPolicy} from './fixtures.mjs';

const protectedGroup = {...memberRow(OTHER), kind: 'group', enabled: false, permissions: {}};
const chatPermissions = ['chat.use', 'qq.reply'];
const add = {op: 'add', qq: MEMBER, grant: chatPermissions};

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-member-admin-'));
  fs.mkdirSync(path.join(root, 'config'));
  const file = path.join(root, 'config/access-control.json');
  const original = ownerPolicy();
  original.subjects.push(memberRow(OTHER), protectedGroup);
  const writePolicy = value => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o640});
  const read = () => fs.readFileSync(file, 'utf8');
  writePolicy(original);
  const config = {channels: {'kurumi-qq': {ownerId: OWNER, accessControl: original}}};
  const ownerContext = context(original.subjects[0]);
  const source = openPolicySource(root);
  let now = Date.now();
  const store = new AccessChangeStore(root, () => now);
  const natural = store.natural;
  const unregister = registerConfirmationBackend({id: 'access-admin-fixture', open: () => ({natural, close() {}})});
  t.after(() => {
    clearNaturalConfirmationRequest(ownerContext.sessionKey);
    unregister();
    store.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  const run = (args, ctx = ownerContext, policySource = source) =>
    createAccessAdminService(policySource, store)(args, config, ownerInvocation(ctx, config, args));
  const propose = change => run({action: 'propose', change});
  const commit = ({proposalId}) => run({action: 'commit', proposalId});
  const status = ({proposalId}) => run({action: 'status', proposalId});
  let sequence = 0;
  function newMessage(content) {
    now += 1000;
    const event = {channel: 'kurumi-qq', senderId: OWNER, accountId: 'default',
      sessionKey: ownerContext.sessionKey, conversationId: `user:${OWNER}`,
      content, messageId: 'fixture-' + (++sequence), timestamp: now};
    captureNaturalConfirmationRequest(event);
    return event;
  }
  function approve(proposal) {
    const display = newMessage('请给出预览');
    assert(prepareConfirmationPreview(display, proposal, proposal.previewText, proposal.presentationFacts));
    assert(natural.presented(display, proposal, 'platform-' + sequence));
    const confirmation = newMessage('确认');
    assert.equal(confirmNaturalProposal(confirmation, proposal, now).ok, true);
  }
  function apply(change) {
    const proposal = propose(change);
    approve(proposal);
    assert.equal(commit(proposal).status, 'written');
    return proposal;
  }
  return {apply, approve, commit, file, newMessage, original, ownerContext, propose, read, run,
    source, status, writePolicy, advance: ms => { now += ms; }};
}

test('QQ member changes cover registration, per-permission edits, clearing fields, disabling and removal', t => {
  const f = fixture(t);
  const memberWorkspace = path.join(path.dirname(f.file), '../users', MEMBER, 'workspace');
  fs.mkdirSync(memberWorkspace, {recursive: true});
  const memberFile = path.join(memberWorkspace, 'synthetic.txt');
  fs.writeFileSync(memberFile, 'member data');
  const initial = f.read();
  const proposal = f.propose(add);
  assert.match(proposal.previewText, new RegExp('登记 ' + MEMBER));
  assert.equal(f.status(proposal).status, 'pending');
  assert.throws(() => f.commit(proposal), {code: 'approval_required'});
  assert.equal(f.read(), initial);
  f.approve(proposal);
  assert.deepEqual(f.commit(proposal), {ok: true, status: 'written', proposalId: proposal.proposalId,
    sourceRevision: 2, activation: 'pending_sync', runtimeRevision: 1});
  assert.throws(() => f.commit(proposal), {code: 'access_change_already_submitted'});
  assert.equal(f.status(proposal).status, 'written');
  assert.equal(fs.statSync(f.file).mode & 0o777, 0o640);

  f.apply({op: 'update', qq: MEMBER, grant: ['search.use'], revoke: ['qq.reply'], enabled: false,
    note: '仅用于隔离测试', expiresAt: '2028-02-29T10:00:00+08:00'});
  const {source, runtime, inSync} = f.run({action: 'get', qq: MEMBER});
  assert.deepEqual(source, {qq: MEMBER, permissions: ['chat.use', 'search.use'], enabled: false,
    note: '仅用于隔离测试', expiresAt: '2028-02-29T02:00:00.000Z'});
  assert.equal(runtime, null);
  assert.equal(inSync, false);

  f.apply({op: 'update', qq: MEMBER, enabled: true, note: null, expiresAt: null});
  const updated = JSON.parse(f.read()).subjects.at(-1);
  assert.equal(updated.enabled, true);
  assert.equal(Object.hasOwn(updated, 'note'), false);
  assert.equal(Object.hasOwn(updated, 'expiresAt'), false);
  assert.equal(Object.hasOwn(updated.permissions, 'qq.reply'), false);

  f.apply({op: 'remove', qq: MEMBER});
  assert.deepEqual(JSON.parse(f.read()), {...f.original, revision: 5});
  assert.equal(fs.readFileSync(memberFile, 'utf8'), 'member data');
});

test('only the current owner private chat can call member administration and protected fields refuse changes', t => {
  const f = fixture(t);
  const initial = f.read();
  const memberContext = context(memberRow(OTHER));
  assert.throws(() => f.run({action: 'list'}, memberContext), {code: 'capability_not_allowed'});
  assert.throws(() => f.run({action: 'list'}, {...memberContext, senderIsOwner: true}), {code: 'untrusted_identity_context'});
  assert.throws(() => f.run({action: 'list'}, {...f.ownerContext, sessionKey: 'agent:main:cron:fixture'}), {code: 'untrusted_identity_context'});
  assert.throws(() => f.run({action: 'list'}, {...f.ownerContext, assertInvocationCurrent() { throw Error('retired'); }}), /retired/);
  for (const op of ['add', 'update', 'remove']) {
    assert.throws(() => f.propose({op, qq: OWNER, ...(op === 'add' ? {grant: []} : {})}), {code: 'owner_record_protected'});
  }
  assert.throws(() => f.propose({...add, grant: undefined}), {code: 'invalid_member_permissions'});
  assert.throws(() => f.propose({...add, grant: ['access.manage']}), {code: 'invalid_member_permissions'});
  assert.throws(() => f.propose({...add, kind: 'group'}), {code: 'invalid_access_admin_arguments'});
  assert.throws(() => f.propose({...add, expiresAt: '2027-02-29T10:00:00Z'}), {code: 'invalid_member_expiry'});
  assert.equal(f.read(), initial);
});

test('expired proposals and confirmations from a previous request do not write', t => {
  const f = fixture(t);
  const initial = f.read();
  const expired = f.propose(add);
  f.advance(86400_000);
  assert.equal(f.status(expired).status, 'expired');
  assert.throws(() => f.commit(expired), {code: 'access_proposal_expired'});

  const staleApproval = f.propose(add);
  f.approve(staleApproval);
  f.newMessage('这是另一个请求');
  assert.throws(() => f.commit(staleApproval), {code: 'confirmation_context_mismatch'});
  assert.equal(f.read(), initial);
});

test('source edits before commit or before replacement are preserved', t => {
  const f = fixture(t);
  const proposal = f.propose(add);
  f.approve(proposal);
  const concurrent = structuredClone(f.original);
  concurrent.subjects[1].note = 'concurrent edit without revision bump';
  f.writePolicy(concurrent);
  assert.equal(f.status(proposal).status, 'stale');
  assert.throws(() => f.commit(proposal), {code: 'access_policy_changed'});

  const otherProposal = f.propose(add);
  f.approve(otherProposal);
  const race = {read: f.source.read, write(expected, bytes) {
    concurrent.subjects[1].note = 'edit after grant consumption';
    f.writePolicy(concurrent);
    f.source.write(expected, bytes);
  }};
  const result = f.run({action: 'commit', proposalId: otherProposal.proposalId}, f.ownerContext, race);
  assert.equal(result.code, 'access_policy_changed');
  assert.equal(f.status(otherProposal).status, 'failed');
  assert.deepEqual(JSON.parse(f.read()), concurrent);
  assert.throws(() => f.commit(otherProposal), {code: 'access_change_already_submitted'});
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)), ['access-control.json']);
});
