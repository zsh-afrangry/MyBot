import {withAccess} from '../../../tests/access-control/fixtures.mjs';
// Tool-layer tests: the entry point that actually failed.
//
// The 2026-10-16 failure happened before any of the lower layers ran — the host rejected the call
// against the tool's JSON schema, so nothing here was reached and no draft existed to confirm (the
// inbound router later reported no_match because the owner was confirming a draft that had never
// been created). These cases drive the real registered tools with the exact arguments the model
// produced, which is the only layer where that bug is visible.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  captureNaturalConfirmationRequest, clearNaturalConfirmationRequest, confirmNaturalProposals,
  prepareConfirmationPreview, recordConfirmationDelivery,
} from "@kurumi/confirmation-core";
import { createMailPlugin } from "../index.js";
import { defaultConnector } from "../smtp.js";
import { MockSmtpServer, TEST_PASS, TEST_USER } from "./helpers/mock-smtp.js";
import { inboundEvent, ownerScope, RECIPIENT } from "./helpers/owner-context.js";
import { MailStore } from "../store.js";

const OWNER = "365999865";
const SESSION = `agent:main:kurumi-qq:direct:${OWNER}`;
const ALLOWED = "365999865@qq.com";

/**
 * Capture the tool definitions the plugin registers, with a minimal host surface.
 * Services are started like the host does (and cleaned up) so the confirmation backend really
 * registers; registerConfirmationBackend rejects a duplicate id, so skipping the cleanup would make
 * the second test in this file fail for the wrong reason.
 */
function harness({ allowedRecipients = [ALLOWED], stateDirectory, connector, feedbackActions, t } = {}) {
  process.env.OPENCLAW_STATE_DIR = stateDirectory;
  const tools = new Map();
  const services = [];
  const api = {
    config: withAccess({ channels: { "kurumi-qq": { ownerId: OWNER } } }),
    pluginConfig: { allowedRecipients, feedbackActions },
    logger: { info() {}, warn() {}, error() {} },
    registerService(service) { services.push(service); return () => {}; },
    registerTool(definition) {
      const tool = definition.create(ownerContext());
      tools.set(tool.name, tool);
      return () => {};
    },
  };
  createMailPlugin({connector}).register(api);
  for (const service of services) service.start();
  t?.after(async () => { for (const service of [...services].reverse()) await service.stop?.(); });
  return { tools, services, api };
}

function ownerContext(overrides = {}) {
  return {
    messageChannel: "kurumi-qq",
    deliveryContext: { channel: "kurumi-qq", to: `user:${OWNER}`, accountId: "default" },
    requesterSenderId: OWNER,
    senderIsOwner: true,
    sessionKey: SESSION,
    getRuntimeConfig: () => (withAccess({ channels: { "kurumi-qq": { ownerId: OWNER } } })),
    assertInvocationCurrent() {},
    ...overrides,
  };
}

function payload(result) {
  return JSON.parse(result.content[0].text);
}

function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-mail-tool-"));
  const state = path.join(dir, "state");
  fs.mkdirSync(state, { recursive: true });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, state };
}

test("email_draft accepts the exact arguments that failed in production", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  // Reproduced verbatim from the failed round trip: a string recipient and a "body" key.
  const result = payload(await tools.get("email_draft").execute("call-1", {
    to: "365999865@qq.com",
    subject: "测试邮件：一只小鲸鱼的自我介绍",
    body: "主人好，这是一封测试邮件。",
  }, undefined));
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.status, "needs_confirmation");
  assert.equal(result.confirmationInstruction === "确认", true);
  assert.deepEqual(result.to, ["365999865@qq.com"]);
  assert.equal(result.bodyChars, "主人好，这是一封测试邮件。".length);
});

test("email_draft answers a missing field with a fixable message instead of a schema error", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_draft").execute("call-1", { subject: "只有主题" }, undefined));
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_draft");
  assert.match(result.reason, /recipient is required/u);
  assert.equal(result.sent, false);
});

test("email_draft still refuses a recipient outside the allowlist", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_draft").execute("call-1", {
    to: "stranger@example.test", subject: "s", text: "t",
  }, undefined));
  assert.equal(result.ok, false);
  assert.equal(result.code, "recipient_not_allowed");
  assert.equal(result.sent, false);
});

test("email_outbox lists drafts when called with no arguments", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_outbox").execute("call-1", {}, undefined));
  assert.equal(result.ok, true);
  assert.equal(result.action, "list");
  assert.deepEqual(result.drafts, []);
});

test("email_outbox reports an unknown action without throwing", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_outbox").execute("call-1", { action: "flush" }, undefined));
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_action");
});

test("a non-owner context cannot use any mail tool", async (t) => {
  const { state } = workspace(t);
  const tools = new Map();
  const api = {
    config: withAccess({ channels: { "kurumi-qq": { ownerId: OWNER } } }),
    pluginConfig: { allowedRecipients: [ALLOWED] },
    registerService() { return () => {}; },
    registerTool(definition) { const tool = definition.create(ownerContext({ senderIsOwner: false })); tools.set(tool.name, tool); return () => {}; },
  };
  process.env.OPENCLAW_STATE_DIR = state;
  createMailPlugin().register(api);
  for (const name of ["email_status", "email_draft", "email_send", "email_outbox"]) {
    await assert.rejects(
      () => tools.get(name).execute("call-1", { to: "a@x.test", subject: "s", text: "t", action: "list" }, undefined),
      /owner's private chat only/u,
      `${name} must refuse a non-owner context`,
    );
  }
});

test("email_status reports the allowlist and the confirmation backend registration", async (t) => {
  const { state } = workspace(t);
  const secret = "test-authorization-code-value";
  process.env.KURUMI_MAIL_USER = "sender@example.test";
  process.env.KURUMI_MAIL_AUTH_CODE = secret;
  t.after(() => { delete process.env.KURUMI_MAIL_USER; delete process.env.KURUMI_MAIL_AUTH_CODE; });

  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_status").execute("call-1", {}, undefined));
  assert.equal(result.ok, true);
  assert.equal(result.configured, true);
  assert.deepEqual(result.allowedRecipients, [ALLOWED]);
  assert.equal(result.confirmationBackendRegistered, true, "the backend registers when the service starts");
  // The sender address is not a secret; the authorization code is, and must appear nowhere.
  assert.equal(result.sender, "sender@example.test");
  assert.equal(result.secretsExposed, false);
  assert.equal(JSON.stringify(result).includes(secret), false, "the authorization code must never be returned");
});

test("email_status explains what to configure when mail is not set up yet", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_status").execute("call-1", {}, undefined));
  assert.equal(result.ok, true);
  assert.equal(result.configured, false);
  // Naming the environment KEYS is the point of the hint; it is not a secret.
  assert.match(result.hint, /KURUMI_MAIL_USER/u);
  assert.match(result.hint, /KURUMI_MAIL_AUTH_CODE/u);
});

test("email_send accepts the exact arguments that failed in production", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const draft = payload(await tools.get("email_draft").execute("call-1", {
    to: "365999865@qq.com", subject: "往返测试", body: "正文",
  }, undefined));
  assert.equal(draft.ok, true);
  // Reproduced from the failed round trip: the model echoed the confirmation back as "approval".
  const result = payload(await tools.get("email_send").execute("call-2", {
    draftId: draft.draftId,
    approval: draft.confirmationInstruction,
  }, undefined));
  // The point is that the call now REACHES the plugin instead of being rejected by the schema; with no
  // grant recorded it must refuse to send.
  assert.equal(result.sent, false);
  assert.equal(result.code, "approval_required");
});

test("email_send explains a missing draft id instead of failing schema validation", async (t) => {
  const { state } = workspace(t);
  const { tools } = harness({ stateDirectory: state, t });
  const result = payload(await tools.get("email_send").execute("call-1", {}, undefined));
  assert.equal(result.ok, false);
  assert.equal(result.code, "invalid_send");
  assert.match(result.reason, /draftId/u);
  assert.equal(result.sent, false);
});

test("a confirmed batch keeps separate SMTP receipts, including a lost reply, without resending", async (t) => {
  const { state } = workspace(t);
  const copy = "copy@example.test";
  const ca = fs.readFileSync(new URL("./fixtures/cert.pem", import.meta.url));
  const { tools } = harness({
    t, stateDirectory: state, allowedRecipients: [RECIPIENT, copy],
    connector: options => {
      assert.equal(options.host, "127.0.0.1");
      return defaultConnector({...options, tlsOptions: {ca, servername: "localhost"}});
    },
  });
  const run = async (tool, args) => payload(await tools.get(tool).execute("feedback-fixture", args));
  const receipt = draftId => run("email_outbox", {action: "receipt", draftId});
  const cases = [
    {smtp: {rejectRecipients: [copy]}, expected: "accepted", platform: "accepted", received: 1, code: 250},
    {smtp: {rejectData: true}, expected: "failed", platform: "rejected", received: 0, code: 554},
    {smtp: {dropAfterData: true}, expected: "unknown", platform: "unknown", received: 1},
  ];
  const targets = [];
  const preview = inboundEvent({content: "准备这三封隔离测试邮件", messageId: randomUUID(), timestamp: Date.now()});
  for (const [i, row] of cases.entries()) {
    const created = await run("email_draft", {to: RECIPIENT, cc: copy, subject: `fixture ${i + 1}`, text: "private fixture body"});
    assert.equal(created.feedback.status, "created");
    const {draftId, payloadHash} = created;
    row.draftId = draftId;
    const target = {domain: "mail", proposalId: draftId, payloadHash};
    targets.push(target);
    assert.equal((await receipt(draftId)).feedback[1].status, "needs_confirmation");
    assert(prepareConfirmationPreview(preview, target, created.previewText));
    recordConfirmationDelivery({
      accountId: "default", conversationId: preview.conversationId, sourceMessageId: preview.messageId,
      messageId: randomUUID(), text: created.previewText,
    });
    row.server = new MockSmtpServer(row.smtp);
    row.address = await row.server.start();
    t.after(() => row.server.stop());
  }
  const reply = inboundEvent({content: "这三封都确认发送", messageId: randomUUID(), timestamp: Date.now()});
  captureNaturalConfirmationRequest(reply);
  t.after(() => clearNaturalConfirmationRequest(SESSION));
  assert(confirmNaturalProposals(reply, targets).ok);

  const variables = {
    KURUMI_MAIL_HOST: "127.0.0.1", KURUMI_MAIL_PORT: "", KURUMI_MAIL_USER: TEST_USER, KURUMI_MAIL_AUTH_CODE: TEST_PASS,
  };
  const original = Object.fromEntries(Object.keys(variables).map(key => [key, process.env[key]]));
  t.after(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  Object.assign(process.env, variables);
  for (const row of cases) {
    assert.equal((await receipt(row.draftId)).feedback[1].status, "confirmed");
    process.env.KURUMI_MAIL_PORT = String(row.address.port);
    const sent = await run("email_send", {draftId: row.draftId});
    assert.equal(sent.feedback.status, row.expected);
    assert.equal(sent.sent, row.expected === "unknown" ? null : row.expected === "accepted");
    row.messageId = sent.messageId;
  }
  const before = await run("email_outbox", {action: "audit"});
  for (const row of cases) {
    const first = await receipt(row.draftId);
    assert(first.ok);
    assert.equal(first.draftId, row.draftId);
    const [, smtp] = first.feedback;
    assert.equal(smtp.status, row.expected);
    assert.equal(smtp.evidence.platformStatus, row.platform);
    assert.equal(smtp.evidence.messageId, row.messageId);
    assert.equal(smtp.evidence.responseCode, row.code);
    assert.equal(smtp.evidence.clientDelivery, "unknown");
    assert.equal(smtp.evidence.readStatus, "unknown");
    assert.equal(smtp.evidence.recipientStatus, "unverified");
    if (row.expected === "accepted") {
      assert.equal(smtp.evidence.acceptedCount, 1);
      assert.equal(smtp.evidence.rejectedCount, 1);
    }
    assert(!JSON.stringify(first).includes("private fixture body"));
    assert.deepEqual(await receipt(row.draftId), first);
    process.env.KURUMI_MAIL_PORT = String(row.address.port);
    assert((await run("email_send", {draftId: row.draftId})).ok === false);
    assert.equal(row.server.receivedCount, row.received);
    assert.equal(row.server.sessions.length, 1);
  }
  assert.deepEqual(await run("email_outbox", {action: "audit"}), before);
});

test("a reserved send without a stored SMTP outcome stays unknown after reopening the outbox", async t => {
  const {state} = workspace(t);
  const {tools} = harness({t, stateDirectory: state, allowedRecipients: [RECIPIENT]});
  const store = new MailStore({stateDirectory: path.join(state, "state", "kurumi-mail"), allowedRecipients: [RECIPIENT]});
  const scope = ownerScope();
  let draftId;
  try {
    const created = store.createDraft({to: [RECIPIENT], subject: "interrupted fixture", text: "body"}, scope);
    draftId = created.draftId;
    assert(store.recordInboundConfirmation(inboundEvent({content: created.instruction}), draftId));
    assert(store.consumeApproval({draftId, scope, messageId: "interrupted@kurumi-mail"}).ok);
    assert.equal(store.cancelDraft(draftId), false);
  } finally {
    store.close();
  }
  const result = payload(await tools.get("email_outbox").execute("feedback-fixture", {action: "receipt", draftId}));
  assert.equal(result.feedback[1].status, "unknown");
  assert.equal(result.feedback[1].evidence.messageId, "interrupted@kurumi-mail");
  const repeat = payload(await tools.get("email_send").execute("feedback-fixture", {draftId}));
  assert.equal(repeat.code, "delivery_unknown");
  assert.equal(repeat.sent, null);
});

test("historical transport failures without a recorded SMTP phase stay unknown", async t => {
  const { state } = workspace(t);
  const { tools } = harness({t, stateDirectory: state, feedbackActions: ["mail.send"]});
  const created = payload(await tools.get("email_draft").execute("feedback-fixture", {to: ALLOWED, subject: "old draft", text: "fixture"}));
  assert.equal(created.feedback, undefined);
  const db = new DatabaseSync(path.join(state, "state", "kurumi-mail", "mail.sqlite"));
  try {
    db.prepare("UPDATE mail_drafts SET status = 'failed', last_error = ? WHERE draft_id = ?")
      .run("connection_closed: SMTP server closed the connection", created.draftId);
    db.prepare("INSERT INTO mail_audit (at_utc, action, draft_id, detail_json) VALUES (?, 'failed', ?, ?)")
      .run(created.createdAtUtc, created.draftId, JSON.stringify({code: "connection_closed"}));
  } finally {
    db.close();
  }
  const result = payload(await tools.get("email_outbox").execute("feedback-fixture", {action: "receipt", draftId: created.draftId}));
  assert.equal(result.feedback.length, 1);
  assert.equal(result.feedback[0].action, "mail.send");
  assert.equal(result.feedback[0].status, "unknown");
});
