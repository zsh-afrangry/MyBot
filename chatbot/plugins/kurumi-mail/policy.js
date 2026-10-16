// Input policy for kurumi-mail: what the owner is allowed to send, and how a tool call's arguments
// are normalised before they reach storage.
//
// Two lessons are encoded here, both from a real failed round trip (2026-10-16):
//
//   * A schema rejection is a hard failure for the model: it never reaches this code, it only gets
//     "Invalid arguments" back. Recovering costs a whole turn, and a model that retries a few times
//     can end up emitting a malformed tool call and failing the run outright. So the JSON schema is
//     deliberately permissive about *shape* (a single recipient may be a string) and this module
//     returns structured, actionable errors for everything else.
//   * Models name a message body "body" at least as often as "text". Accepting the synonym costs one
//     line and saves a failed turn.
//
// The recipient allowlist lives here too: it is a policy decision, not storage.
import { isValidAddress } from "./mime.js";

/**
 * A policy refusal the owner can act on. Separate from validation errors so tools can report a
 * machine-readable code instead of a bare message.
 */
export class MailPolicyError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "MailPolicyError";
    this.code = code;
  }
}

/** Normalise a configured allowlist: trimmed, lowercased, de-duplicated, sorted. */
export function normalizeAllowlist(value) {
  const list = Array.isArray(value) ? value : [];
  return [...new Set(list.map((entry) => String(entry ?? "").trim().toLowerCase()).filter(Boolean))].sort();
}

/** Recipients (to + cc) that the allowlist does not cover. */
export function recipientsNotAllowed(recipients, allowlist) {
  const allowed = new Set(allowlist);
  return recipients.map((entry) => String(entry).trim().toLowerCase()).filter((entry) => !allowed.has(entry));
}

/**
 * Enforce the recipient allowlist.
 *
 * Fail-closed by design: an empty allowlist permits nothing. A missing allowlist that silently
 * allowed everything would be the worst outcome — the protection would look present while doing
 * nothing. The message therefore names the config path so a refusal is self-explanatory.
 */
export function assertRecipientsAllowed(recipients, allowlist) {
  if (allowlist.length === 0) {
    throw new MailPolicyError(
      "allowlist_empty",
      "recipient allowlist is empty, so no recipient is permitted; add addresses to plugins.entries.kurumi-mail.config.allowedRecipients",
    );
  }
  const blocked = recipientsNotAllowed(recipients, allowlist);
  if (blocked.length > 0) {
    throw new MailPolicyError(
      "recipient_not_allowed",
      `recipient not allowed: ${blocked.join(", ")}; allowed: ${allowlist.join(", ")}`,
    );
  }
}

/**
 * Accept one recipient or several, as an array or as a comma/semicolon separated string.
 * A single address is by far the common case, so a bare string must not be an error.
 */
export function normalizeRecipients(value) {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[,;，；]/u);
  return list.map((entry) => String(entry ?? "").trim()).filter(Boolean);
}

/**
 * Normalise email_draft arguments.
 * @returns {{to: string[], cc: string[], subject: string, text: string|undefined, problem?: string}}
 */
export function normalizeDraftArgs(args = {}) {
  const input = args && typeof args === "object" ? args : {};
  const to = normalizeRecipients(input.to);
  const cc = normalizeRecipients(input.cc);
  const subject = input.subject === undefined || input.subject === null ? "" : String(input.subject);
  const body = input.text ?? input.body;
  const text = body === undefined || body === null ? undefined : String(body);

  // Reported as data rather than thrown, so the tool can answer the model with a fixable message.
  let problem;
  if (to.length === 0) problem = "at least one recipient is required in 'to' (a single address as a string is fine)";
  else if (!subject.trim()) problem = "'subject' is required";
  else if (text === undefined || !text.trim()) problem = "a plain-text body is required as 'text' (or 'body')";
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > 10 || attachments.some(a => !a || typeof a.documentId !== 'string' || Object.keys(a).some(k => k !== 'documentId'))) problem = "attachments must be up to 10 managed {documentId} references; paths and raw content are not accepted";
  return { to, cc, subject, text, attachments, problem };
}

/** Normalise email_outbox arguments; listing is the obvious default when action is omitted. */
export function normalizeOutboxArgs(args = {}) {
  const input = args && typeof args === "object" ? args : {};
  const action = input.action === undefined || input.action === null ? "list" : String(input.action);
  const limit = Number.isInteger(input.limit) ? Math.min(Math.max(input.limit, 1), 50) : undefined;
  const draftId = input.draftId === undefined || input.draftId === null ? undefined : String(input.draftId);
  if (!["list", "audit", "cancel"].includes(action)) {
    return { action, draftId, limit, problem: `'action' must be one of list, audit, cancel (received ${JSON.stringify(action)})` };
  }
  if (action === "cancel" && !draftId) return { action, draftId, limit, problem: "'draftId' is required to cancel a draft" };
  return { action, draftId, limit };
}

/**
 * Normalise email_send arguments.
 *
 * A model routinely pastes the confirmation line back in as `approval` (or similar). That string is
 * deliberately IGNORED: approval is the grant the host recorded when the owner replied, and nothing a
 * model puts in an argument may substitute for it. Accepting the field without acting on it keeps the
 * call from failing schema validation over a harmless extra key.
 */
export function normalizeSendArgs(args = {}) {
  const input = args && typeof args === "object" ? args : {};
  const draftId = input.draftId === undefined || input.draftId === null ? "" : String(input.draftId).trim();
  if (!draftId) {
    return { draftId, problem: "'draftId' is required — use the id returned by email_draft (approval is checked from the owner's own reply, not from an argument)" };
  }
  return { draftId };
}

/** Validate a single recipient address using the same rule the MIME builder applies. */
export function assertRecipient(value, label = "recipient") {
  const address = String(value ?? "").trim();
  if (!isValidAddress(address)) throw new Error(`invalid ${label}: ${address}`);
  return address;
}

/**
 * The default Policy implementation, as registered in adapters.js.
 *
 * The standalone functions above stay exported because they are the unit-tested pieces and the
 * confirmation-backend path uses them directly; this object is the contract-shaped view of the same
 * rules, so a replacement policy only has to satisfy four methods.
 *
 * @type {import('./contracts.js').Policy}
 */
export const defaultMailPolicy = Object.freeze({
  normalizeDraft: normalizeDraftArgs,
  normalizeSend: normalizeSendArgs,
  normalizeOutbox: normalizeOutboxArgs,
  assertRecipientsAllowed,
});
