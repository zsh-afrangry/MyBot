// Storage, per-email trust grants, saved-attachment ledger, and mail_inbox confirmation gate.
import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import {
  checkApprovalGrant,
  createNaturalConfirmationBackend,
  ensureConfirmationGateSchema,
  markConfirmationProposalCommitted,
  registerConfirmationProposal,
} from "../../packages/confirmation-core/dist/index.js";

export const OWNER_SUBJECT_ID = "owner";
export const MAIL_INBOX_DOMAIN = "mail_inbox";
export const MAIL_INBOX_BACKEND_ID = "kurumi-mail-inbox";
export const INBOX_PROPOSAL_TTL_SECONDS = 1800;
export const INBOX_GRANT_TTL_SECONDS = 24 * 60 * 60;
export const INBOX_UUID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

const sha256 = value => createHash("sha256").update(value).digest("hex");

const INBOX_SCHEMA_SQL = String.raw`
CREATE TABLE IF NOT EXISTS mail_inbox_proposals (
  proposal_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT 'default',
  kind TEXT NOT NULL,
  plan_json TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL,
  expires_at_utc INTEGER NOT NULL,
  result_json TEXT,
  error TEXT
) STRICT;
CREATE INDEX IF NOT EXISTS mail_inbox_proposals_account_created
  ON mail_inbox_proposals(account_id, created_at_utc);

CREATE TABLE IF NOT EXISTS mail_inbox_grants (
  grant_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT 'default',
  folder TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  message_id_header TEXT,
  from_address TEXT NOT NULL,
  allow_read_body INTEGER NOT NULL DEFAULT 1,
  allow_save_attachment INTEGER NOT NULL DEFAULT 0,
  proposal_id TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL,
  expires_at_utc INTEGER NOT NULL
) STRICT;
CREATE INDEX IF NOT EXISTS mail_inbox_grants_lookup
  ON mail_inbox_grants(account_id, folder, uid_validity, uid, expires_at_utc);

CREATE TABLE IF NOT EXISTS mail_saved_attachments (
  save_id TEXT PRIMARY KEY,
  account_id TEXT NOT NULL DEFAULT 'default',
  folder TEXT NOT NULL,
  uid_validity INTEGER NOT NULL,
  uid INTEGER NOT NULL,
  part_id TEXT NOT NULL,
  filename TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  saved_path TEXT NOT NULL,
  created_at_utc INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX IF NOT EXISTS mail_saved_attachments_unique
  ON mail_saved_attachments(account_id, folder, uid_validity, uid, part_id, sha256);

CREATE TABLE IF NOT EXISTS mail_inbox_audit (
  at_utc INTEGER NOT NULL,
  account_id TEXT NOT NULL DEFAULT 'default',
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL DEFAULT '{}'
) STRICT;
CREATE INDEX IF NOT EXISTS mail_inbox_audit_at ON mail_inbox_audit(account_id, at_utc);
`;

export class InboxStore {
  #db;
  #file;
  #now;

  constructor({ stateDirectory, now = () => Math.floor(Date.now() / 1000) } = {}) {
    if (!stateDirectory) throw new Error("stateDirectory is required");
    fs.mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });
    this.#file = path.join(stateDirectory, "mail.sqlite");
    this.#db = new DatabaseSync(this.#file);
    this.#db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000; PRAGMA synchronous = FULL");
    ensureConfirmationGateSchema(this.#db);
    this.#db.exec(INBOX_SCHEMA_SQL);
    this.#now = now;
  }

  get file() {
    return this.#file;
  }

  nowUtc() {
    return this.#now();
  }

  close() {
    try { this.#db.close(); } catch { /* already closed */ }
  }

  get natural() {
    return createNaturalConfirmationBackend(this.#db, {
      supportsBatch: false,
      subjectId: OWNER_SUBJECT_ID,
      domains: [MAIL_INBOX_DOMAIN],
      now: () => this.nowUtc(),
    });
  }

  audit(action, detail = {}, accountId = "default") {
    this.#db
      .prepare("INSERT INTO mail_inbox_audit (at_utc, account_id, action, detail_json) VALUES (?, ?, ?, ?)")
      .run(this.nowUtc(), accountId, String(action), JSON.stringify(detail));
  }

  listAudit({ accountId = "default", limit = 20 } = {}) {
    return this.#db
      .prepare("SELECT at_utc, account_id, action, detail_json FROM mail_inbox_audit WHERE account_id = ? ORDER BY at_utc DESC, rowid DESC LIMIT ?")
      .all(accountId, Number(limit))
      .map(row => ({
        atUtc: Number(row.at_utc),
        accountId: row.account_id,
        action: row.action,
        detail: JSON.parse(row.detail_json),
      }));
  }

  propose(plan, kind, scope, { proposalId = randomUUID(), ttlSeconds = INBOX_PROPOSAL_TTL_SECONDS } = {}) {
    if (!scope?.primary) throw new Error("confirmation scope is required");
    if (!INBOX_UUID_PATTERN.test(proposalId)) throw new Error("invalid proposalId");
    const canonical = JSON.stringify(plan);
    const payloadHash = sha256(canonical);
    const createdAtUtc = this.nowUtc();
    const expiresAtUtc = createdAtUtc + ttlSeconds;
    const accountId = plan.accountId ?? "default";
    const actionKind = kind === "access" ? "mail.inbox.access" : "mail.inbox.manage";

    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db.prepare(`
        INSERT INTO mail_inbox_proposals (
          proposal_id, account_id, kind, plan_json, payload_hash, state, created_at_utc, expires_at_utc
        ) VALUES (?, ?, ?, ?, ?, 'pending', ?, ?)
      `).run(proposalId, accountId, kind, canonical, payloadHash, createdAtUtc, expiresAtUtc);
      registerConfirmationProposal(this.#db, {
        proposalId,
        domain: MAIL_INBOX_DOMAIN,
        actionKind,
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
    this.audit(`${kind}_proposed`, { proposalId, folder: plan.folder, uid: plan.uid }, accountId);
    return { domain: MAIL_INBOX_DOMAIN, proposalId, payloadHash, expiresAtUtc };
  }

  getProposal(proposalId) {
    if (typeof proposalId !== "string" || !INBOX_UUID_PATTERN.test(proposalId)) return undefined;
    const row = this.#db.prepare(`
      SELECT a.*, p.expires_at_utc AS core_expires_at_utc
      FROM mail_inbox_proposals a
      LEFT JOIN confirmation_proposals p ON p.proposal_id = a.proposal_id
      WHERE a.proposal_id = ?
    `).get(proposalId);
    if (!row) return undefined;
    const expiresAtUtc = Number(row.core_expires_at_utc ?? row.expires_at_utc);
    const state = row.state === "pending" && this.nowUtc() > expiresAtUtc ? "expired" : row.state;
    return {
      proposalId: row.proposal_id,
      accountId: row.account_id,
      kind: row.kind,
      plan: JSON.parse(row.plan_json),
      payloadHash: row.payload_hash,
      state,
      createdAtUtc: Number(row.created_at_utc),
      expiresAtUtc,
      result: row.result_json ? JSON.parse(row.result_json) : undefined,
      error: row.error ?? undefined,
    };
  }

  claimProposal(proposalId, expectedKind, scope) {
    if (typeof proposalId !== "string" || !INBOX_UUID_PATTERN.test(proposalId)) {
      return { ok: false, code: "invalid_proposal_id" };
    }
    const nowUtc = this.nowUtc();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.#db.prepare("SELECT * FROM mail_inbox_proposals WHERE proposal_id = ?").get(proposalId);
      if (!row) { this.#db.exec("COMMIT"); return { ok: false, code: "unknown_inbox_proposal" }; }
      if (row.kind !== expectedKind) { this.#db.exec("COMMIT"); return { ok: false, code: "inbox_proposal_kind_mismatch" }; }
      if (row.state !== "pending") {
        this.#db.exec("COMMIT");
        return { ok: false, code: row.state === "committed" ? "already_committed" : "inbox_proposal_not_pending" };
      }
      if (nowUtc > Number(row.expires_at_utc)) {
        this.#db.exec("COMMIT");
        return { ok: false, code: "inbox_proposal_expired" };
      }
      if (sha256(row.plan_json) !== row.payload_hash) {
        this.#db.exec("COMMIT");
        return { ok: false, code: "inbox_proposal_tampered" };
      }
      const approval = checkApprovalGrant(this.#db, {
        proposalId,
        domain: MAIL_INBOX_DOMAIN,
        subjectId: OWNER_SUBJECT_ID,
        payloadHash: row.payload_hash,
        scope,
        nowUtc,
        consume: true,
      });
      if (!approval.ok) {
        this.#db.exec("COMMIT");
        return approval;
      }
      markConfirmationProposalCommitted(this.#db, { proposalId, subjectId: OWNER_SUBJECT_ID, atUtc: nowUtc });
      this.#db.prepare("UPDATE mail_inbox_proposals SET state = 'executing' WHERE proposal_id = ?").run(proposalId);
      this.#db.exec("COMMIT");
      return { ok: true, proposalId, accountId: row.account_id, kind: row.kind, plan: JSON.parse(row.plan_json) };
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }

  finishProposal(proposalId, { state, result = null, error = null }) {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      this.#db
        .prepare("UPDATE mail_inbox_proposals SET state = ?, result_json = ?, error = ? WHERE proposal_id = ?")
        .run(state, result ? JSON.stringify(result) : null, error ?? null, proposalId);
      this.#db.exec("COMMIT");
    } catch (err) {
      this.#db.exec("ROLLBACK");
      throw err;
    }
  }

  grantInboxAccess({
    accountId = "default",
    folder,
    uidValidity,
    uid,
    messageIdHeader = null,
    fromAddress,
    allowReadBody = true,
    allowSaveAttachment = false,
    proposalId,
    ttlSeconds = INBOX_GRANT_TTL_SECONDS,
  }) {
    const grantId = randomUUID();
    const createdAtUtc = this.nowUtc();
    const expiresAtUtc = createdAtUtc + ttlSeconds;
    this.#db.prepare(`
      INSERT INTO mail_inbox_grants (
        grant_id, account_id, folder, uid_validity, uid, message_id_header,
        from_address, allow_read_body, allow_save_attachment, proposal_id,
        created_at_utc, expires_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      grantId,
      accountId,
      folder,
      Number(uidValidity ?? 0),
      Number(uid),
      messageIdHeader,
      fromAddress ?? "",
      allowReadBody ? 1 : 0,
      allowSaveAttachment ? 1 : 0,
      proposalId,
      createdAtUtc,
      expiresAtUtc,
    );
    this.audit("access_granted", { grantId, folder, uid, allowSaveAttachment: Boolean(allowSaveAttachment) }, accountId);
    return { grantId, expiresAtUtc };
  }

  getActiveGrant({ accountId = "default", folder, uidValidity, uid }) {
    const row = this.#db.prepare(`
      SELECT * FROM mail_inbox_grants
      WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ? AND expires_at_utc > ?
      ORDER BY allow_save_attachment DESC, created_at_utc DESC, rowid DESC LIMIT 1
    `).get(accountId, folder, Number(uidValidity ?? 0), Number(uid), this.nowUtc());
    if (!row) return null;
    return {
      grantId: row.grant_id,
      allowReadBody: Boolean(row.allow_read_body),
      allowSaveAttachment: Boolean(row.allow_save_attachment),
      fromAddress: row.from_address,
      expiresAtUtc: Number(row.expires_at_utc),
    };
  }

  findSavedAttachment({ accountId = "default", folder, uidValidity, uid, partId, sha256: digest }) {
    const row = this.#db.prepare(`
      SELECT * FROM mail_saved_attachments
      WHERE account_id = ? AND folder = ? AND uid_validity = ? AND uid = ? AND part_id = ? AND sha256 = ?
      LIMIT 1
    `).get(accountId, folder, Number(uidValidity ?? 0), Number(uid), String(partId), String(digest));
    if (!row) return null;
    return {
      saveId: row.save_id,
      filename: row.filename,
      sha256: row.sha256,
      sizeBytes: Number(row.size_bytes),
      savedPath: row.saved_path,
      createdAtUtc: Number(row.created_at_utc),
    };
  }

  recordSavedAttachment({ accountId = "default", folder, uidValidity, uid, partId, filename, sha256: digest, sizeBytes, savedPath }) {
    const saveId = randomUUID();
    const at = this.nowUtc();
    this.#db.prepare(`
      INSERT OR REPLACE INTO mail_saved_attachments (
        save_id, account_id, folder, uid_validity, uid, part_id, filename, sha256, size_bytes, saved_path, created_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(saveId, accountId, folder, Number(uidValidity ?? 0), Number(uid), String(partId), filename, digest, sizeBytes, savedPath, at);
    this.audit("attachment_saved", { folder, uid, partId: String(partId), sha256: digest, sizeBytes }, accountId);
    return { saveId, savedPath, createdAtUtc: at };
  }
}
