// Draft, approval and audit tests.
//
// These exercise the gate through the same helpers the host uses, so a change in confirmation-core's
// binding rules (scope, hash, TTL) shows up here rather than in production.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  MailPolicyError,
  MailStore,
  assertRecipientsAllowed,
  draftPayloadHash,
  normalizeAllowlist,
  recipientsNotAllowed,
} from "../store.js";
import { inboundEvent, ownerScope, OWNER_EMAIL, RECIPIENT } from "./helpers/owner-context.js";

/**
 * Each test gets its own state directory and a controllable clock.
 * The allowlist is fail-closed, so tests must opt recipients in explicitly.
 */
function withStore(run, { startUtc = 1_800_000_000, allowedRecipients = [RECIPIENT] } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-mail-"));
  let now = startUtc;
  const store = new MailStore({ stateDirectory: dir, now: () => now, allowedRecipients });
  try {
    return run({ store, dir, advance: (seconds) => { now += seconds; }, at: () => now });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const DRAFT = { to: [RECIPIENT], subject: "测试邮件", text: "这是一封测试邮件的正文。" };

test("a draft registers a pending proposal and returns the confirmation instruction", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    assert.equal(created.instruction.startsWith("确认 "), true);
    assert.equal(created.instruction.length, "确认 ".length + 12);
    const draft = store.getDraft(created.draftId);
    assert.equal(draft.status, "pending");
    assert.deepEqual(draft.to, [RECIPIENT]);
    assert.equal(draft.subject, "测试邮件");
    // The proposal is visible to the inbound router before any approval exists.
    const candidates = store.listInboundConfirmationCandidates(inboundEvent({ content: created.instruction }));
    assert.equal(candidates.length, 1);
    assert.equal(candidates[0].proposalId, created.draftId);
  });
});

test("payload hashes are deterministic per content and change with any field", () => {
  const base = draftPayloadHash(DRAFT);
  assert.equal(base, draftPayloadHash({ ...DRAFT }));
  assert.notEqual(base, draftPayloadHash({ ...DRAFT, subject: "别的主题" }));
  assert.notEqual(base, draftPayloadHash({ ...DRAFT, text: "别的正文" }));
  assert.notEqual(base, draftPayloadHash({ ...DRAFT, to: ["other@example.test"] }));
  assert.notEqual(base, draftPayloadHash({ ...DRAFT, attachments: [{ filename: "a.txt", content: "x" }] }));
  // Recipient order is not content.
  assert.equal(
    draftPayloadHash({ ...DRAFT, to: ["a@example.test", "b@example.test"] }),
    draftPayloadHash({ ...DRAFT, to: ["b@example.test", "a@example.test"] }),
  );
});

test("without the owner's approval, sending is refused", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    const check = store.consumeApproval({ draftId: created.draftId, scope });
    assert.equal(check.ok, false);
    assert.equal(check.code, "approval_required");
    assert.equal(store.getDraft(created.draftId).status, "pending");
  });
});

test("the owner's confirmation reply issues exactly one usable grant", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    const event = inboundEvent({ content: created.instruction });
    assert.equal(store.recordInboundConfirmation(event, created.draftId), true);
    const first = store.consumeApproval({ draftId: created.draftId, scope });
    assert.equal(first.ok, true);
    const second = store.consumeApproval({ draftId: created.draftId, scope });
    assert.equal(second.ok, false);
    assert.ok(["grant_replayed", "grant_expired", "approval_required"].includes(second.code), `unexpected: ${second.code}`);
  });
});

test("repeating the same confirmation message is idempotent and does not duplicate grants", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    const event = inboundEvent({ content: created.instruction, messageId: "same-message" });
    assert.equal(store.recordInboundConfirmation(event, created.draftId), true);
    assert.equal(store.recordInboundConfirmation(event, created.draftId), true);
    // The database is the authority on how many grants exist: the same inbound message must not mint
    // a second one. (Counting audit rows would only prove we logged twice.)
    const db = new DatabaseSync(store.file, { readOnly: true });
    try {
      const row = db.prepare("SELECT COUNT(*) AS n FROM approval_grants WHERE proposal_id = ?").get(created.draftId);
      assert.equal(Number(row.n), 1, "the same message must not issue a second grant");
    } finally {
      db.close();
    }
    const approvals = store.listAudit({ limit: 20 }).filter((entry) => entry.action === "approved");
    assert.equal(approvals.length, 2, "both attempts are audited");
    assert.equal(approvals[0].detail.idempotent, true, "the repeat is recorded as idempotent");
    assert.equal(store.consumeApproval({ draftId: created.draftId, scope }).ok, true);
  });
});

test("a confirmation for another proposal does not approve this one", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const first = store.createDraft(DRAFT, scope);
    const second = store.createDraft({ ...DRAFT, subject: "第二封" }, scope);
    // Confirm the first draft, then try to use its approval for the second.
    assert.equal(store.recordInboundConfirmation(inboundEvent({ content: first.instruction }), first.draftId), true);
    const check = store.consumeApproval({ draftId: second.draftId, scope });
    assert.equal(check.ok, false);
  });
});

test("a bare 确认 with no code approves nothing", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    const event = inboundEvent({ content: "确认" });
    assert.equal(store.listInboundConfirmationCandidates(event).length, 0);
    assert.equal(store.recordInboundConfirmation(event, created.draftId), false);
    assert.equal(store.consumeApproval({ draftId: created.draftId, scope }).ok, false);
  });
});

test("a group-chat or non-owner inbound event cannot approve", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    assert.equal(store.recordInboundConfirmation(inboundEvent({ content: created.instruction, isGroup: true }), created.draftId), false);
    assert.equal(
      store.recordInboundConfirmation(inboundEvent({ content: created.instruction, senderId: "999999999", conversationId: "user:999999999" }), created.draftId),
      false,
    );
    assert.equal(store.consumeApproval({ draftId: created.draftId, scope }).ok, false);
  });
});

test("an approval obtained in another conversation cannot be used here", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    assert.equal(store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId), true);
    const foreignScope = { primary: "session:agent:main:kurumi-qq:direct:111111111", delivery: ["target:user:111111111"] };
    assert.equal(store.consumeApproval({ draftId: created.draftId, scope: foreignScope }).ok, false);
  });
});

test("an expired draft cannot be approved into a send", () => {
  withStore(({ store, advance, at }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    advance(25 * 60 * 60); // drafts live 24h
    assert.ok(at() > created.expiresAtUtc);
    assert.equal(store.recordInboundConfirmation(inboundEvent({ content: created.instruction, timestamp: at() }), created.draftId), false);
    const check = store.consumeApproval({ draftId: created.draftId, scope });
    assert.equal(check.ok, false);
    assert.equal(check.code, "draft_expired");
  });
});

test("a sent draft cannot be approved or sent again", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId);
    assert.equal(store.consumeApproval({ draftId: created.draftId, scope }).ok, true);
    store.markSent(created.draftId, { messageId: "m1", response: "queued" });
    const again = store.consumeApproval({ draftId: created.draftId, scope });
    assert.equal(again.ok, false);
    assert.equal(again.code, "already_sent");
  });
});

test("draft input is validated: recipients, subject, body, attachments", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const cases = [
      [{ ...DRAFT, to: [] }, /at least one recipient/u],
      [{ ...DRAFT, to: ["not-an-address"] }, /invalid recipient/u],
      [{ ...DRAFT, to: ["a@b"] }, /invalid recipient/u],
      [{ ...DRAFT, subject: "  " }, /subject is required/u],
      [{ ...DRAFT, subject: "x".repeat(301) }, /at most 300/u],
      [{ ...DRAFT, subject: "a\r\nBcc: evil@example.test" }, /must not contain/u],
      [{ ...DRAFT, text: "   " }, /body text is required/u],
      [{ ...DRAFT, attachments: [{ filename: "empty.txt", content: "" }] }, /is empty/u],
      [{ ...DRAFT, attachments: [{ filename: "", content: "x" }] }, /safe filename/u],
      [{ ...DRAFT, to: Array.from({ length: 21 }, (_, i) => `user${i}@example.test`) }, /at most 20 recipients/u],
    ];
    for (const [input, expected] of cases) assert.throws(() => store.createDraft(input, scope), expected);
    // A missing scope is a hard failure: no unbound drafts.
    assert.throws(() => store.createDraft(DRAFT, undefined), /confirmation scope is required/u);
  });
});

test("the audit trail records actions and never contains credentials or body text", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId);
    store.markFailed(created.draftId, { code: "auth_failed", message: "authentication failed (535)" });
    const entries = store.listAudit({ limit: 20 });
    const actions = entries.map((entry) => entry.action);
    assert.ok(actions.includes("draft_created"));
    assert.ok(actions.includes("approved"));
    assert.ok(actions.includes("failed"));
    const serialized = JSON.stringify(entries);
    assert.ok(!serialized.includes(DRAFT.text), "body text must not be audited");
    assert.ok(!serialized.includes(OWNER_EMAIL), "owner address must not be audited");
  });
});

test("cancelling a pending draft is recorded and stops approval", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const created = store.createDraft(DRAFT, scope);
    assert.equal(store.cancelDraft(created.draftId), true);
    assert.equal(store.cancelDraft(created.draftId), false, "cancelling twice changes nothing");
    const check = store.consumeApproval({ draftId: created.draftId, scope });
    assert.equal(check.ok, false);
    assert.equal(check.code, "draft_not_pending");
  });
});

test("an unknown draft id is refused without touching other state", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    assert.equal(store.getDraft("11111111-2222-3333-4444-555555555555"), undefined);
    const check = store.consumeApproval({ draftId: "11111111-2222-3333-4444-555555555555", scope });
    assert.equal(check.ok, false);
    assert.equal(check.code, "unknown_draft");
  });
});

test("the allowlist admits listed recipients and refuses everyone else", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const ok = store.createDraft(DRAFT, scope);
    assert.equal(store.getDraft(ok.draftId).status, "pending");

    assert.throws(
      () => store.createDraft({ ...DRAFT, to: ["stranger@example.test"] }, scope),
      (error) => {
        assert.ok(error instanceof MailPolicyError);
        assert.equal(error.code, "recipient_not_allowed");
        assert.match(error.message, /stranger@example\.test/u);
        assert.match(error.message, new RegExp(RECIPIENT.replace(".", "\\."), "u"), "the refusal names what is allowed");
        return true;
      },
    );
  });
});

test("a refused draft leaves nothing behind to approve", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    assert.throws(() => store.createDraft({ ...DRAFT, to: ["stranger@example.test"] }, scope), MailPolicyError);
    // No draft row, no proposal: there is nothing the owner could accidentally confirm.
    assert.equal(store.listDrafts({ limit: 10 }).length, 0);
    assert.equal(store.listInboundConfirmationCandidates(inboundEvent({ content: "确认 000000000000" })).length, 0);
  });
});

test("cc recipients are subject to the same allowlist", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    assert.throws(
      () => store.createDraft({ ...DRAFT, cc: ["stranger@example.test"] }, scope),
      (error) => error instanceof MailPolicyError && error.code === "recipient_not_allowed",
    );
  });
});

test("an empty allowlist closes the capability instead of silently allowing everything", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    assert.throws(
      () => store.createDraft(DRAFT, scope),
      (error) => {
        assert.ok(error instanceof MailPolicyError);
        assert.equal(error.code, "allowlist_empty");
        assert.match(error.message, /plugins\.entries\.kurumi-mail\.config\.allowedRecipients/u);
        return true;
      },
    );
  }, { allowedRecipients: [] });
});

test("allowlist matching ignores case and surrounding whitespace", () => {
  withStore(({ store }) => {
    const scope = ownerScope();
    const mixed = RECIPIENT.toUpperCase();
    const created = store.createDraft({ ...DRAFT, to: [`  ${mixed}  `] }, scope);
    assert.equal(store.getDraft(created.draftId).to[0], mixed);
  }, { allowedRecipients: [RECIPIENT] });
});

test("allowlist helpers normalise and compare as documented", () => {
  assert.deepEqual(normalizeAllowlist([" B@x.test ", "a@x.test", "a@x.test", "", null]), ["a@x.test", "b@x.test"]);
  assert.deepEqual(normalizeAllowlist(undefined), []);
  assert.deepEqual(recipientsNotAllowed(["A@X.test", "c@x.test"], ["a@x.test"]), ["c@x.test"]);
  assert.throws(() => assertRecipientsAllowed(["a@x.test"], []), MailPolicyError);
  assert.doesNotThrow(() => assertRecipientsAllowed(["A@X.test"], ["a@x.test"]));
});
