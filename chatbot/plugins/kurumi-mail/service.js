import { freezeConfirmationFacts } from '@kurumi/confirmation-core';
// Application write entry for kurumi-mail.
//
// Order is the safety story and is deliberate:
//   1. policy normalises and admits the request;
//   2. the owner's approval is consumed BEFORE any network work, so a failed delivery cannot leave a
//      reusable grant behind (the owner must approve again with a fresh draft);
//   3. only then is a connection opened.
//
// Delivery is async, which is exactly why it lives here and not in the Store: the adapter registry
// requires synchronous store methods, and a Promise-returning store is rejected outright.
import { randomUUID } from "node:crypto";
import { MailPolicyError, normalizeAllowlist } from "./policy.js";
import { buildMessage } from "./mime.js";
import { deliver, SmtpError } from "./smtp.js";
import { observeFeedback } from "../../packages/feedback-core/index.js";

function recordDelivery(result, logger, write) {
  let recorded = false;
  let sentAtUtc;
  observeFeedback("mail.send", logger, () => {
    sentAtUtc = write();
    recorded = true;
  });
  return {...result, sentAtUtc, ...(!recorded && {receiptRecorded: false})};
}

/**
 * @param {import('./contracts.js').Policy} policy
 */
export function createMailService(policy, {resolveAttachment} = {}) {
  return Object.freeze({
    /**
     * Create a draft and register its confirmation proposal. Synchronous: nothing leaves the machine.
     * Refusals come back as data so a tool can report a fixable reason instead of failing the turn.
     */
    createDraft(store, args, scope, allowedRecipients = []) {
      const input = policy.normalizeDraft(args);
      if (input.problem) return { ok: false, code: "invalid_draft", reason: input.problem, sent: false };
      let created;
      try {
        const attachments = (input.attachments ?? []).map(entry => {
          if (!resolveAttachment) throw new Error("managed PDF attachments are not configured");
          let doc;
          try { doc = resolveAttachment(entry.documentId); }
          catch { throw new Error("Managed PDF is unavailable or failed integrity checks; verify its documentId."); }
          return {documentId: doc.id, filename: doc.filename, contentType: 'application/pdf', content: doc.content};
        });
        created = store.createDraft(
          { to: input.to, cc: input.cc, subject: input.subject, text: input.text, attachments },
          scope,
        );
      } catch (error) {
        if (error instanceof MailPolicyError) {
          return { ok: false, code: error.code, reason: error.message, allowedRecipients, sent: false };
        }
        return { ok: false, code: "invalid_draft", reason: String(error?.message ?? error).slice(0, 300), sent: false };
      }
      const expiresAtDisplay = {local: new Date(created.expiresAtUtc * 1000 + 8 * 3600000).toISOString().replace('Z', '+08:00'), timezone: 'Asia/Shanghai'};
      const draft = store.getDraft(created.draftId);
      const presentation = freezeConfirmationFacts([
        '状态：待确认，尚未发送', `收件人：${input.to.join(', ')}`, `抄送：${(input.cc ?? []).join(', ') || '无'}`,
        `主题：${input.subject}`, '正文：\n'+input.text,
        ...(draft?.attachments ?? []).map(a => `附件：${a.filename}（${a.bytes}字节，SHA256 ${a.sha256}）`),
        `提案确认截止：${expiresAtDisplay.local}（Asia/Shanghai）`,
      ]);
      return {
        ok: true,
        status: "needs_confirmation",
        proposalId: created.draftId,
        payloadHash: created.payloadHash,
        ...presentation,
        expiresAtDisplay,
        draftId: created.draftId,
        confirmationInstruction: "确认",
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        bodyChars: String(input.text).length,
        attachments: draft?.attachments ?? [],
        createdAtUtc: draft?.createdAtUtc,
        expiresAtUtc: created.expiresAtUtc,
        note: "Not sent. The owner must confirm this preview before personal_confirmation and email_send can deliver it.",
      };
    },

    /**
     * Deliver a draft the owner has already approved.
     * @param {object} context `{scope, config, allowedRecipients, connector?, tlsOptions?, clientHostname?}`
     */
    async sendDraft(store, args, context) {
      const input = policy.normalizeSend(args);
      if (input.problem) return { ok: false, code: "invalid_send", reason: input.problem, sent: false };
      const { scope, config, allowedRecipients = [], connector, tlsOptions, clientHostname = "kurumi-fusion", logger } = context ?? {};

      const draft = store.getDraft(input.draftId);
      if (!draft) return { ok: false, code: "unknown_draft", sent: false };

      // Re-check policy before the approval is consumed. The draft was checked when created, but the
      // allowlist can change in between; checking again costs nothing and closes that window.
      try {
        policy.assertRecipientsAllowed([...draft.to, ...(draft.cc ?? [])], normalizeAllowlist(allowedRecipients));
      } catch (error) {
        if (error instanceof MailPolicyError) return { ok: false, code: error.code, sent: false, reason: error.message };
        throw error;
      }

      if (draft.status === "unknown") {
        return {
          ok: false, sent: null, status: "unknown", code: "delivery_unknown",
          draftId: draft.draftId, messageId: draft.messageId,
          note: "The earlier SMTP result is unresolved. Query email_outbox for this draft.",
        };
      }

      const messageId = `${randomUUID()}@kurumi-mail`;
      let attachments, approval;
      try {
        attachments = (draft.attachments ?? []).length ? store.readAttachments(draft.draftId) : [];
        approval = store.consumeApproval({ draftId: draft.draftId, scope, messageId });
      } catch { return {ok: false, code: 'draft_attachment_integrity_failed', sent: false}; }
      if (!approval.ok) {
        return {
          ok: false,
          code: approval.code,
          sent: false,
          ...(approval.code === "approval_required" && {
            hint: "Show the frozen preview, wait for a later owner confirmation, then resolve it with personal_confirmation.",
          }),
        };
      }

      let delivery;
      try {
        if (!config?.configured) {
          throw new SmtpError("not_configured", "Configure mail before drafting again", {stage: "config"});
        }
        const message = buildMessage({
          from: { address: config.user },
          to: draft.to,
          subject: draft.subject,
          text: draft.text,
          attachments,
          messageId,
        });
        delivery = await deliver({
          host: config.host,
          port: config.port,
          secure: true,
          credentials: { user: config.user, pass: config.authCode },
          message: { ...message, envelopeTo: [...message.envelopeTo, ...(draft.cc ?? [])] },
          connector,
          tlsOptions,
          clientHostname,
        });
      } catch (error) {
        const unknown = error instanceof SmtpError && error.code === "delivery_unknown";
        return recordDelivery({
          ok: false,
          sent: unknown ? null : false,
          status: unknown ? "unknown" : "failed",
          draftId: draft.draftId,
          messageId,
          code: error instanceof SmtpError ? error.code : "delivery_error",
          stage: error?.stage,
          responseCode: error?.responseCode,
          permanent: error?.permanent === true,
          reason: String(error?.message ?? error).slice(0, 200),
          note: unknown
            ? "Check the receipt with email_outbox. Do not retry while the SMTP result is unknown."
            : "A new draft and owner confirmation are required for another send.",
        }, logger, () => store.markFailed(draft.draftId, error, {messageId}));
      }
      const receipt = {
        messageId, responseCode: delivery.responseCode,
        acceptedCount: delivery.accepted.length, rejectedCount: delivery.rejected.length,
      };
      return recordDelivery({
        ok: true, sent: true, status: "accepted", draftId: draft.draftId,
        ...receipt, accepted: delivery.accepted, rejected: delivery.rejected, serverResponse: delivery.response,
      }, logger, () => store.markSent(draft.draftId, {...receipt, response: delivery.response}));
    },
  });
}
