import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {describe, expect, it} from 'vitest';
import {
  captureNaturalConfirmationRequest, clearNaturalConfirmationRequest, checkApprovalGrant, confirmNaturalProposal, confirmNaturalProposals, MAX_CONFIRMATION_TARGETS, createNaturalConfirmationBackend, listNaturalConfirmations,
  naturalConfirmationTextAllowed, prepareConfirmationPreview, recordConfirmationDelivery,
  registerConfirmationBackend, registerConfirmationProposal, scopeFromInboundEvent,
  type ConfirmationInboundEvent, type NaturalConfirmationSelection,
} from './index.js';

function fixture(supportsBatch = true) {
  let time = Math.floor(Date.now() / 1000) * 1000;
  const db = new DatabaseSync(':memory:'), owner = '123456789';
  const event = (content = '确认', messageId: string = randomUUID()): ConfirmationInboundEvent => ({
    channel: 'kurumi-qq', senderId: owner, accountId: 'default', conversationId: `user:${owner}`,
    sessionKey: `agent:main:kurumi-qq:direct:${owner}`, messageId, content, timestamp: time, isGroup: false,
  });
  const backend = createNaturalConfirmationBackend(db, {subjectId: 'owner', domains: ['notes', 'mail'], supportsBatch, now: () => time / 1000});
  const unregister = registerConfirmationBackend({id: randomUUID(), open: () => ({natural: backend,
    listInboundConfirmationCandidates: () => [], recordInboundConfirmation: () => false, close() {}})});
  const proposal = (domain = 'notes'): NaturalConfirmationSelection => {
    const p = {domain, proposalId: randomUUID(), payloadHash: 'a'.repeat(64)};
    registerConfirmationProposal(db, {...p, actionKind: 'save', subjectId: 'owner', scope: scopeFromInboundEvent(event())!,
      createdAtUtc: time / 1000 - 20, expiresAtUtc: time / 1000 + 86400});
    return p;
  };
  const present = (p: NaturalConfirmationSelection, source = event('请生成提案'), delivered: string = randomUUID()) => {
    expect(prepareConfirmationPreview(source, p, '测试冻结预览 ' + p.proposalId)).toBe(true);
    recordConfirmationDelivery({accountId: source.accountId!, conversationId: source.conversationId!,
      sourceMessageId: source.messageId!, messageId: delivered, text: '测试冻结预览 ' + p.proposalId});
    return source;
  };
  return {db, event, proposal, present, backend, tick: (seconds: number) => {time += seconds * 1000;},
    now: () => time, close: () => {clearNaturalConfirmationRequest(event().sessionKey!); unregister(); db.close();}};
}

describe('natural confirmation with persisted previews and one-time grants', () => {
  it('requires a successfully delivered preview before bare confirmation can issue and consume one grant', () => {
    const f = fixture(); try {
      const p = f.proposal();
      expect(confirmNaturalProposal(f.event(), p, f.now())).toMatchObject({code: 'proposal_not_presented'});
      const source = f.event('请生成提案');
      expect(prepareConfirmationPreview(source, p, '冻结预览')).toBe(true);
      expect(confirmNaturalProposal(f.event(), p, f.now())).toMatchObject({code: 'proposal_not_presented'});
      recordConfirmationDelivery({accountId:'default',conversationId: source.conversationId!,sourceMessageId:source.messageId!,messageId:'delivered',text:'另一份内容'});
      expect(confirmNaturalProposal(f.event(), p, f.now()).ok).toBe(false);
      recordConfirmationDelivery({accountId:'default',conversationId: source.conversationId!,sourceMessageId:source.messageId!,messageId:'delivered',text:'冻结预览'});
      const confirm = f.event(); captureNaturalConfirmationRequest(confirm); expect(confirmNaturalProposal(confirm, p, f.now())).toEqual({ok: true, idempotent: false});
      const grant = f.db.prepare('SELECT expires_at_utc FROM approval_grants').get();
      f.tick(30); expect(confirmNaturalProposal(confirm, p, f.now())).toEqual({ok: true, idempotent: true});
      expect(f.db.prepare('SELECT expires_at_utc FROM approval_grants').get()).toEqual(grant);
      const input = {...p, subjectId:'owner',scope:scopeFromInboundEvent(confirm)!,nowUtc:f.now()/1000,consume:true};
      expect(checkApprovalGrant(f.db,input).ok).toBe(true);
      expect(checkApprovalGrant(f.db,input)).toMatchObject({code:'grant_replayed'});
    } finally {f.close();}
  });
  it('cannot confirm a proposal generated or re-previewed by the very same inbound message', () => {
    const f=fixture();try {const p=f.proposal(), e=f.event();f.present(p,e);expect(confirmNaturalProposal(e,p,f.now())).toMatchObject({code:'proposal_not_presented'});} finally {f.close();}
  });
  it('requires a reference for two previews delivered as one batch, then permits a uniquely selected target', () => {
    const f=fixture();try {
      const a=f.proposal(), b=f.proposal(), source=f.event('生成两项');f.present(a,source,'batch');f.present(b,source,'batch');
      expect(confirmNaturalProposal(f.event(),a,f.now())).toMatchObject({code:'confirmation_target_ambiguous'});
      const e=f.event('确认今晚八点那条');expect(confirmNaturalProposal(e,a,f.now()).ok).toBe(true);
      expect(confirmNaturalProposal(e,b,f.now())).toMatchObject({code:'confirmation_already_used'});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:1});
    } finally {f.close();}
  });
  it('binds bare assent to the latest preview and does not arbitrarily approve an older pending item', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal();f.present(a);f.tick(2);f.present(b);
      expect(confirmNaturalProposal(f.event(),a,f.now())).toMatchObject({code:'confirmation_target_ambiguous'});
      expect(confirmNaturalProposal(f.event(),b,f.now()).ok).toBe(true);
    }finally{f.close();}
  });
  it('uses a trusted reply target to select an older delivered preview for bare assent', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal();f.present(a,undefined,'receipt-a');f.tick(2);f.present(b,undefined,'receipt-b');
      const e={...f.event(),replyToMessageId:'receipt-a'};
      expect(confirmNaturalProposal(e,a,f.now()).ok).toBe(true);
      expect(confirmNaturalProposal({...f.event(),replyToMessageId:'unknown'},b,f.now()).ok).toBe(false);
    }finally{f.close();}
  });
  it('revokes an unconsumed natural grant when its trusted request ends', () => {
    const f=fixture();try {const p=f.proposal();f.present(p);const e=f.event();captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposal(e,p,f.now()).ok).toBe(true);
      clearNaturalConfirmationRequest(e.sessionKey!,e.messageId);
      expect(checkApprovalGrant(f.db,{...p,subjectId:'owner',scope:scopeFromInboundEvent(e)!,nowUtc:f.now()/1000,consume:true}))
        .toMatchObject({code:'confirmation_context_mismatch'});
      expect(f.db.prepare('SELECT status FROM approval_grants').get()).toEqual({status:'pending'});
    }finally{f.close();}
  });
  it('does not reuse one confirmation across different domains', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal('mail');f.present(a);f.present(b);
      const e=f.event('确认那条测试事项');expect(confirmNaturalProposal(e,a,f.now()).ok).toBe(true);
      expect(confirmNaturalProposal(e,b,f.now())).toMatchObject({code:'confirmation_already_used'});
    }finally{f.close();}
  });
  it('rejects stale/future, quoted, group, different account and fabricated session evidence', () => {
    const f=fixture();try {const p=f.proposal();f.present(p);const e=f.event();
      for(const patch of [{timestamp:f.now()-300001},{timestamp:f.now()+30001},{replyToIsQuote:true},{isGroup:true},
        {accountId:'other'},{senderId:'987654321'},{sessionKey:'fabricated'}]) {
        expect(confirmNaturalProposal({...e,...patch},p,f.now()).ok).toBe(false);
      }
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:0});
    }finally{f.close();}
  });
  it('rejects payload changes, cancelled and expired proposals and excludes them from candidates', () => {
    const f=fixture();try {const p=f.proposal();f.present(p);
      expect(confirmNaturalProposal(f.event(),{...p,payloadHash:'b'.repeat(64)},f.now()).ok).toBe(false);
      f.db.prepare("UPDATE confirmation_proposals SET status='cancelled' WHERE proposal_id=?").run(p.proposalId);
      expect(listNaturalConfirmations(f.event())).toEqual([]);
      const q=f.proposal();f.present(q);f.tick(86401);
      expect(confirmNaturalProposal(f.event(),q,f.now()).ok).toBe(false);
    }finally{f.close();}
  });
  it('rejects duplicate proposal ownership across backends without issuing either grant', () => {
    const f=fixture();let off: (()=>void)|undefined;try {const p=f.proposal();f.present(p);
      off=registerConfirmationBackend({id:randomUUID(),open:()=>({natural:f.backend,
        listInboundConfirmationCandidates:()=>[],recordInboundConfirmation:()=>false,close(){}})});
      expect(confirmNaturalProposal(f.event(),p,f.now())).toMatchObject({code:'confirmation_target_ambiguous'});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:0});
    }finally{off?.();f.close();}
  });
  it('caps grant expiry at proposal expiry and can re-read presentation proof from persistence', () => {
    const f=fixture();try {const p=f.proposal();f.present(p);
      const reopened=createNaturalConfirmationBackend(f.db,{subjectId:'owner',domains:['notes'],now:()=>f.now()/1000});
      expect(reopened.list(f.event())[0]?.presentationMessageId).toBeTruthy();
      f.db.prepare('UPDATE confirmation_proposals SET expires_at_utc=? WHERE proposal_id=?').run(f.now()/1000+60,p.proposalId);
      expect(confirmNaturalProposal(f.event(),p,f.now()).ok).toBe(true);
      expect(f.db.prepare('SELECT expires_at_utc FROM approval_grants').get()).toEqual({expires_at_utc:f.now()/1000+60});
    }finally{f.close();}
  });
});

it.each(['不用确认了','我不确认','不要发送','他说：“确认”','“确认”','如果我说确认','确认是什么意思？',
  '确认，不过改成九点','确认，改成九点','确认，但先换成九点'])('does not authorize negation, quotation, discussion or changed parameters: %s', text=>{
  expect(naturalConfirmationTextAllowed(text)).toBe(false);
});
it.each(['确认','确认今晚八点那条','今晚八点那条确认','就按刚才那个提醒办','可以发送','确认取消那条提醒'])('accepts explicit natural assent: %s',text=>{
  expect(naturalConfirmationTextAllowed(text)).toBe(true);
});

describe('explicit bounded multi-target natural confirmation', () => {
  it('authorizes two targets from the original Q10 sentence in the same message, without approving a third', () => {
    const f=fixture();try {
      const a=f.proposal(),b=f.proposal('mail'),c=f.proposal();for(const p of[a,b,c])f.present(p);
      const e=f.event('这两个都确认。');captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({ok:true,status:'authorized',results:[{...a,ok:true},{...b,ok:true}]});
      expect(confirmNaturalProposals(e,[b,a],f.now())).toMatchObject({ok:true,results:[{idempotent:true},{idempotent:true}]});
      captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,b,c],f.now())).toMatchObject({code:'confirmation_targets_locked'});
      expect(confirmNaturalProposal(e,c,f.now())).toMatchObject({code:'confirmation_already_used'});
      const grants=f.db.prepare('SELECT confirmation_message_id,proposal_id FROM approval_grants').all();
      expect(grants).toHaveLength(2);expect(grants.every(g=>g.confirmation_message_id===e.messageId)).toBe(true);
      for(const p of[a,b])expect(checkApprovalGrant(f.db,{...p,subjectId:'owner',scope:scopeFromInboundEvent(e)!,nowUtc:f.now()/1000,consume:true}).ok).toBe(true);
      expect(checkApprovalGrant(f.db,{...c,subjectId:'owner',scope:scopeFromInboundEvent(e)!,nowUtc:f.now()/1000,consume:true}).ok).toBe(false);
    }finally{f.close();}
  });
  it('does not extend a single-target approval into a batch in the same message', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal();f.present(a);f.present(b);const e=f.event('确认测试甲');captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposal(e,a,f.now()).ok).toBe(true);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({code:'confirmation_targets_locked'});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:1});
    }finally{f.close();}
  });
  it('reports a cancelled target separately and never replaces it or silently rolls back an authorized target', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal(),c=f.proposal();for(const p of[a,b,c])f.present(p);
      f.db.prepare("UPDATE confirmation_proposals SET status='cancelled' WHERE proposal_id=?").run(b.proposalId);
      const e=f.event('这两个都确认');captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({ok:false,status:'partial',results:[{ok:true},{ok:false,code:'proposal_unavailable'}]});
      expect(confirmNaturalProposals(e,[a,c],f.now())).toMatchObject({code:'confirmation_targets_locked'});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:1});
    }finally{f.close();}
  });
  it('leaves domains that did not opt into multi-target confirmation at their single-target boundary', () => {
    const f=fixture(false);try {const a=f.proposal(),b=f.proposal();f.present(a);f.present(b);const e=f.event('这两个都确认');captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({ok:false,results:[{code:'confirmation_batch_unsupported'},{code:'confirmation_batch_unsupported'}]});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:0});
    }finally{f.close();}
  });
  it('reports a storage exception after issuing a grant as unknown instead of retrying it', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal();f.present(a);f.present(b);const original=f.backend.confirm;
      f.backend.confirm=(event,p)=>{const result=original(event,p);if(p.proposalId===b.proposalId)throw Error('after commit');return result;};
      const e=f.event('这两个都确认');captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({ok:false,status:'partial',results:[{ok:true},{ok:false,code:'confirmation_outcome_unknown'}]});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:2});
    }finally{f.close();}
  });
  it('rejects bare ambiguity, duplicates, excessive targets and missing host capture before issuing grants', () => {
    const f=fixture();try {const a=f.proposal(),b=f.proposal();f.present(a);f.present(b);let e=f.event();captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({code:'confirmation_target_ambiguous'});
      e=f.event('这两个都确认');captureNaturalConfirmationRequest(e);
      expect(confirmNaturalProposals(e,[a,a],f.now())).toMatchObject({code:'confirmation_invalid_targets'});
      expect(confirmNaturalProposals(e,Array.from({length:MAX_CONFIRMATION_TARGETS+1},()=>f.proposal()),f.now())).toMatchObject({code:'confirmation_invalid_targets'});
      clearNaturalConfirmationRequest(e.sessionKey!);
      expect(confirmNaturalProposals(e,[a,b],f.now())).toMatchObject({code:'confirmation_targets_locked'});
      expect(f.db.prepare('SELECT COUNT(*) n FROM approval_grants').get()).toEqual({n:0});
    }finally{f.close();}
  });
});
it.each(['只确认刚才两项中的第二项，第一项先不要动。','这两个都确认。'])('accepts the original explicit Q09/Q10 sentence: %s',text=>expect(naturalConfirmationTextAllowed(text)).toBe(true));
it.each(['好的，知道了，先放着','我想问确认的意思','那如果我说确认呢','帮我转述他说确认'])('does not authorize feedback or discussion: %s',text=>expect(naturalConfirmationTextAllowed(text)).toBe(false));

it('uses the newest grant when two different current messages confirm the same proposal within one second',()=>{
 const f=fixture();try {const p=f.proposal();f.present(p);
  const old=f.event('确认');captureNaturalConfirmationRequest(old);expect(confirmNaturalProposal(old,p,f.now()).ok).toBe(true);
  const current=f.event('确认');captureNaturalConfirmationRequest(current);expect(confirmNaturalProposal(current,p,f.now()).ok).toBe(true);
  expect(checkApprovalGrant(f.db,{...p,subjectId:'owner',scope:scopeFromInboundEvent(current)!,nowUtc:f.now()/1000,consume:true}).ok).toBe(true);
  expect(f.db.prepare("SELECT confirmation_message_id FROM approval_grants WHERE status='consumed'").get()).toEqual({confirmation_message_id:current.messageId});
 }finally{f.close();}
});

it('orders separate preview batches and re-presentation within the same UTC second',()=>{
 const f=fixture();try {const a=f.proposal(),b=f.proposal();f.present(a);f.present(b);
  expect(confirmNaturalProposal(f.event(),a,f.now())).toMatchObject({code:'confirmation_target_ambiguous'});
  expect(confirmNaturalProposal(f.event(),b,f.now()).ok).toBe(true);
  f.present(a); // no tick: previously presented_at_utc tied B and wrongly caused ambiguity
  expect(confirmNaturalProposal(f.event(),a,f.now()).ok).toBe(true);
 }finally{f.close();}
});
it('adds presentation order to legacy preview tables without losing stored evidence',()=>{
 const db=new DatabaseSync(':memory:');try {
  db.exec(`CREATE TABLE confirmation_previews(proposal_id TEXT PRIMARY KEY,payload_hash TEXT NOT NULL,preview_text TEXT NOT NULL,source_message_id TEXT NOT NULL,presented_at_utc INTEGER,presentation_message_id TEXT) STRICT;
   INSERT INTO confirmation_previews VALUES('legacy','${'a'.repeat(64)}','legacy frozen preview','source',100,'receipt');`);
  createNaturalConfirmationBackend(db,{subjectId:'owner',domains:['notes']});
  createNaturalConfirmationBackend(db,{subjectId:'owner',domains:['notes']}); // idempotent migration
  expect(db.prepare('SELECT preview_text,presented_at_utc,presentation_message_id,presentation_order FROM confirmation_previews').get())
   .toEqual({preview_text:'legacy frozen preview',presented_at_utc:100,presentation_message_id:'receipt',presentation_order:null});
 }finally{db.close();}
});
