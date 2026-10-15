// Draft delivery, factored out of the tool wrapper so it can be tested without a plugin context.
//
// Order matters and is deliberate:
//   1. the draft must exist and still be pending;
//   2. the owner's approval is consumed BEFORE any network work, so a delivery failure cannot leave a
//      reusable grant behind (the owner must approve again with a fresh draft);
//   3. only then is a connection opened.
//
// A failed send marks the draft failed and reports a protocol-level code. Credentials never appear in
// any returned field.
import { randomUUID } from "node:crypto";
import { buildMessage } from "./mime.js";
import { deliver, SmtpError } from "./smtp.js";

/**
 * @param {object} input
 * @param {import("./store.js").MailStore} input.store
 * @param {string} input.draftId
 * @param {{primary: string, delivery: string[]}} input.scope  owner-bound confirmation scope
 * @param {{user: string, authCode: string, host: string, port: number, configured: boolean}} input.config
 * @param {Function} [input.connector] injectable transport (tests use a local mock server)
 */
export async function sendApprovedDraft({ store, draftId, scope, config, connector, tlsOptions, clientHostname = "kurumi-fusion" }) {
  const draft = store.getDraft(draftId);
  if (!draft) return { ok: false, code: "unknown_draft", sent: false };

  const approval = store.consumeApproval({ draftId: draft.draftId, scope });
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
}
