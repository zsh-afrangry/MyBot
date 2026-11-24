// Offline tool-level tests for email_inbox, dual-layer sender trust, confirmation, and attachment staging.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as core from "../../../packages/confirmation-core/dist/index.js";
import { withAccess } from "../../../tests/access-control/fixtures.mjs";
import { createMailPlugin } from "../index.js";
import { defaultImapConnector } from "../imap.js";
import { buildMessage } from "../mime.js";
import { IMAP_CERT_FILE, IMAP_TEST_PASS, IMAP_TEST_USER, MockImapServer } from "./mock-imap.js";

const OWNER = "365999865";
const SESSION = `agent:main:kurumi-qq:direct:${OWNER}`;
const ca = fs.readFileSync(IMAP_CERT_FILE);
const testConnector = opts => defaultImapConnector({ ...opts, tlsOptions: { ca, servername: "localhost" } });

function msgEvent(text, messageId, nowMs) {
  return {
    channel: "kurumi-qq",
    accountId: "default",
    senderId: OWNER,
    conversationId: `user:${OWNER}`,
    sessionKey: SESSION,
    messageId,
    content: text,
    timestamp: nowMs,
    isGroup: false,
    senderIsOwner: true,
  };
}

function setupHarness({
  t,
  imapPort,
  allowedSenders = ["bills@trusted.test"],
  permissionOverrides = {},
}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "kurumi-inbox-tool-"));
  const stateRoot = path.join(root, "state");
  const fakeHome = path.join(root, "fake-home");
  const kurumiSpace = path.join(fakeHome, "kurumi-space");
  for (const d of [stateRoot, kurumiSpace]) fs.mkdirSync(d, { recursive: true });

  const prevEnv = {
    OPENCLAW_STATE_DIR: process.env.OPENCLAW_STATE_DIR,
    KURUMI_MAIL_USER: process.env.KURUMI_MAIL_USER,
    KURUMI_MAIL_AUTH_CODE: process.env.KURUMI_MAIL_AUTH_CODE,
    KURUMI_IMAP_HOST: process.env.KURUMI_IMAP_HOST,
    KURUMI_IMAP_PORT: process.env.KURUMI_IMAP_PORT,
  };
  process.env.OPENCLAW_STATE_DIR = stateRoot;
  process.env.KURUMI_MAIL_USER = IMAP_TEST_USER;
  process.env.KURUMI_MAIL_AUTH_CODE = IMAP_TEST_PASS;
  process.env.KURUMI_IMAP_HOST = "127.0.0.1";
  process.env.KURUMI_IMAP_PORT = String(imapPort);

  const cfg = withAccess({
    channels: { "kurumi-qq": { ownerId: OWNER } },
    plugins: {
      entries: {
        "kurumi-files": {
          config: {
            homeDir: fakeHome,
            defaultWorkspace: kurumiSpace,
            t0Roots: [{ path: kurumiSpace, label: "工作区" }],
            t1Roots: [{ path: fakeHome, label: "主目录" }],
          },
        },
        "kurumi-mail": {
          config: { allowedRecipients: ["365999865@qq.com"], allowedSenders },
        },
      },
    },
  });
  Object.assign(cfg.channels["kurumi-qq"].accessControl.subjects[0].permissions, permissionOverrides);

  const tools = new Map();
  const services = [];
  const traces = [];
  createMailPlugin({ imapConnector: testConnector, stateRoot, trace: e => traces.push(e) }).register({
    config: cfg,
    pluginConfig: { allowedRecipients: ["365999865@qq.com"], allowedSenders },
    logger: { info() {}, warn() {}, error() {} },
    runtime: { state: { resolveStateDir: () => stateRoot } },
    on() {},
    registerService(svc) { services.push(svc); return () => {}; },
    registerTool(def) {
      const ctx = {
        messageChannel: "kurumi-qq",
        deliveryContext: { channel: "kurumi-qq", to: `user:${OWNER}`, accountId: "default" },
        requesterSenderId: OWNER,
        senderIsOwner: true,
        sessionKey: SESSION,
        sessionId: "sess-inbox",
        getRuntimeConfig: () => cfg,
        assertInvocationCurrent() {},
      };
      const tool = def.create(ctx);
      tools.set(tool.name, tool);
      return () => {};
    },
  });
  for (const svc of services) svc.start?.();
  t.after(async () => {
    core.clearNaturalConfirmationRequest(SESSION);
    for (const svc of [...services].reverse()) await svc.stop?.();
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const confirmAndDeliver = proposal => {
    const tPrev = Date.now();
    const pv = msgEvent("查看邮件预览", "m-p-" + proposal.proposalId.slice(0, 8), tPrev);
    assert.equal(core.prepareConfirmationPreview(pv, { domain: "mail_inbox", proposalId: proposal.proposalId, payloadHash: proposal.payloadHash }, proposal.previewText, proposal.presentationFacts), true);
    core.recordConfirmationDelivery({
      accountId: "default", conversationId: pv.conversationId, sourceMessageId: pv.messageId,
      messageId: "pv-" + proposal.proposalId, text: proposal.previewText,
    });
    const tConf = Math.max(Date.now() + 2000, tPrev + 2000);
    const cf = msgEvent("确认", "m-c-" + proposal.proposalId.slice(0, 8), tConf);
    core.captureNaturalConfirmationRequest(cf);
    const granted = core.confirmNaturalProposal(cf, { domain: "mail_inbox", proposalId: proposal.proposalId, payloadHash: proposal.payloadHash }, tConf);
    assert.equal(granted.ok, true, JSON.stringify(granted));
  };

  const exec = async (name, args) => JSON.parse((await tools.get(name).execute("c1", args)).content[0].text);
  return { root, stateRoot, kurumiSpace, cfg, traces, exec, confirmAndDeliver };
}

test("email_inbox enforces dual-layer sender trust, idempotent attachment staging, and confirmation-gated move without EXPUNGE", async t => {
  const imap = new MockImapServer();
  const addr = await imap.start();
  t.after(() => imap.stop());

  const trustedBytes = Buffer.from("PK\x03\x04TRUSTED_BILL_XLSX");
  const trustedRaw = buildMessage({
    messageId: "trusted-1@trusted.test",
    from: { name: "账单发送", address: "bills@trusted.test" },
    to: [IMAP_TEST_USER],
    subject: "11月可信账单",
    text: "TRUSTED_BODY_CONTENT",
    attachments: [{ filename: "nov-bills.xlsx", contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", content: trustedBytes }],
  }).raw;
  const uidTrusted = imap.addMessage("INBOX", { rawBuffer: trustedRaw });

  const strangerBytes = Buffer.from("STRANGER_PAYLOAD");
  const strangerBuilt = buildMessage({
    messageId: "stranger-1@unknown.test",
    from: { name: "Stranger", address: "stranger@unknown.test" },
    to: [IMAP_TEST_USER],
    subject: "陌生人账单",
    text: "INJECTED_PROMPT_TEXT",
    attachments: [{ filename: "secret-plan.xlsx", content: strangerBytes }],
  });
  const uidStranger = imap.addMessage("INBOX", { rawBuffer: strangerBuilt.raw });

  // Spoofed allowlisted sender with spf=fail MUST be downgraded to untrusted!
  const spoofedRaw = `Authentication-Results: mx.qq.com; spf=fail\r\n${trustedRaw}`;
  const uidSpoofed = imap.addMessage("INBOX", { rawBuffer: spoofedRaw });

  const h = setupHarness({ t, imapPort: addr.port });

  // Status probe checks both SMTP config presence (probe fails only on SMTP connect since SMTP isn't running) — check non-probe fields cleanly.
  const st = await h.exec("email_status", {});
  assert.equal(st.imapHost, "127.0.0.1");
  assert.equal(st.inboxConfirmationBackendRegistered, true);
  assert.deepEqual(st.allowedSenders, ["bills@trusted.test"]);

  const folders = await h.exec("email_inbox", { action: "folders" });
  assert.equal(folders.ok, true);
  assert(folders.folders.some(f => f.name === "账单归档"));

  const list = await h.exec("email_inbox", { action: "list" });
  assert.equal(list.ok, true);
  assert.equal(list.items.length, 3);
  const listedTrusted = list.items.find(x => x.uid === uidTrusted);
  const listedStranger = list.items.find(x => x.uid === uidStranger);
  const listedSpoofed = list.items.find(x => x.uid === uidSpoofed);
  assert.equal(listedTrusted.trusted, true);
  assert.equal(listedStranger.trusted, false);
  assert.equal(listedStranger.trustReason, "sender_not_in_allowlist");
  assert.equal(listedSpoofed.trusted, false);
  assert.equal(listedSpoofed.trustReason, "auth_failed_downgraded");

  // Trusted read exposes bodyText; untrusted & spf=fail read withhold bodyText & raw attachment filename!
  const rTrusted = await h.exec("email_inbox", { action: "read", uid: uidTrusted });
  assert.equal(rTrusted.trusted, true);
  assert.equal(rTrusted.bodyText, "TRUSTED_BODY_CONTENT");
  assert.equal(rTrusted.attachments[0].filename, "nov-bills.xlsx");

  const rStranger = await h.exec("email_inbox", { action: "read", uid: uidStranger });
  assert.equal(rStranger.trusted, false);
  assert.equal(rStranger.requiresAccessApproval, true);
  assert.equal(rStranger.bodyText, undefined);
  assert.equal(rStranger.attachments[0].filename, undefined);
  assert.equal(rStranger.attachments[0].extension, "xlsx");

  const rSpoofed = await h.exec("email_inbox", { action: "read", uid: uidSpoofed });
  assert.equal(rSpoofed.trusted, false);
  assert.equal(rSpoofed.trustReason, "auth_failed_downgraded");
  assert.equal(rSpoofed.bodyText, undefined);

  // Untrusted save_attachment is refused; trusted save_attachment writes cleanly to mail-attachments/<YYYY-MM-DD>/ & is idempotent.
  const deniedSave = await h.exec("email_inbox", { action: "save_attachment", uid: uidStranger });
  assert.equal(deniedSave.ok, false);
  assert.equal(deniedSave.code, "sender_not_trusted");

  const saved1 = await h.exec("email_inbox", { action: "save_attachment", uid: uidTrusted });
  assert.equal(saved1.ok, true);
  assert.equal(saved1.alreadySaved, false);
  assert(saved1.path.startsWith(path.join(h.kurumiSpace, "mail-attachments") + "/"));
  assert.deepEqual(fs.readFileSync(saved1.path), trustedBytes);
  assert.equal(fs.statSync(saved1.path).mode & 0o777, 0o600);

  const saved2 = await h.exec("email_inbox", { action: "save_attachment", uid: uidTrusted });
  assert.equal(saved2.ok, true);
  assert.equal(saved2.alreadySaved, true);
  assert.equal(saved2.path, saved1.path);

  // Per-email temporary access flow: propose_access -> confirmation -> commit_access unlocks wrapped body + attachment.
  const propAccess = await h.exec("email_inbox", {
    action: "propose_access", uid: uidStranger, allowSaveAttachment: true, partId: rStranger.attachments[0].partId,
  });
  assert.equal(propAccess.ok, true);
  assert.equal(propAccess.status, "needs_confirmation");
  assert.equal(propAccess.domain, "mail_inbox");
  assert.equal(propAccess.presentationFacts.join("\n"), propAccess.previewText);
  assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(propAccess.previewText));
  assert(!propAccess.previewText.includes("INJECTED_PROMPT_TEXT"));
  assert(!propAccess.previewText.includes("secret-plan.xlsx"));

  // Unapproved commit_access fails closed.
  const unapp = await h.exec("email_inbox", { action: "commit_access", proposalId: propAccess.proposalId });
  assert.equal(unapp.ok, false);
  assert.equal(unapp.code, "approval_required");

  h.confirmAndDeliver(propAccess);
  const committedAccess = await h.exec("email_inbox", { action: "commit_access", proposalId: propAccess.proposalId });
  assert.equal(committedAccess.ok, true, JSON.stringify(committedAccess));
  assert.match(committedAccess.bodyText, /^\[UNTRUSTED_EMAIL_CONTENT_START\]\nINJECTED_PROMPT_TEXT\n\[UNTRUSTED_EMAIL_CONTENT_END\]$/);
  assert.equal(committedAccess.savedAttachment.filename, "secret-plan.xlsx");
  assert.deepEqual(fs.readFileSync(committedAccess.savedAttachment.path), strangerBytes);

  // Manage: mark_read works directly; move requires propose_manage -> confirm -> commit_manage without EXPUNGE.
  const mr = await h.exec("email_inbox", { action: "mark_read", uid: uidTrusted });
  assert.equal(mr.ok, true);
  assert.equal(mr.seen, true);

  const propMove = await h.exec("email_inbox", { action: "propose_manage", uid: uidTrusted, op: "move", targetFolder: "账单归档" });
  assert.equal(propMove.status, "needs_confirmation");
  h.confirmAndDeliver(propMove);
  const committedMove = await h.exec("email_inbox", { action: "commit_manage", proposalId: propMove.proposalId });
  assert.equal(committedMove.ok, true);
  assert.equal(committedMove.expunged, false);
  assert.equal(imap.expungeAttempted, false);
  assert.equal(imap.getMessages("账单归档").length, 1);

  assert.equal(h.traces.some(e => e.kind === "mail.inbox.attachment_saved"), true);
  assert.equal(h.traces.some(e => e.kind === "mail.inbox.access_commit"), true);
  assert.equal(h.traces.some(e => e.kind === "mail.inbox.manage_commit"), true);
  assert(!JSON.stringify(h.traces).includes("INJECTED_PROMPT_TEXT"));
  assert(!JSON.stringify(h.traces).includes(IMAP_TEST_PASS));
});

test("commit_access unlocking attachments enforces mail.inbox.attachment before consuming grant", async t => {
  const imap = new MockImapServer();
  const addr = await imap.start();
  t.after(() => imap.stop());

  const uid = imap.addMessage("INBOX", {
    rawBuffer: buildMessage({
      messageId: "perm-check-1@unknown.test",
      from: { name: "Stranger", address: "stranger@unknown.test" },
      to: [IMAP_TEST_USER],
      subject: "附件测试",
      text: "body",
      attachments: [{ filename: "a.xlsx", content: Buffer.from("BYTES") }],
    }).raw,
  });

  const h = setupHarness({
    t,
    imapPort: addr.port,
    allowedSenders: [],
    permissionOverrides: { "mail.inbox.attachment": false },
  });
  const prop = await h.exec("email_inbox", { action: "propose_access", uid, allowSaveAttachment: true, partId: "2" });
  assert.equal(prop.status, "needs_confirmation");
  h.confirmAndDeliver(prop);

  await assert.rejects(
    () => h.exec("email_inbox", { action: "commit_access", proposalId: prop.proposalId }),
    /owner's private chat only/u,
  );
  const st = await h.exec("email_inbox", { action: "status", proposalId: prop.proposalId });
  assert.equal(st.status, "pending");
});
