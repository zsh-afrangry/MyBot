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
      return {
        ok: true,
        status: "needs_confirmation",
        draftId: created.draftId,
        confirmationInstruction: created.instruction,
        to: input.to,
        cc: input.cc,
        subject: input.subject,
        bodyChars: String(input.text).length,
        attachments: store.getDraft(created.draftId)?.attachments ?? [],
        expiresAtUtc: created.expiresAtUtc,
        note: "Not sent. The owner must reply with the confirmation instruction before email_send can deliver it.",
      };
    },

    /**
     * Deliver a draft the owner has already approved.
     * @param {object} context `{scope, config, allowedRecipients, connector?, tlsOptions?, clientHostname?}`
     */
    async sendDraft(store, args, context) {
      const input = policy.normalizeSend(args);
      if (input.problem) return { ok: false, code: "invalid_send", reason: input.problem, sent: false };
      const { scope, config, allowedRecipients = [], connector, tlsOptions, clientHostname = "kurumi-fusion" } = context ?? {};

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

      let attachments, approval;
      try {
        attachments = (draft.attachments ?? []).length ? store.readAttachments(draft.draftId) : [];
        approval = store.consumeApproval({ draftId: draft.draftId, scope });
      } catch { return {ok: false, code: 'draft_attachment_integrity_failed', sent: false}; }
      if (!approval.ok) {
        return {
          ok: false,
          code: approval.code,
          sent: false,
          hint: "Ask the owner to reply with the confirmation instruction from email_draft, then retry.",
        };
      }

      if (!config?.configured) {
        return { ok: false, code: "not_configured", sent: false, note: "The approval was consumed; configure mail before drafting again." };
      }

      const messageId = `${randomUUID()}@kurumi-mail`;
      const message = buildMessage({
        from: { address: config.user },
        to: draft.to,
        subject: draft.subject,
        text: draft.text,
        attachments,
        messageId,
      });

      try {
        const delivery = await deliver({
          host: config.host,
          port: config.port,
          secure: true,
          credentials: { user: config.user, pass: config.authCode },
          message: { ...message, envelopeTo: [...message.envelopeTo, ...(draft.cc ?? [])] },
          connector,
          tlsOptions,
          clientHostname,
        });
        store.markSent(draft.draftId, { messageId, response: delivery.response });
        return {
          ok: true,
          sent: true,
          draftId: draft.draftId,
          messageId,
          accepted: delivery.accepted,
          rejected: delivery.rejected,
          serverResponse: delivery.response,
        };
      } catch (error) {
        store.markFailed(draft.draftId, error);
        return {
          ok: false,
          sent: false,
          code: error instanceof SmtpError ? error.code : "delivery_error",
          stage: error?.stage,
          permanent: error?.permanent === true,
          reason: String(error?.message ?? error).slice(0, 200),
          note: "The approval was consumed; create a new draft to retry.",
        };
      }
    },
  });
}
