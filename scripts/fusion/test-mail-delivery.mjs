// Authorized real delivery acceptance for kurumi-mail. SENDS A REAL EMAIL.
//
// Run only with the owner's explicit approval, and only to an address on the plugin's allowlist.
// The authorization code is read from the runtime environment and is never printed.
//
// What this proves: the real SMTP path (implicit TLS to the configured host, AUTH with the real
// authorization code, MAIL FROM / RCPT TO / DATA) works with the real account, and the delivery is
// recorded in the real draft/audit store.
//
// What this does NOT prove, and must not be reported as proven:
//   * that the message reached the owner's inbox — only the owner can confirm that;
//   * the QQ round trip. This script records the confirmation by calling the same store method the
//     host's inbound router calls (recordInboundConfirmation). The router itself is exercised only
//     when the owner replies with the confirmation code in QQ, because kurumi-qq.testInbound is
//     registered only when channels.kurumi-qq.testIngress is true, and that stays off.
//
// Usage:
//   node scripts/fusion/test-mail-delivery.mjs --to 365999865@qq.com
//   node scripts/fusion/test-mail-delivery.mjs --to a@b.test --state-dir /tmp/mail-acceptance
//   node scripts/fusion/test-mail-delivery.mjs --to 365999865@qq.com --dry-run   # no send, no approval
import fs from "node:fs";
import path from "node:path";
import {createMailApplication} from "../../chatbot/plugins/kurumi-mail/application.js";
import {scopeFromInboundEvent, scopeFromToolContext} from "../../chatbot/plugins/kurumi-mail/scope.js";

const STATE = "/home/afrangry/.openclaw-fusion";

function arg(name, fallback) {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 && process.argv[index + 1] ? process.argv[index + 1] : fallback;
}

const ownerId = (() => {
  const config = JSON.parse(fs.readFileSync(path.join(STATE, "openclaw.json"), "utf8"));
  return String(config.channels["kurumi-qq"].ownerId);
})();

const env = JSON.parse(fs.readFileSync(path.join(STATE, "runtime-env.json"), "utf8"));
const config = {
  user: env.KURUMI_MAIL_USER?.trim() ?? "",
  authCode: env.KURUMI_MAIL_AUTH_CODE?.trim() ?? "",
  host: env.KURUMI_MAIL_HOST?.trim() || "smtp.qq.com",
  port: Number(env.KURUMI_MAIL_PORT ?? 465),
  configured: Boolean(env.KURUMI_MAIL_USER && env.KURUMI_MAIL_AUTH_CODE),
};
const allowedRecipients = JSON.parse(fs.readFileSync(path.join(STATE, "openclaw.json"), "utf8"))
  .plugins?.entries?.["kurumi-mail"]?.config?.allowedRecipients ?? [];

const dryRun = process.argv.includes("--dry-run");
const to = arg("to", allowedRecipients[0]);
const stateDirectory = arg("state-dir", path.join(STATE, "state", "kurumi-mail"));
const stamp = new Date().toISOString();

const report = {
  boundary: "Real SMTP delivery with the real authorization code. The confirmation was recorded "
    + "programmatically via the same store call the host router makes, not by a QQ message; inbound "
    + "routing and inbox arrival are not covered here.",
  startedAt: stamp,
  sender: config.user,
  recipient: to,
  allowedRecipients,
  stateDirectory,
};

if (!config.configured) {
  console.error("mail is not configured: KURUMI_MAIL_USER / KURUMI_MAIL_AUTH_CODE are missing");
  process.exit(2);
}
if (!to) {
  console.error("no recipient: pass --to or configure allowedRecipients");
  process.exit(2);
}
if (!allowedRecipients.includes(to)) {
  console.error(`recipient ${to} is not on the allowlist (${allowedRecipients.join(", ") || "empty"})`);
  process.exit(2);
}

const sessionKey = `agent:main:kurumi-qq:direct:${ownerId}`;
const toolContext = {
  messageChannel: "kurumi-qq",
  deliveryContext: {channel: "kurumi-qq", to: `user:${ownerId}`, accountId: "default"},
  requesterSenderId: ownerId,
  senderIsOwner: true,
  sessionKey,
};
const scope = scopeFromToolContext(toolContext);
if (!scope) {
  console.error("could not build an owner confirmation scope");
  process.exit(2);
}

const application = createMailApplication();
const store = application.openStore({stateDirectory, allowedRecipients});
try {
  const created = store.createDraft({
    to: [to],
    subject: "Kurumi 邮件能力验收测试",
    text: `这是一封来自 Kurumi 融合助手的真实投递验收邮件。\n\n发送时间：${stamp}\n发件账号：${config.user}\n\n`
      + "它由 scripts/fusion/test-mail-delivery.mjs 在主人授权后发出，用于验证 SMTP 链路（TLS 握手、"
      + "授权码认证、投递）在真实账号上可用。收到即说明链路打通。",
  }, scope);
  report.draftId = created.draftId;
  report.dryRun = dryRun;
  if (dryRun) {
    // Stops before any approval exists and before the network is touched.
    report.ok = true;
    report.sent = false;
    report.note = "dry run: draft created, nothing approved, nothing sent";
    console.log(JSON.stringify(report, null, 2));
    store.close();
    process.exit(0);
  }
  report.confirmationMode = "recorded-programmatically";

  // Same call the host's inbound router performs when the owner replies with the confirmation code.
  const event = {
    channel: "kurumi-qq",
    accountId: "default",
    conversationId: `user:${ownerId}`,
    senderId: ownerId,
    sessionKey,
    messageId: `acceptance-${Date.now()}`,
    content: created.instruction,
    isGroup: false,
    senderIsOwner: true,
  };
  report.scopeResolved = Boolean(scopeFromInboundEvent(event));
  report.confirmationRecorded = store.recordInboundConfirmation(event, created.draftId);

  const outcome = await application.directives.sendDraft(store, {draftId: created.draftId}, {
    scope, config, allowedRecipients,
  });
  Object.assign(report, {
    ok: outcome.ok,
    sent: outcome.sent === true,
    code: outcome.code,
    accepted: outcome.accepted,
    rejected: outcome.rejected,
    serverResponse: outcome.serverResponse,
    reason: outcome.reason,
    messageId: outcome.messageId,
  });
  report.draftStatusAfter = store.getDraft(created.draftId)?.status;
  report.audit = store.listAudit({limit: 10}).map((entry) => ({action: entry.action, draftId: entry.draftId, detail: entry.detail}));
} finally {
  store.close();
}

// Never print credentials: the report is built from outcome fields only.
console.log(JSON.stringify(report, null, 2));
process.exit(report.ok ? 0 : 1);
