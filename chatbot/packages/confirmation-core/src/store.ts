// Shared proposal/grant persistence. The caller owns the business transaction.
import { createHash, randomUUID } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { ConfirmationDomain, ConfirmationScope, ConfirmationProposalRow, ConfirmationProposalStatus, ConfirmationGrantStatus, ConfirmationGrantCheck } from "./types.js";
import { ensureConfirmationGateSchema } from "./schema.js";
import { parseConfirmationText, confirmationCode, normalizedContent } from "./protocol.js";
import { scopesMatch, serializeScope, parseScope } from "./scope.js";
import { boundedText, assertHash, assertUnixSeconds } from "./validation.js";

const CONFIRMATION_GRANT_TTL_SECONDS = 5 * 60;

export function registerConfirmationProposal(
  database: DatabaseSync,
  input: {
    proposalId: string;
    domain: ConfirmationDomain;
    actionKind: string;
    subjectId: string;
    payloadHash: string;
    scope: ConfirmationScope;
    createdAtUtc: number;
    expiresAtUtc: number;
  },
): void {
  ensureConfirmationGateSchema(database);
  database.prepare(`
    INSERT INTO confirmation_proposals (
      proposal_id, domain, action_kind, subject_id, payload_hash, scope_json,
      status, created_at_utc, expires_at_utc, updated_at_utc
    ) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(proposal_id) DO UPDATE SET
      domain = excluded.domain,
      action_kind = excluded.action_kind,
      subject_id = excluded.subject_id,
      payload_hash = excluded.payload_hash,
      scope_json = excluded.scope_json,
      status = CASE
        WHEN confirmation_proposals.status = 'committed' THEN confirmation_proposals.status
        ELSE 'pending'
      END,
      created_at_utc = excluded.created_at_utc,
      expires_at_utc = excluded.expires_at_utc,
      updated_at_utc = excluded.updated_at_utc
  `).run(
    input.proposalId,
    input.domain,
    boundedText(input.actionKind, "actionKind", 100),
    boundedText(input.subjectId, "subjectId", 200),
    assertHash(input.payloadHash),
    serializeScope(input.scope),
    assertUnixSeconds(input.createdAtUtc),
    assertUnixSeconds(input.expiresAtUtc),
    assertUnixSeconds(input.createdAtUtc),
  );
}

export function listPendingConfirmationProposals(
  database: DatabaseSync,
  input: { subjectId: string; scope: ConfirmationScope; nowUtc: number },
): ConfirmationProposalRow[] {
  ensureConfirmationGateSchema(database);
  const rows = database.prepare(`
    SELECT proposal_id, domain, action_kind, subject_id, payload_hash, scope_json,
           status, created_at_utc, expires_at_utc
    FROM confirmation_proposals
    WHERE subject_id = ? AND status = 'pending' AND expires_at_utc > ?
    ORDER BY created_at_utc DESC
  `).all(input.subjectId, assertUnixSeconds(input.nowUtc)) as Array<{
    proposal_id: string;
    domain: ConfirmationDomain;
    action_kind: string;
    subject_id: string;
    payload_hash: string;
    scope_json: string;
    status: ConfirmationProposalStatus;
    created_at_utc: number;
    expires_at_utc: number;
  }>;
  return rows
    .map((row) => ({
      proposalId: row.proposal_id,
      domain: row.domain,
      actionKind: row.action_kind,
      subjectId: row.subject_id,
      payloadHash: row.payload_hash,
      scope: parseScope(row.scope_json),
      status: row.status,
      createdAtUtc: row.created_at_utc,
      expiresAtUtc: row.expires_at_utc,
    }))
    .filter((proposal) => scopesMatch(proposal.scope, input.scope));
}

export function findConfirmationProposalForInbound(
  database: DatabaseSync,
  input: { subjectId: string; scope: ConfirmationScope; content: string; nowUtc: number },
): ConfirmationProposalRow | undefined {
  const candidates = listConfirmationProposalsForInbound(database, input);
  return candidates.length === 1 ? candidates[0] : undefined;
}

export function listConfirmationProposalsForInbound(
  database: DatabaseSync,
  input: { subjectId: string; scope: ConfirmationScope; content: string; nowUtc: number },
): ConfirmationProposalRow[] {
  const confirmation = parseConfirmationText(input.content);
  if (!confirmation) return [];
  const proposals = listPendingConfirmationProposals(database, input);
  // Short codes bind BOTH complete identifiers; the registry rejects cross-domain ambiguity.
  return proposals.filter((proposal) => "shortCode" in confirmation
    ? confirmationCode(proposal.proposalId, proposal.payloadHash) === confirmation.shortCode
    : proposal.proposalId.toLowerCase() === confirmation.proposalId
      && proposal.payloadHash.toLowerCase() === confirmation.payloadHash);
}

export function issueApprovalGrant(
  database: DatabaseSync,
  input: {
    proposal: ConfirmationProposalRow;
    confirmationMessageId: string;
    confirmationContent?: string;
    scope: ConfirmationScope;
    nowUtc: number;
  },
): { ok: true; grantId: string; idempotent: boolean } | { ok: false; code: "confirmation_context_mismatch" } {
  ensureConfirmationGateSchema(database);
  const messageId = boundedText(input.confirmationMessageId, "confirmationMessageId", 500);
  if (!scopesMatch(input.proposal.scope, input.scope)) {
    return { ok: false, code: "confirmation_context_mismatch" };
  }
  const nowUtc = assertUnixSeconds(input.nowUtc);
  if (nowUtc < input.proposal.createdAtUtc) {
    return { ok: false, code: "confirmation_context_mismatch" };
  }
  const existing = database.prepare(`
    SELECT grant_id, status
    FROM approval_grants
    WHERE proposal_id = ? AND confirmation_message_id = ?
    LIMIT 1
  `).get(input.proposal.proposalId, messageId) as { grant_id: string; status: ConfirmationGrantStatus } | undefined;
  if (existing) {
    return { ok: true, grantId: existing.grant_id, idempotent: true };
  }
  const grantId = randomUUID();
  const expiresAtUtc = Math.min(input.proposal.expiresAtUtc, nowUtc + CONFIRMATION_GRANT_TTL_SECONDS);
  const eventHash = createHash("sha256")
    .update(`${messageId}|${input.scope.primary}|${input.confirmationContent === undefined ? "" : normalizedContent(input.confirmationContent)}`)
    .digest("hex");
  database.prepare(`
    INSERT INTO approval_grants (
      grant_id, proposal_id, domain, subject_id, payload_hash, scope_json,
      confirmation_message_id, confirmation_event_hash, issued_at_utc,
      expires_at_utc, status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
  `).run(
    grantId,
    input.proposal.proposalId,
    input.proposal.domain,
    input.proposal.subjectId,
    input.proposal.payloadHash,
    serializeScope(input.scope),
    messageId,
    eventHash,
    nowUtc,
    expiresAtUtc,
  );
  return { ok: true, grantId, idempotent: false };
}

export function checkApprovalGrant(
  database: DatabaseSync,
  input: {
    proposalId: string;
    domain: ConfirmationDomain;
    subjectId: string;
    payloadHash: string;
    scope: ConfirmationScope;
    nowUtc: number;
    consume: boolean;
  },
): ConfirmationGrantCheck {
  ensureConfirmationGateSchema(database);
  const nowUtc = assertUnixSeconds(input.nowUtc);
  const row = database.prepare(`
    SELECT grant_id, scope_json, issued_at_utc, expires_at_utc, status
    FROM approval_grants
    WHERE proposal_id = ? AND domain = ? AND subject_id = ? AND payload_hash = ?
    ORDER BY issued_at_utc DESC
    LIMIT 1
  `).get(
    input.proposalId,
    input.domain,
    input.subjectId,
    assertHash(input.payloadHash),
  ) as {
    grant_id: string;
    scope_json: string;
    issued_at_utc: number;
    expires_at_utc: number;
    status: ConfirmationGrantStatus;
  } | undefined;
  if (!row) return { ok: false, code: "approval_required" };
  if (!scopesMatch(parseScope(row.scope_json), input.scope)) {
    return { ok: false, code: "confirmation_context_mismatch" };
  }
  if (row.expires_at_utc <= nowUtc || row.status === "expired") {
    if (row.status === "pending") {
      database.prepare(`
        UPDATE approval_grants SET status = 'expired', consumption_result = 'expired'
        WHERE grant_id = ? AND status = 'pending'
      `).run(row.grant_id);
    }
    return { ok: false, code: "grant_expired" };
  }
  if (row.status === "consumed") return { ok: false, code: "grant_replayed" };
  if (row.status !== "pending") return { ok: false, code: "approval_required" };
  if (row.issued_at_utc < 0) return { ok: false, code: "approval_required" };
  if (!input.consume) return { ok: true, grantId: row.grant_id };
  const updated = database.prepare(`
    UPDATE approval_grants
    SET status = 'consumed', consumed_at_utc = ?, consumption_result = 'accepted'
    WHERE grant_id = ? AND status = 'pending' AND expires_at_utc > ?
  `).run(nowUtc, row.grant_id, nowUtc);
  return Number(updated.changes) === 1
    ? { ok: true, grantId: row.grant_id }
    : { ok: false, code: "grant_replayed" };
}

export function markConfirmationProposalCommitted(
  database: DatabaseSync,
  input: { proposalId: string; subjectId: string; atUtc: number },
): void {
  database.prepare(`
    UPDATE confirmation_proposals
    SET status = 'committed', updated_at_utc = ?
    WHERE proposal_id = ? AND subject_id = ? AND status = 'pending'
  `).run(assertUnixSeconds(input.atUtc), input.proposalId, input.subjectId);
}

export function markConfirmationProposalExpired(
  database: DatabaseSync,
  input: { proposalId: string; subjectId: string; atUtc: number },
): void {
  database.prepare(`
    UPDATE confirmation_proposals
    SET status = 'expired', updated_at_utc = ?
    WHERE proposal_id = ? AND subject_id = ? AND status = 'pending'
  `).run(assertUnixSeconds(input.atUtc), input.proposalId, input.subjectId);
  database.prepare(`
    UPDATE approval_grants
    SET status = 'expired', consumption_result = 'proposal_expired'
    WHERE proposal_id = ? AND subject_id = ? AND status = 'pending'
  `).run(input.proposalId, input.subjectId);
}
