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
import {openPolicySource, openRuntimeSource} from '../../plugins/kurumi-access-admin/source.js';
import {AccessChangeStore} from '../../plugins/kurumi-access-admin/store.js';
import {compileAccessConfig} from '../../packages/access-control/config.js';
import {context, MEMBER, memberRow, OTHER, OWNER, ownerPolicy} from './fixtures.mjs';

const protectedGroup = {...memberRow(OTHER), kind: 'group', enabled: false, permissions: {}};
const chatPermissions = ['chat.use', 'qq.reply'];
const add = {op: 'add', qq: MEMBER, grant: chatPermissions};

function fixture(t, enabledCategories = [], toolSurface, configure = () => {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-member-admin-'));
  const sourceRoot = path.join(root, 'source'), stateRoot = path.join(root, 'runtime');
  fs.mkdirSync(path.join(sourceRoot, 'config'), {recursive: true});
  fs.mkdirSync(stateRoot);
  const file = path.join(sourceRoot, 'config/access-control.json');
  const runtimeFile = path.join(sourceRoot, 'config/runtime.config.json');
  const original = ownerPolicy();
  original.subjects.push(memberRow(OTHER), protectedGroup);
  const writePolicy = value => fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {mode: 0o640});
  const read = () => fs.readFileSync(file, 'utf8');
  writePolicy(original);
  const intent = {channels: {'kurumi-qq': {}}, agents: {entries: {main: {workspace: path.join(stateRoot, 'workspace'),
    tools: {profile: 'messaging', alsoAllow: ['kurumi_access', 'personal_confirmation']}}}},
    plugins: {entries: {
      'kurumi-access-admin': {enabled: true, config: {enabledCategories}},
      'kurumi-mail': {enabled: true},
    }}};
  configure(intent, root);
  const readIntent = () => JSON.parse(fs.readFileSync(runtimeFile, 'utf8'));
  const writeIntent = value => fs.writeFileSync(runtimeFile, JSON.stringify(value, null, 2) + '\n');
  writeIntent(intent);
  let config;
  const sync = () => { config = compileAccessConfig(readIntent(), JSON.parse(read())); };
  sync();
  const ownerContext = context(original.subjects[0]);
  const source = openPolicySource(sourceRoot);
  const runtimeSource = openRuntimeSource(sourceRoot);
  let now = Date.now();
  const store = new AccessChangeStore(stateRoot, () => now);
  const natural = store.natural;
  const unregister = registerConfirmationBackend({id: 'access-admin-fixture', open: () => ({natural, close() {}})});
  t.after(() => {
    clearNaturalConfirmationRequest(ownerContext.sessionKey);
    unregister();
    store.close();
    fs.rmSync(root, {recursive: true, force: true});
  });
  const run = (args, ctx = ownerContext, policySource = source) =>
    createAccessAdminService(policySource, store, {runtimeSource, sourceRoot, stateRoot})(args, config,
      {...ownerInvocation(ctx, config, args), toolSurface});
  const propose = (change, category) => run({action: 'propose', change, ...(category ? {category} : {})});
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
  function apply(change, category) {
    const proposal = propose(change, category);
    approve(proposal);
    assert.equal(commit(proposal).status, 'written');
    return proposal;
  }
  return {apply, approve, commit, file, newMessage, original, ownerContext, propose, read, run,
    readIntent, root, source, sourceRoot, stateRoot, status, sync, writeIntent, writePolicy, advance: ms => { now += ms; }};
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
  assert.deepEqual(fs.readdirSync(path.dirname(f.file)).sort(), ['access-control.json', 'runtime.config.json']);
});

test('mail management is opt-in even for the owner', t => {
  const f = fixture(t);
  assert.throws(() => f.run({action: 'list', category: 'mail_recipient'}), {code: 'access_category_not_enabled'});
  assert.throws(() => f.propose({op: 'add', key: 'test@example.test'}, 'mail_recipient'), {code: 'access_category_not_enabled'});
});

test('mail preview freezes one address and distinguishes source, active and superseded changes', t => {
  const category = 'mail_recipient';
  const f = fixture(t, [category]);
  const base = f.original.subjects[0].mailRecipients[0];
  const newAddress = 'first+tag@example.test';
  const nextAddress = 'other@example.test';
  const get = key => f.run({action: 'get', category, key});
  const add = f.propose({op: 'add', key: ' First+Tag@Example.Test '}, category);
  assert(add.previewText.includes(newAddress));
  assert.equal(f.status(add).status, 'pending');
  assert.throws(() => f.commit(add), {code: 'approval_required'});
  assert.deepEqual(JSON.parse(f.read()), f.original);
  f.approve(add);
  assert.equal(f.commit(add).activation, 'pending_sync');
  assert.throws(() => f.commit(add), {code: 'access_change_already_submitted'});
  assert.equal(get(newAddress).runtime, null);
  f.sync();
  assert.equal(get(newAddress).runtime, newAddress);
  assert.equal(f.status(add).activation, 'active');

  const replace = f.apply({op: 'replace', key: newAddress, replacement: nextAddress}, category);
  assert.equal(f.status(add).activation, 'superseded');
  assert.equal(f.status(replace).activation, 'pending_sync');
  assert.equal(get(newAddress).source, null);
  assert.equal(get(newAddress).runtime, newAddress);
  f.sync();
  assert.equal(f.status(replace).activation, 'active');
  assert.equal(get(nextAddress).runtime, nextAddress);

  f.apply({op: 'remove', key: nextAddress}, category);
  f.apply({op: 'remove', key: base}, category);
  const expected = structuredClone(f.original);
  expected.revision += 4;
  expected.subjects[0].mailRecipients = [];
  assert.deepEqual(JSON.parse(f.read()), expected);
  f.sync();
  assert.deepEqual(f.run({action: 'list', category}).runtime, []);
});

test('mail rejects mixed shapes, duplicate/wildcard entries, members, and stale policy', t => {
  const category = 'mail_recipient';
  const f = fixture(t, [category]);
  assert.throws(() => f.run({action: 'list', category}, context(memberRow(OTHER))), {code: 'capability_not_allowed'});
  for (const key of ['*@example.test', 'x?@example.test', 'a@example..test', 'a@example.test,b@example.test', 'Name <a@example.test>']) {
    assert.throws(() => f.propose({op: 'add', key}, category), {code: 'invalid_mail_recipient'});
  }
  assert.throws(() => f.propose({op: 'add', key: f.original.subjects[0].mailRecipients[0]}, category),
    {code: 'access_entry_already_exists'});
  assert.throws(() => f.propose({op: 'add', key: 'test@example.test', qq: OTHER}, category),
    {code: 'invalid_access_admin_arguments'});
  const pending = f.propose({op: 'add', key: 'test@example.test'}, category);
  f.approve(pending);
  const concurrent = structuredClone(f.original);
  concurrent.subjects[1].enabled = false;
  f.writePolicy(concurrent);
  assert.equal(f.status(pending).status, 'stale');
  assert.throws(() => f.commit(pending), {code: 'access_policy_changed'});
  assert.deepEqual(JSON.parse(f.read()), concurrent);
});

test('tool whitelist refuses unauthorized additions, protects administration and previews inherited tools', async t => {
  const category = 'owner_tool';
  const surface = cfg => ['session_status', ...cfg.agents.entries.main.tools.alsoAllow.filter(name => name !== 'exec')];
  const f = fixture(t, [category], surface);
  const intent = f.readIntent();
  intent.agents.entries.main.tools.alsoAllow.push('session_status');
  f.writeIntent(intent);
  f.sync();
  assert.throws(() => f.propose({op: 'remove', key: 'kurumi_access'}, category), {code: 'access_management_tool_protected'});
  assert.throws(() => f.propose({op: 'replace', key: 'session_status', replacement: 'personal_confirmation'}, category),
    {code: 'access_entry_already_exists'});
  assert.throws(() => f.propose({op: 'add', key: 'unknown'}, category), {code: 'owner_tool_not_granted'});
  await assert.rejects(f.propose({op: 'add', key: 'exec'}, category), {code: 'owner_tool_unavailable'});
  const changed = structuredClone(f.original);
  delete changed.subjects[0].permissions['mail.status'];
  f.writePolicy(changed);
  assert.throws(() => f.propose({op: 'add', key: 'email_status'}, category), {code: 'owner_tool_not_granted'});
  const removal = await f.propose({op: 'remove', key: 'session_status'}, category);
  assert.match(removal.previewText, /其他规则提供/);
  await assert.rejects(f.commit(removal), {code: 'approval_required'});
  f.approve(removal);
  assert.equal((await f.commit(removal)).activation, 'pending_sync');
  assert.equal(f.status(removal).activation, 'pending_sync');
  f.sync();
  assert.equal(f.status(removal).activation, 'active');
  const list = await f.run({action: 'list', category});
  assert.deepEqual(list.source.sort(), ['kurumi_access', 'personal_confirmation']);
  assert(list.outsideAlsoAllow.includes('session_status'));
  assert.deepEqual(JSON.parse(f.read()), changed);
});

test('runtime proposal is stale after either its config or the identity source changes', async t => {
  const category = 'owner_tool';
  const f = fixture(t, [category], cfg => cfg.agents.entries.main.tools.alsoAllow);
  const change = {op: 'add', key: 'email_status'};
  const beforeConfig = await f.propose(change, category);
  f.approve(beforeConfig);
  const concurrent = f.readIntent();
  concurrent.tools = {codeMode: false};
  f.writeIntent(concurrent);
  assert.equal(f.status(beforeConfig).status, 'stale');
  assert.throws(() => f.commit(beforeConfig), {code: 'access_policy_changed'});
  const beforeIdentity = await f.propose(change, category);
  f.approve(beforeIdentity);
  f.writePolicy({...f.original, revision: 2});
  assert.equal(f.status(beforeIdentity).status, 'stale');
  assert.throws(() => f.commit(beforeIdentity), {code: 'access_policy_changed'});
  assert.deepEqual(f.readIntent(), concurrent);
});

function directoryFixture(t) {
  return fixture(t, ['exec_root'], undefined, (intent, root) => {
    const base = path.join(root, 'ordinary');
    const primary = path.join(root, 'pilot');
    for (const directory of [base, primary, path.join(root, 'outside'), path.join(base, '文件 A'), path.join(base, '文件 B')]) {
      fs.mkdirSync(directory);
    }
    intent.plugins.entries['kurumi-access-admin'].config.execDirectoryBases = [base];
    intent.plugins.entries['kurumi-host-control'] = {enabled: true, config: {
      exec: {workdir: primary, timeoutSeconds: 60, writeBoundary: {root: primary, launcher: '/usr/bin/true'}},
    }};
  });
}

test('directory changes touch only extra roots and never touch the directory or the fixed fence', t => {
  const category = 'exec_root', f = directoryFixture(t);
  const first = path.join(f.root, 'ordinary/文件 A'), second = path.join(f.root, 'ordinary/文件 B');
  fs.writeFileSync(path.join(first, 'sentinel.txt'), 'retained');
  const before = f.readIntent();
  const added = f.apply({op: 'add', key: first}, category);
  assert.equal(f.status(added).activation, 'pending_sync');
  f.sync();
  assert.equal(f.status(added).activation, 'active');
  const replace = f.apply({op: 'replace', key: first, replacement: second}, category);
  assert.equal(f.status(replace).activation, 'pending_sync');
  const after = f.readIntent();
  assert.deepEqual(after.plugins.entries['kurumi-host-control'].config.exec.writeBoundary.additionalRoots, [second]);
  assert.equal(fs.readFileSync(path.join(first, 'sentinel.txt'), 'utf8'), 'retained');
  f.apply({op: 'remove', key: second}, category);
  before.plugins.entries['kurumi-host-control'].config.exec.writeBoundary.additionalRoots = [];
  assert.deepEqual(f.readIntent(), before);
});

test('directory additions reject out-of-scope, protected, overlapping, linked and replaced directories', t => {
  const category = 'exec_root', f = directoryFixture(t);
  const add = key => f.propose({op: 'add', key}, category);
  const base = path.join(f.root, 'ordinary'), first = path.join(base, '文件 A');
  assert.throws(() => add(path.join(f.root, 'outside')), {code: 'exec_directory_not_approved'});
  for (const key of [f.sourceRoot, f.stateRoot, '/usr', '/etc']) {
    assert.throws(() => add(key), {code: 'exec_directory_protected'});
  }
  assert.throws(() => add(base + '/..'), {code: 'invalid_exec_directory'});
  assert.throws(() => f.propose({op: 'add', key: first, launcher: '/usr/bin/true'}, category), {code: 'invalid_access_admin_arguments'});
  const link = path.join(base, 'linked');
  fs.symlinkSync(first, link);
  assert.throws(() => add(link), {code: 'invalid_exec_directory'});
  const pending = add(first);
  f.approve(pending);
  fs.renameSync(first, first + '-old');
  fs.mkdirSync(first);
  assert.throws(() => f.commit(pending), {code: 'access_policy_changed'});
  f.apply({op: 'add', key: first}, category);
  assert.throws(() => add(base), {code: 'exec_directory_boundary_invalid'});
});
