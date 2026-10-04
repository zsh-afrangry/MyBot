import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  buildConfirmationInstruction, parseConfirmationText, checkApprovalGrant, ensureConfirmationGateSchema,
  issueApprovalGrant, listConfirmationProposalsForInbound, registerConfirmationProposal,
  scopeFromInboundEvent, scopeFromToolContext, recordRegisteredConfirmation,
  registerConfirmationBackend, confirmationBackendIds,
  type ConfirmationBackend, type ConfirmationInboundEvent,
} from "./index.js";

const now = 1_780_000_000;
const id = "12345678-1234-4234-8234-123456789abc";
const hash = "a".repeat(64);
const scope = scopeFromToolContext({ messageChannel: "qqbot", senderIsOwner: true,
  deliveryContext: { to: "qqbot:c2c:owner", accountId: "default" }, requesterSenderId: "owner", sessionKey: "session-one" })!;
const event: ConfirmationInboundEvent = { channel: "qqbot", conversationId: "c2c:owner", accountId: "default",
  senderId: "owner", sessionKey: "session-one", messageId: "real-message", isGroup: false,
  timestamp: now, content: buildConfirmationInstruction(id, hash) };

function fixture(domain = "notes") {
  const db = new DatabaseSync(":memory:");
  ensureConfirmationGateSchema(db);
  registerConfirmationProposal(db, { proposalId: id, payloadHash: hash, domain, actionKind: "note.save",
    subjectId: "owner", scope, createdAtUtc: now - 10, expiresAtUtc: now + 100 });
  const candidates = (inbound: ConfirmationInboundEvent) => listConfirmationProposalsForInbound(db, {
    subjectId: "owner", content: inbound.content, scope: scopeFromInboundEvent(inbound)!, nowUtc: now,
  });
  const record = vi.fn((inbound: ConfirmationInboundEvent, expectedId: string) => {
    const proposal = candidates(inbound)[0];
    return proposal?.proposalId === expectedId && issueApprovalGrant(db, {
      proposal, confirmationMessageId: inbound.messageId!, scope: scopeFromInboundEvent(inbound)!, nowUtc: now,
    }).ok;
  });
  const close = vi.fn();
  const backend: ConfirmationBackend = { listInboundConfirmationCandidates: candidates, recordInboundConfirmation: record, close };
  return { db, backend, record, close };
}

describe("domain-independent confirmation governance", () => {
  it("short confirmations bind full payloads, preserve legacy format and reject bare agreement", () => {
    const f=fixture();try {
      expect(event.content).toMatch(/^确认 [a-f0-9]{12}$/u);
      expect(f.backend.listInboundConfirmationCandidates(event)).toHaveLength(1);
      expect(f.backend.listInboundConfirmationCandidates({...event,content:buildConfirmationInstruction(id,"b".repeat(64))})).toHaveLength(0);
      expect(f.backend.listInboundConfirmationCandidates({...event,content:`确认 proposalId=${id} payloadHash=${hash}`})).toHaveLength(1);
      for(const content of ['确认','好的','确认 000000000000',`${event.content} 再确认另一个`])expect(f.backend.listInboundConfirmationCandidates({...event,content})).toHaveLength(0);
    }finally{f.db.close();}
  });
  it("rejects mixed proposal identifiers and completely unbound scopes", () => {
    expect(parseConfirmationText(`${event.content} ${"b".repeat(64)}`)).toBeUndefined();
    const f = fixture();
    try {
      registerConfirmationProposal(f.db, { proposalId: id, domain: "notes", actionKind: "note.save",
        subjectId: "owner", payloadHash: hash, scope: { primary: "unbound", delivery: [] }, createdAtUtc: now - 10, expiresAtUtc: now + 100 });
      expect(listConfirmationProposalsForInbound(f.db, { subjectId: "owner", content: event.content,
        scope: { primary: "unbound", delivery: [] }, nowUtc: now })).toEqual([]);
    } finally { f.db.close(); }
  });
  it("confirms a non-weather domain and consumes a grant once", () => {
    const f = fixture();
    try {
      const report = vi.fn();
      const providers = [{ id: "notes", open: () => f.backend }];
      expect(recordRegisteredConfirmation(event, report, providers)).toBe("recorded");
      expect(recordRegisteredConfirmation(event, report, providers)).toBe("recorded");
      expect(f.db.prepare("SELECT count(*) AS n FROM approval_grants").get()).toEqual({ n: 1 });
      const check = { proposalId: id, payloadHash: hash, domain: "notes", subjectId: "owner", scope, nowUtc: now, consume: true };
      expect(checkApprovalGrant(f.db, check).ok).toBe(true);
      expect(checkApprovalGrant(f.db, check)).toMatchObject({ code: "grant_replayed" });
      expect(f.close).toHaveBeenCalledTimes(2);
    } finally { f.db.close(); }
  });
  it.each([
    { accountId: "other" }, { senderId: "stranger" }, { conversationId: "qqbot:c2c:stranger" },
    { sessionKey: "different-session" }, { accountId: undefined },
  ])("rejects identity conflict even when another alias matches: %j", change => {
    const f = fixture();
    try {
      const inbound = { ...event, ...change } as ConfirmationInboundEvent;
      expect(recordRegisteredConfirmation(inbound, vi.fn(), [{ id: "notes", open: () => f.backend }])).toBe("no_match");
      expect(f.record).not.toHaveBeenCalled();
    } finally { f.db.close(); }
  });
  it("fails closed when two databases own the same proposal", () => {
    const a = fixture("notes"), b = fixture("tasks");
    try {
      expect(recordRegisteredConfirmation(event, vi.fn(), [{ id: "notes", open: () => a.backend }, { id: "tasks", open: () => b.backend }])).toBe("ambiguous");
      expect(a.record).not.toHaveBeenCalled(); expect(b.record).not.toHaveBeenCalled();
    } finally { a.db.close(); b.db.close(); }
  });
  it("never grants a partial match when another backend fails; diagnostics contain no raw exception", () => {
    const f = fixture(), report = vi.fn();
    try {
      expect(recordRegisteredConfirmation(event, report, [{ id: "notes", open: () => f.backend }, { id: "broken", open() { throw Error("SECRET"); } }])).toBe("storage_error");
      expect(f.record).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce();
      expect(JSON.stringify(report.mock.calls)).not.toContain("SECRET");
    } finally { f.db.close(); }
  });
  it("ordinary and quoted messages do not open storage", () => {
    const open = vi.fn();
    expect(recordRegisteredConfirmation({ ...event, content: "hello" }, vi.fn(), [{ id: "notes", open }])).toBe("ignored");
    expect(recordRegisteredConfirmation({ ...event, replyToIsQuote: true }, vi.fn(), [{ id: "notes", open }])).toBe("ignored");
    expect(open).not.toHaveBeenCalled();
  });
  it("reports an absent provider and supports registration cleanup", () => {
    expect(recordRegisteredConfirmation(event, vi.fn(), [])).toBe("no_backends");
    const unregister = registerConfirmationBackend({ id: "test-notes", open() { throw Error(); } });
    try {
      expect(confirmationBackendIds()).toContain("test-notes");
      expect(() => registerConfirmationBackend({ id: "test-notes", open() { throw Error(); } })).toThrow();
    } finally { unregister(); }
    expect(confirmationBackendIds()).not.toContain("test-notes");
  });
});

describe('Fusion channel confirmation scope', () => {
  const ctx = {messageChannel:'kurumi-qq',senderIsOwner:true,requesterSenderId:'365999865',sessionKey:'agent:main:kurumi-qq:direct:365999865',deliveryContext:{to:'user:365999865',accountId:'default'}};
  it('binds exact owner sender, route and main session', () => {
    const scope = scopeFromToolContext(ctx)!;
    expect(scope.primary).toBe('session:'+ctx.sessionKey);
    expect(scopeFromInboundEvent({channel:'kurumi-qq',conversationId:'user:365999865',senderId:'365999865',sessionKey:ctx.sessionKey,accountId:'default',isGroup:false,content:'确认'})).toMatchObject({primary:scope.primary});
    for(const change of [{senderIsOwner:false},{requesterSenderId:'123456'},{sessionKey:'agent:worker:task'},{deliveryContext:{to:'group:365999865'}}])expect(scopeFromToolContext({...ctx,...change})).toBeUndefined();
  });
});

it('records and consumes a fusion confirmation through the shared backend registry', () => {
  const f=fixture();
  const sender='365999865',sessionKey='agent:main:kurumi-qq:direct:'+sender;
  const freshScope=scopeFromToolContext({messageChannel:'kurumi-qq',senderIsOwner:true,requesterSenderId:sender,sessionKey,deliveryContext:{to:'user:'+sender,accountId:'default'}})!;
  try {
    f.db.prepare('UPDATE confirmation_proposals SET scope_json=?').run(JSON.stringify(freshScope));
    const inbound={...event,channel:'kurumi-qq',senderId:sender,conversationId:'user:'+sender,sessionKey};
    expect(recordRegisteredConfirmation(inbound,()=>{},[{id:'notes',open:()=>f.backend}])).toBe('recorded');
    expect(checkApprovalGrant(f.db,{proposalId:id,payloadHash:hash,domain:'notes',subjectId:'owner',scope:freshScope,nowUtc:now,consume:true}).ok).toBe(true);
  }finally{f.db.close();}
});
