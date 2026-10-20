// Offline shared-package/consumer integration. Build TypeScript packages first.
// Only in-memory SQLite and process-local hooks; no network or production state.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import * as core from '../../packages/confirmation-core/dist/index.js';
import {registerDomainBackend} from '../../packages/personal-domains/dist/confirmation-backends.js';
import {registerInteractionHooks} from '../../packages/personal-domains/dist/interaction/index.js';

test('shared package preserves its complete runtime public API without leaking split helpers', () => {
  assert.deepEqual(Object.keys(core).sort(), [
    'CONFIRMATION_GATE_SCHEMA_SQL', 'buildConfirmationInstruction', 'checkApprovalGrant', 'confirmationBackendIds',
    'createPublicUuid', 'ensureConfirmationGateSchema', 'findConfirmationProposalForInbound', 'issueApprovalGrant',
    'listConfirmationProposalsForInbound', 'listPendingConfirmationProposals', 'markConfirmationProposalCommitted',
    'markConfirmationProposalExpired', 'parseConfirmationText', 'recordRegisteredConfirmation',
    'registerConfirmationBackend', 'registerConfirmationProposal', 'scopeFromInboundEvent', 'scopeFromToolContext',
  ].sort());
});

test('grant consumption can roll back with a business transaction and then commit exactly once', t => {
  const db = new DatabaseSync(':memory:');
  t.after(() => db.close());
  const now = 1800000000, id = '12345678-1234-4234-8234-123456789abc', hash = 'a'.repeat(64);
  const subjectId = '100001', sessionKey = `agent:main:kurumi-qq:direct:${subjectId}`;
  const scope = core.scopeFromToolContext({messageChannel: 'kurumi-qq', senderIsOwner: true,
    requesterSenderId: subjectId, sessionKey, deliveryContext: {to: `user:${subjectId}`, accountId: 'default'}});
  core.registerConfirmationProposal(db, {proposalId: id, domain: 'independent-notes', actionKind: 'note.save',
    subjectId, payloadHash: hash, scope, createdAtUtc: now - 1, expiresAtUtc: now + 600});
  const proposal = core.listPendingConfirmationProposals(db, {subjectId, scope, nowUtc: now})[0];
  core.issueApprovalGrant(db, {proposal, confirmationMessageId: 'confirmed', scope, nowUtc: now});
  const check = {proposalId: id, domain: proposal.domain, subjectId, payloadHash: hash, scope, nowUtc: now, consume: true};
  db.exec('CREATE TABLE notes(value TEXT NOT NULL) STRICT; BEGIN IMMEDIATE');
  assert.equal(core.checkApprovalGrant(db, check).ok, true);
  assert.throws(() => db.prepare('INSERT INTO notes VALUES(?)').run(null));
  db.exec('ROLLBACK');
  assert.equal(db.prepare('SELECT status FROM approval_grants').get().status, 'pending');
  db.exec('BEGIN IMMEDIATE');
  assert.equal(core.checkApprovalGrant(db, check).ok, true);
  db.prepare('INSERT INTO notes VALUES(?)').run('committed');
  core.markConfirmationProposalCommitted(db, {proposalId: id, subjectId, atUtc: now});
  db.exec('COMMIT');
  assert.equal(core.checkApprovalGrant(db, check).code, 'grant_replayed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM notes').get().n, 1);
});

test('a domain registers exactly its own backend and cleans it up on stop', () => {
  const before = core.confirmationBackendIds(), services = [];
  registerDomainBackend({registerService: service => services.push(service)}, {
    id: 'personal-profile', domain: 'personal_profile', open() { throw Error('must not open'); },
  });
  assert.equal(services.length, 1);
  try {
    services[0].start();
    services[0].start();
    assert.deepEqual(core.confirmationBackendIds(), [...before, 'personal-profile'].sort());
  } finally { services[0].stop(); }
  assert.deepEqual(core.confirmationBackendIds(), before);
});

test('a partial backend-registration failure removes only the registrations it owns', () => {
  const existing = core.registerConfirmationBackend({id: 'personal-reminder', open() { throw Error('must not open'); }});
  let service;
  try {
    registerDomainBackend({registerService: value => service = value}, {
      id: 'personal-reminder', domain: 'personal_reminder', open() { throw Error('must not open'); },
    });
    assert.throws(() => service.start(), /already registered/);
    assert.ok(!core.confirmationBackendIds().includes('profile-planning'));
    assert.ok(core.confirmationBackendIds().includes('personal-reminder'));
  } finally { service?.stop(); existing(); }
});

test('composed interaction hooks block only the intended tool/run and never register confirmation backends', () => {
  const before = core.confirmationBackendIds(), hooks = {};
  registerInteractionHooks({on: (name, handler) => (hooks[name] ??= []).push(handler)}, {
    clarificationTools: ['personal_profile_change_propose'], proposalTools: ['personal_profile_change_propose'],
  });
  const context = {runId: 'run-one', sessionKey: 'test-session'};
  const event = {toolName: 'personal_profile_change_propose', runId: context.runId,
    result: {content: [{type: 'text', text: JSON.stringify({ok: false, requiresUserInput: true})}]}};
  for (const hook of hooks.after_tool_call) hook(event, context);
  assert.equal(hooks.before_tool_call[0](event, context).block, true);
  assert.equal(hooks.before_tool_call[0]({...event, toolName: 'personal_reminder_propose'}, context), undefined);
  assert.equal(hooks.before_tool_call[0]({...event, runId: 'run-two'}, {...context, runId: 'run-two'}), undefined);
  assert.deepEqual(core.confirmationBackendIds(), before);
});
