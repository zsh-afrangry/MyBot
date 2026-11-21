import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import {
  checkApprovalGrant, confirmNaturalProposal, createNaturalConfirmationBackend,
  listNaturalConfirmations, prepareConfirmationPreview, registerConfirmationBackend,
  registerConfirmationProposal, scopeFromInboundEvent, type ConfirmationInboundEvent,
  type ConfirmationScope,
} from './index.js';
import { ACCEPTANCE_CONFIRMATION_CHANNEL, recordScopedConfirmationDelivery, withScopedConfirmationBackends } from './acceptance.js';

it('isolates stores and receipts from other requests and revokes an abandoned grant at scope exit', async () => {
  const db = new DatabaseSync(':memory:'), subjectId = randomUUID(), now = Math.floor(Date.now() / 1000);
  const sessionKey = `agent:acceptance-fixture:scenario:${subjectId}`;
  const event = (content: string): ConfirmationInboundEvent => ({channel: ACCEPTANCE_CONFIRMATION_CHANNEL, isGroup: false,
    senderIsOwner: false, accountId: subjectId, conversationId: 'inbox:' + subjectId, senderId: subjectId, sessionKey,
    timestamp: now * 1000, messageId: randomUUID(), content});
  const selection = {domain: 'fixture', proposalId: randomUUID(), payloadHash: 'a'.repeat(64)};
  const natural = createNaturalConfirmationBackend(db, {subjectId, domains: [selection.domain], now: () => now});
  let globalOpens = 0, scopedOpens = 0;
  const off = registerConfirmationBackend({id: 'production-sentinel', open() {globalOpens++; throw Error('wrong_backend');}});
  const providers = [{id: 'scoped', open() {
    scopedOpens++;
    return {natural, close() {}, listInboundConfirmationCandidates: () => [], recordInboundConfirmation: () => false};
  }}];
  const consume = (scope: ConfirmationScope) => checkApprovalGrant(db, {...selection, subjectId, scope, nowUtc: now, consume: true});
  let abandon: (() => void) | undefined, late: Promise<void> | undefined;
  try {
    const copy = event('请预览');
    expect(() => listNaturalConfirmations(copy)).toThrow('no_backends');
    await expect(withScopedConfirmationBackends({event: {...copy, timestamp: now * 1000 - 300001}, providers}, async () => {}))
      .rejects.toThrow('invalid_scoped_confirmation_request');
    await withScopedConfirmationBackends({event: copy, providers}, async (request, scope) => {
      expect(() => listNaturalConfirmations({...request})).toThrow('no_backends');
      expect(() => listNaturalConfirmations({...request, channel: 'qqbot'})).toThrow('no_backends');
      expect(globalOpens).toBe(0);
      registerConfirmationProposal(db, {...selection, subjectId, scope, actionKind: 'create', createdAtUtc: now - 1, expiresAtUtc: now + 60});
      expect(prepareConfirmationPreview(request, selection, '测试预览：完整内容')).toBe(true);
      recordScopedConfirmationDelivery({...request}, {messageId: randomUUID(), text: '测试预览：完整内容'});
      recordScopedConfirmationDelivery(request, {messageId: randomUUID(), text: '测试预览'});
      expect(listNaturalConfirmations(request)[0]?.presentedAtUtc).toBeNull();
      recordScopedConfirmationDelivery(request, {messageId: randomUUID(), text: '测试预览：完整内容'});
      expect(listNaturalConfirmations(request)[0]?.presentedAtUtc).toBe(now);
    });
    await withScopedConfirmationBackends({event: event('确认'), providers}, async (request, scope) => {
      await Promise.resolve(); // This request resumes with its own backend binding.
      expect(confirmNaturalProposal(request, selection, now * 1000).ok).toBe(true);
      expect(consume({...scope})).toMatchObject({code: 'confirmation_context_mismatch'});
      late = new Promise<void>(resolve => {abandon = resolve;}).then(() => {
        expect(scopeFromInboundEvent(request)).toBeUndefined();
        expect(() => listNaturalConfirmations(request)).toThrow('no_backends');
        expect(consume(scope)).toMatchObject({code: 'confirmation_context_mismatch'});
      });
    });
    const previous = scopedOpens;
    abandon?.(); await late;
    expect(scopedOpens).toBe(previous);
    expect(globalOpens).toBe(0);
    expect(db.prepare('SELECT status FROM approval_grants').get()).toEqual({status: 'pending'});
  } finally { off(); db.close(); }
});

it('keeps two simultaneous bindings apart while an ordinary QQ request uses its own backend', async () => {
  const opened: string[] = [], backend = {natural: {
    list: () => [], used: () => [], savePreview: () => false, presented: () => false, confirm: () => false,
  }, listInboundConfirmationCandidates: () => [], recordInboundConfirmation: () => false, close() {}};
  const off = registerConfirmationBackend({id: 'qq-concurrent', open() {opened.push('qq'); return backend;}});
  const held: (() => void)[] = [];
  const barrier = () => new Promise<void>(resolve => {held.push(resolve); if (held.length === 2) for (const release of held) release();});
  const turn = (id: string) => {
    const subjectId = randomUUID();
    return withScopedConfirmationBackends({event: {channel: ACCEPTANCE_CONFIRMATION_CHANNEL, isGroup: false,
      senderIsOwner: false, accountId: subjectId, senderId: subjectId, conversationId: 'inbox:' + subjectId,
      sessionKey: `agent:acceptance-fixture:scenario:${subjectId}`, messageId: randomUUID(), timestamp: Date.now(), content: '查询'},
    providers: [{id, open() {opened.push(id); return backend;}}]}, async request => {
      await barrier();
      expect(listNaturalConfirmations(request)).toEqual([]);
    });
  };
  try {
    const pending = Promise.all([turn('a'), turn('b')]);
    expect(listNaturalConfirmations({channel: 'kurumi-qq', isGroup: false, senderId: '100001', accountId: 'default',
      conversationId: 'user:100001', sessionKey: 'agent:main:kurumi-qq:direct:100001', content: '查询'})).toEqual([]);
    await pending;
    expect(opened.sort()).toEqual(['a', 'b', 'qq']);
  } finally {off();}
});
