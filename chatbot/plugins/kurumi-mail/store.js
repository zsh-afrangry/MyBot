// Storage, confirmation gate and audit trail for kurumi-mail.
//
// The confirmation machinery is NOT reimplemented here: proposals, grants, short codes, TTLs,
// idempotency and inbound routing all come from @kurumi/confirmation-core, the same package the
// reminder, planning and profile domains use. That matters for more than consistency — the host only
// routes an owner's "确认 <code>" message to backends registered through that package's registry, so
// a private implementation would leave confirmations unreachable.
//
// What lives here: the draft (what would be sent), its payload hash, delivery status, and an audit
// trail. Credentials are never stored and never audited.
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { isValidAddress } from "./mime.js";
import {
  buildConfirmationInstruction,
  checkApprovalGrant,
  ensureConfirmationGateSchema,
  findConfirmationProposalForInbound,
  issueApprovalGrant,
  listConfirmationProposalsForInbound,
  markConfirmationProposalCommitted,
  registerConfirmationProposal,
  scopeFromInboundEvent,
} from "@kurumi/confirmation-core";

export const OWNER_SUBJECT_ID = "owner";
export const MAIL_DOMAIN = "mail";
export const SEND_ACTION_KIND = "email.send";
/** A draft may wait for confirmation for a day; the grant itself expires much sooner (core: 5 min). */
export const DRAFT_TTL_SECONDS = 24 * 60 * 60;
const MAX_RECIPIENTS = 20;
const MAX_SUBJECT = 300;
const MAX_BODY = 100_000;
const MAX_ATTACHMENTS = 10;
const MAX_ATTACHMENT_BYTES = 10 * 1024 * 1024;

const SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS mail_drafts (
  draft_id TEXT PRIMARY KEY,
  payload_hash TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT NOT NULL DEFAULT '[]',
  subject TEXT NOT NULL,
  text_body TEXT NOT NULL,
  attachments_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL,
  expires_at_utc INTEGER NOT NULL,
  sent_at_utc INTEGER,
  message_id TEXT,
  delivery_response TEXT,
  last_error TEXT
);
CREATE INDEX IF NOT EXISTS mail_drafts_status ON mail_drafts (status, created_at_utc);
CREATE TABLE IF NOT EXISTS mail_audit (
  at_utc INTEGER NOT NULL,
  action TEXT NOT NULL,
  draft_id TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);
`;

/** Canonical hash of everything that would leave the machine. Changing any field invalidates approval. */
export function draftPayloadHash({ to, cc = [], subject, text, attachments = [] }) {
  const canonical = JSON.stringify({
    to: [...to].map((entry) => String(entry).trim().toLowerCase()).sort(),
    cc: [...cc].map((entry) => String(entry).trim().toLowerCase()).sort(),
    subject: String(subject),
    text: String(text),
    attachments: attachments.map((entry) => ({
      filename: String(entry.filename),
      contentType: String(entry.contentType ?? "application/octet-stream"),
      bytes: Buffer.isBuffer(entry.content) ? entry.content.length : Buffer.byteLength(String(entry.content ?? ""), "utf8"),
      sha256: createHash("sha256")
        .update(Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(String(entry.content ?? ""), "utf8"))
        .digest("hex"),
    })),
  });
  return createHash("sha256").update(canonical).digest("hex");
}

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

function unauthorized(message) {
  const error = new Error(message);
  error.code = "unauthorized_owner_context";
  return error;
}

/** Validate one recipient using the same rule the MIME builder applies. */
export function assertRecipient(value, label = "recipient") {
  const address = String(value ?? "").trim();
  if (!isValidAddress(address)) throw new Error(`invalid ${label}: ${address}`);
  return address;
}

export class MailStore {
  #db;
  #file;
  #now;

  #allowedRecipients;

  constructor({ stateDirectory, now = () => Math.floor(Date.now() / 1000), allowedRecipients = [] } = {}) {
    if (!stateDirectory) throw new Error("stateDirectory is required");
    this.#allowedRecipients = normalizeAllowlist(allowedRecipients);
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.#file = path.join(stateDirectory, "mail.sqlite");
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec("PRAGMA journal_mode = WAL");
    this.#db.exec(SCHEMA_SQL);
    ensureConfirmationGateSchema(this.#db);
    this.#now = now;
  }

  get file() {
    return this.#file;
  }

  /** Current policy, exposed so status output can show what is permitted. */
  get allowedRecipients() {
    return [...this.#allowedRecipients];
  }

  close() {
    try {
      this.#db.close();
    } catch {
      // already closed
    }
  }

  nowUtc() {
    return this.#now();
  }

  #audit(action, draftId, detail = {}) {
    this.#db
      .prepare("INSERT INTO mail_audit (at_utc, action, draft_id, detail_json) VALUES (?, ?, ?, ?)")
      .run(this.nowUtc(), String(action), draftId ?? null, JSON.stringify(detail));
  }

  /**
   * Create a draft and its pending confirmation proposal.
   * @returns {{draftId: string, payloadHash: string, instruction: string, expiresAtUtc: number}}
   */
  createDraft(input, scope) {
    if (!scope?.primary) throw unauthorized("confirmation scope is required");
    const to = (Array.isArray(input?.to) ? input.to : [input?.to]).filter((entry) => entry !== undefined && entry !== null).map((entry) => assertRecipient(entry, "recipient"));
    if (to.length === 0) throw new Error("at least one recipient is required");
    if (to.length > MAX_RECIPIENTS) throw new Error(`at most ${MAX_RECIPIENTS} recipients are supported`);
    const cc = (Array.isArray(input?.cc) ? input.cc : []).filter(Boolean).map((entry) => assertRecipient(entry, "cc recipient"));
    const subject = String(input?.subject ?? "").trim();
    if (!subject) throw new Error("subject is required");
    if (subject.length > MAX_SUBJECT) throw new Error(`subject must be at most ${MAX_SUBJECT} characters`);
    if (/[\r\n\0]/.test(subject)) throw new Error("subject must not contain CR, LF or NUL");
    const text = String(input?.text ?? "");
    if (!text.trim()) throw new Error("body text is required");
    if (text.length > MAX_BODY) throw new Error(`body must be at most ${MAX_BODY} characters`);
    const attachments = Array.isArray(input?.attachments) ? input.attachments : [];
    if (attachments.length > MAX_ATTACHMENTS) throw new Error(`at most ${MAX_ATTACHMENTS} attachments are supported`);
    for (const attachment of attachments) {
      const filename = String(attachment?.filename ?? "");
      if (!filename || /[\r\n\0]/.test(filename)) throw new Error("each attachment needs a safe filename");
      const bytes = Buffer.isBuffer(attachment.content) ? attachment.content.length : Buffer.byteLength(String(attachment.content ?? ""), "utf8");
      if (bytes === 0) throw new Error(`attachment ${filename} is empty`);
      if (bytes > MAX_ATTACHMENT_BYTES) throw new Error(`attachment ${filename} exceeds the size limit`);
    }

    const draftId = randomUUID();
    const payloadHash = draftPayloadHash({ to, cc, subject, text, attachments });
    // Policy check before anything is written: a refused draft must leave no trace to approve.
    assertRecipientsAllowed([...to, ...cc], this.#allowedRecipients);

    const createdAtUtc = this.nowUtc();
    const expiresAtUtc = createdAtUtc + DRAFT_TTL_SECONDS;

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare(`INSERT INTO mail_drafts (
            draft_id, payload_hash, to_json, cc_json, subject, text_body, attachments_json,
            status, created_at_utc, expires_at_utc
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)`)
        .run(
          draftId, payloadHash, JSON.stringify(to), JSON.stringify(cc), subject, text,
          JSON.stringify(attachments.map((entry) => ({ filename: String(entry.filename), contentType: String(entry.contentType ?? "application/octet-stream") }))),
          createdAtUtc, expiresAtUtc,
        );
      registerConfirmationProposal(this.#db, {
        proposalId: draftId,
        domain: MAIL_DOMAIN,
        actionKind: SEND_ACTION_KIND,
        subjectId: OWNER_SUBJECT_ID,
        payloadHash,
        scope,
        createdAtUtc,
        expiresAtUtc,
      });
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
    this.#audit("draft_created", draftId, {recipients: to.length, cc: cc.length, subjectChars: subject.length});
    return { draftId, payloadHash, instruction: buildConfirmationInstruction(draftId, payloadHash), expiresAtUtc };
  }

  getDraft(draftId) {
    const row = this.#db.prepare("SELECT * FROM mail_drafts WHERE draft_id = ?").get(String(draftId));
    if (!row) return undefined;
    return {
      draftId: row.draft_id,
      payloadHash: row.payload_hash,
      to: JSON.parse(row.to_json),
      cc: JSON.parse(row.cc_json),
      subject: row.subject,
      text: row.text_body,
      attachments: JSON.parse(row.attachments_json),
      status: row.status,
      createdAtUtc: Number(row.created_at_utc),
      expiresAtUtc: Number(row.expires_at_utc),
      sentAtUtc: row.sent_at_utc === null ? undefined : Number(row.sent_at_utc),
      messageId: row.message_id ?? undefined,
      lastError: row.last_error ?? undefined,
    };
  }

  listDrafts({ status, limit = 20 } = {}) {
    const rows = status
      ? this.#db.prepare("SELECT draft_id FROM mail_drafts WHERE status = ? ORDER BY created_at_utc DESC LIMIT ?").all(String(status), Number(limit))
      : this.#db.prepare("SELECT draft_id FROM mail_drafts ORDER BY created_at_utc DESC LIMIT ?").all(Number(limit));
    return rows.map((row) => this.getDraft(row.draft_id));
  }

  listAudit({ limit = 20 } = {}) {
    return this.#db
      .prepare("SELECT at_utc, action, draft_id, detail_json FROM mail_audit ORDER BY at_utc DESC, rowid DESC LIMIT ?")
      .all(Number(limit))
      .map((row) => ({ atUtc: Number(row.at_utc), action: row.action, draftId: row.draft_id ?? undefined, detail: JSON.parse(row.detail_json) }));
  }

  markSent(draftId, { messageId, response }) {
    this.#db
      .prepare("UPDATE mail_drafts SET status = 'sent', sent_at_utc = ?, message_id = ?, delivery_response = ?, last_error = NULL WHERE draft_id = ?")
      .run(this.nowUtc(), String(messageId ?? ""), String(response ?? "").slice(0, 500), String(draftId));
    markConfirmationProposalCommitted(this.#db, { proposalId: String(draftId), subjectId: OWNER_SUBJECT_ID, atUtc: this.nowUtc() });
    this.#audit("sent", draftId, {messageId: String(messageId ?? "")});
  }

  markFailed(draftId, error) {
    this.#db
      .prepare("UPDATE mail_drafts SET status = 'failed', last_error = ? WHERE draft_id = ?")
      .run(`${error?.code ?? "error"}: ${String(error?.message ?? error).slice(0, 300)}`, String(draftId));
    this.#audit("failed", draftId, {code: String(error?.code ?? "error")});
  }

  cancelDraft(draftId) {
    const info = this.#db.prepare("UPDATE mail_drafts SET status = 'cancelled' WHERE draft_id = ? AND status = 'pending'").run(String(draftId));
    if (Number(info.changes) === 0) return false;
    this.#audit("cancelled", draftId, {});
    return true;
  }

  /**
   * Consume the owner's approval for this exact draft content.
   * Returns the core grant check verbatim so callers can surface `approval_required` etc.
   */
  consumeApproval({ draftId, scope }) {
    const draft = this.getDraft(draftId);
    if (!draft) return { ok: false, code: "unknown_draft" };
    if (draft.status === "sent") return { ok: false, code: "already_sent" };
    if (draft.status !== "pending") return { ok: false, code: "draft_not_pending" };
    const nowUtc = this.nowUtc();
    if (nowUtc > draft.expiresAtUtc) return { ok: false, code: "draft_expired" };
    return checkApprovalGrant(this.#db, {
      proposalId: draft.draftId,
      domain: MAIL_DOMAIN,
      subjectId: OWNER_SUBJECT_ID,
      payloadHash: draft.payloadHash,
      scope,
      nowUtc,
      consume: true,
    });
  }

  // ---------------------------------------------------------------- ConfirmationBackend protocol

  /** Pending drafts whose proposal matches this inbound message (usually the short code). */
  listInboundConfirmationCandidates(event) {
    if (!event?.messageId) return [];
    const scope = scopeFromInboundEvent(event);
    if (!scope) return [];
    return listConfirmationProposalsForInbound(this.#db, {
      subjectId: OWNER_SUBJECT_ID,
      scope,
      content: event.content,
      nowUtc: typeof event.timestamp === "number" ? Math.floor(event.timestamp) : this.nowUtc(),
    });
  }

  recordInboundConfirmation(event, expectedProposalId) {
    if (!event?.messageId || event.replyToIsQuote === true) return false;
    const scope = scopeFromInboundEvent(event);
    if (!scope) return false;
    const nowUtc = typeof event.timestamp === "number" ? Math.floor(event.timestamp) : this.nowUtc();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const proposal = findConfirmationProposalForInbound(this.#db, {
        subjectId: OWNER_SUBJECT_ID,
        scope,
        content: event.content,
        nowUtc,
      });
      if (!proposal || proposal.domain !== MAIL_DOMAIN) {
        this.#db.exec("COMMIT");
        return false;
      }
      if (expectedProposalId !== undefined && proposal.proposalId !== expectedProposalId) {
        this.#db.exec("COMMIT");
        return false;
      }
      const granted = issueApprovalGrant(this.#db, {
        proposal,
        confirmationMessageId: String(event.messageId),
        confirmationContent: event.content,
        scope,
        nowUtc,
      });
      this.#db.exec("COMMIT");
      if (granted.ok) this.#audit("approved", proposal.proposalId, {idempotent: granted.idempotent});
      return granted.ok;
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
