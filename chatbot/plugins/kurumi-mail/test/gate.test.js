// End-to-end gate tests: draft → owner confirmation → delivery, against a real local SMTP server.
//
// The central claim this file exists to prove is negative: before the owner approves, the mail server
// receives nothing. Every "no message" assertion below is checked against the server's own received
// count, not against our own bookkeeping — the server is the independent witness.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MockSmtpServer, TEST_PASS, TEST_USER } from "./helpers/mock-smtp.js";
import { MailStore } from "../store.js";
import { sendApprovedDraft } from "../deliver.js";
import { defaultConnector } from "../smtp.js";
import { inboundEvent, ownerScope, RECIPIENT } from "./helpers/owner-context.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CA = fs.readFileSync(path.join(HERE, "fixtures", "cert.pem"));
const connectorTrustingTestCert = (options) =>
  defaultConnector({ ...options, tlsOptions: { ca: CA, servername: "localhost", ...(options.tlsOptions ?? {}) } });

const DRAFT = { to: [RECIPIENT], subject: "端到端测试", text: "这封邮件只有在主人确认后才会发出。" };

async function scenario(serverOptions, run) {
  const server = new MockSmtpServer(serverOptions);
  const { host, port } = await server.start();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-mail-e2e-"));
  const store = new MailStore({ stateDirectory: dir });
  const config = { user: TEST_USER, authCode: TEST_PASS, host, port, configured: true };
  try {
    await run({ server, store, config, scope: ownerScope(), dir });
  } finally {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await server.stop();
  }
}

test("nothing is delivered before the owner approves", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    const attempt = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(attempt.ok, false);
    assert.equal(attempt.code, "approval_required");
    assert.equal(attempt.sent, false);
    assert.equal(server.receivedCount, 0, "the server must not see anything without approval");
    assert.equal(store.getDraft(created.draftId).status, "pending");
  });
});

test("repeated unapproved attempts still deliver nothing", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    for (let i = 0; i < 3; i += 1) {
      const attempt = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
      assert.equal(attempt.ok, false);
      assert.equal(attempt.code, "approval_required");
    }
    assert.equal(server.receivedCount, 0);
  });
});

test("after the owner confirms, exactly one message is delivered", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    assert.equal(server.receivedCount, 0);

    // The owner replies with the instruction; the host routes it to our backend.
    assert.equal(store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId), true);

    const result = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.sent, true);
    assert.equal(server.receivedCount, 1);

    const received = server.messages[0];
    assert.equal(received.from, TEST_USER);
    assert.deepEqual(server.sessions[0].rcpt, [RECIPIENT]);
    // The body was delivered intact (base64 of the UTF-8 text).
    const body = received.data.split("\r\n\r\n").slice(1).join("\r\n\r\n");
    const base64 = body.split("\r\n").filter((line) => /^[A-Za-z0-9+/=]+$/u.test(line)).join("");
    assert.equal(Buffer.from(base64, "base64").toString("utf8").replace(/\r\n$/u, ""), DRAFT.text);
  });
});

test("a forged confirmation code approves nothing", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    // A plausible-looking but wrong short code: the parser accepts the shape, matching must reject it.
    const forged = inboundEvent({ content: "确认 000000000000" });
    assert.equal(store.recordInboundConfirmation(forged, created.draftId), false);
    const attempt = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(attempt.ok, false);
    assert.equal(server.receivedCount, 0);
  });
});

test("a confirmation arriving in a group chat approves nothing", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    const fromGroup = inboundEvent({ content: created.instruction, isGroup: true });
    assert.equal(store.recordInboundConfirmation(fromGroup, created.draftId), false);
    const attempt = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(attempt.ok, false);
    assert.equal(server.receivedCount, 0);
  });
});

test("one approval cannot send two drafts", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const first = store.createDraft(DRAFT, scope);
    const second = store.createDraft({ ...DRAFT, subject: "第二封" }, scope);
    assert.equal(store.recordInboundConfirmation(inboundEvent({ content: first.instruction }), first.draftId), true);
    const sent = await sendApprovedDraft({ store, draftId: first.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(sent.ok, true);
    const blocked = await sendApprovedDraft({ store, draftId: second.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(blocked.ok, false);
    assert.equal(blocked.code, "approval_required");
    assert.equal(server.receivedCount, 1);
  });
});

test("a delivered draft cannot be sent a second time", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId);
    const first = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(first.ok, true);
    const second = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(second.ok, false);
    assert.equal(second.code, "already_sent");
    assert.equal(server.receivedCount, 1, "no duplicate delivery");
  });
});

test("a delivery failure consumes the approval and marks the draft failed", async () => {
  await scenario({ failAuth: true }, async ({ server, store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId);
    const result = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(result.ok, false);
    assert.equal(result.code, "auth_failed");
    assert.equal(server.receivedCount, 0);

    const draft = store.getDraft(created.draftId);
    assert.equal(draft.status, "failed");
    assert.match(String(draft.lastError), /auth_failed/u);
    // The approval is gone; a retry needs a fresh draft and a fresh confirmation.
    const retry = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(retry.ok, false);
    assert.ok(["draft_not_pending", "already_sent"].includes(retry.code), `unexpected: ${retry.code}`);
  });
});

test("cc recipients are delivered to but never appear on the To: header", async () => {
  await scenario({}, async ({ server, store, config, scope }) => {
    const cc = "copy@example.test";
    const created = store.createDraft({ ...DRAFT, cc: [cc] }, scope);
    store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId);
    const result = await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    assert.equal(result.ok, true);
    assert.deepEqual(result.accepted, [RECIPIENT, cc]);
    const headers = server.messages[0].data.split("\r\n\r\n")[0];
    assert.match(headers, new RegExp(`^To: ${RECIPIENT}$`, "mu"));
    assert.doesNotMatch(headers, /copy@example\.test/u);
  });
});

test("the audit trail for a full round trip contains no credentials", async () => {
  await scenario({}, async ({ store, config, scope }) => {
    const created = store.createDraft(DRAFT, scope);
    store.recordInboundConfirmation(inboundEvent({ content: created.instruction }), created.draftId);
    await sendApprovedDraft({ store, draftId: created.draftId, scope, config, connector: connectorTrustingTestCert });
    const serialized = JSON.stringify(store.listAudit({ limit: 50 }));
    assert.ok(!serialized.includes(TEST_PASS), "authorization code must never be audited");
    assert.ok(!serialized.includes(DRAFT.text), "body text must never be audited");
    assert.ok(serialized.includes("sent"), "the successful send must be audited");
  });
});
