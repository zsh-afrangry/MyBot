import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";

export type ConfirmationDomain = string;

export type ConfirmationProposalStatus = "pending" | "committed" | "expired" | "cancelled";

export type ConfirmationGrantStatus = "pending" | "consumed" | "expired" | "rejected";

export interface ConfirmationScope {
  /** The strongest runtime correlation available for this conversation. */
  primary: string;
  /** Delivery/conversation aliases used when the host omits a session key. */
  delivery: string[];
}

export interface ConfirmationInboundEvent {
  channel: string;
  accountId?: string;
  conversationId?: string;
  senderId?: string;
  sessionKey?: string;
  messageId?: string;
  content: string;
  timestamp?: number;
  replyToIsQuote?: boolean;
  metadata?: Record<string, unknown>;
  isGroup: boolean;
  senderIsOwner?: boolean;
}

export interface ConfirmationToolContext {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string; accountId?: string };
  requesterSenderId?: string;
  senderIsOwner?: boolean;
  sessionKey?: string;
}

export interface ConfirmationProposalRow {
  proposalId: string;
  domain: ConfirmationDomain;
  actionKind: string;
  subjectId: string;
  payloadHash: string;
  scope: ConfirmationScope;
  status: ConfirmationProposalStatus;
  createdAtUtc: number;
  expiresAtUtc: number;
}

export type ConfirmationGrantCheck =
  | { ok: true; grantId: string }
  | { ok: false; code: "approval_required" | "grant_expired" | "grant_replayed" | "confirmation_context_mismatch" };

export const CONFIRMATION_GATE_SCHEMA_SQL = String.raw`
  CREATE TABLE IF NOT EXISTS confirmation_proposals (
    proposal_id TEXT PRIMARY KEY,
    domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 100),
    action_kind TEXT NOT NULL CHECK (length(action_kind) BETWEEN 1 AND 100),
    subject_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'committed', 'expired', 'cancelled')),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc >= created_at_utc),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS confirmation_proposals_scope_index
    ON confirmation_proposals(subject_id, status, expires_at_utc);

  CREATE TABLE IF NOT EXISTS approval_grants (
    grant_id TEXT PRIMARY KEY,
    proposal_id TEXT NOT NULL,
    domain TEXT NOT NULL CHECK (length(domain) BETWEEN 1 AND 100),
    subject_id TEXT NOT NULL,
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) = 64),
    scope_json TEXT NOT NULL CHECK (json_valid(scope_json)),
    confirmation_message_id TEXT NOT NULL CHECK (length(confirmation_message_id) BETWEEN 1 AND 500),
    confirmation_event_hash TEXT NOT NULL CHECK (length(confirmation_event_hash) = 64),
    issued_at_utc INTEGER NOT NULL CHECK (issued_at_utc >= 0),
    expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc >= issued_at_utc),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'consumed', 'expired', 'rejected')),
    consumed_at_utc INTEGER,
    consumption_result TEXT CHECK (consumption_result IS NULL OR length(consumption_result) <= 200),
    UNIQUE (proposal_id, confirmation_message_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS approval_grants_lookup_index
    ON approval_grants(proposal_id, payload_hash, status, expires_at_utc);
`;

const CONFIRMATION_GRANT_TTL_SECONDS = 5 * 60;
const MAX_SCOPE_VALUE_LENGTH = 500;
const MAX_CONFIRMATION_CONTENT_LENGTH = 2000;
const HASH_PATTERN = /^[a-f0-9]{64}$/u;
/**
 * Owner confirmations arrive as natural language, so the identifiers must be
 * extracted from within a sentence rather than matched against the whole
 * message. Both patterns use token boundaries instead of string anchors so a
 * longer hex run or an adjacent identifier can never yield a partial match.
 */
const UUID_IN_TEXT_PATTERN =
  /(?<![0-9a-f-])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-f-])/iu;
const HASH_IN_TEXT_PATTERN = /(?<![a-f0-9])[a-f0-9]{64}(?![a-f0-9])/iu;

export function ensureConfirmationGateSchema(database: DatabaseSync): void {
  database.exec(CONFIRMATION_GATE_SCHEMA_SQL);
}

export function scopeFromToolContext(input: ConfirmationToolContext): ConfirmationScope | undefined {
  const channel = input.messageChannel ?? input.deliveryContext?.channel;
  if (!["qqbot", "kurumi-qq"].includes(channel ?? "") || input.senderIsOwner !== true) return undefined;
  const target = input.deliveryContext?.to?.trim();
  if (!target) return undefined;
  if (channel === "qqbot" && !/^(?:qqbot:)?c2c:/u.test(target)) return undefined;
  if (channel === "kurumi-qq" && (!/^user:[0-9]{5,12}$/u.test(target)
    || target !== `user:${input.requesterSenderId}`
    || input.sessionKey !== `agent:main:kurumi-qq:direct:${input.requesterSenderId}`)) return undefined;
  const delivery = uniqueStrings([
    target ? `target:${target}` : undefined,
    `account:${input.deliveryContext?.accountId?.trim() || "default"}`,
    input.requesterSenderId ? `sender:${input.requesterSenderId.trim()}` : undefined,
  ]);
  const primary = input.sessionKey?.trim()
    ? `session:${input.sessionKey.trim()}`
    : delivery[0] ?? "unbound";
  return { primary, delivery };
}

/** Binds inbound data to an owner-authorized proposal; does not grant tool access. */
export function scopeFromInboundEvent(event: ConfirmationInboundEvent): ConfirmationScope | undefined {
  if (!["qqbot", "kurumi-qq"].includes(event.channel) || event.isGroup) return undefined;
  if (event.channel === "kurumi-qq" && (event.conversationId !== `user:${event.senderId}`
    || !/^[0-9]{5,12}$/u.test(event.senderId ?? "")
    || event.sessionKey !== `agent:main:kurumi-qq:direct:${event.senderId}`)) return undefined;
  const delivery = uniqueStrings([
    event.accountId?.trim() ? `account:${event.accountId.trim()}` : undefined,
    event.conversationId?.trim() ? `conversation:${event.conversationId.trim()}` : undefined,
    event.conversationId?.trim() ? `target:${event.conversationId.trim()}` : undefined,
    event.senderId?.trim() ? `sender:${event.senderId.trim()}` : undefined,
  ]);
  const primary = event.sessionKey?.trim()
    ? `session:${event.sessionKey.trim()}`
    : delivery[0] ?? "unbound";
  return { primary, delivery };
}

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

/**
 * Extract the confirmed proposal identity from an owner message.
 *
 * Both `proposalId` and `payloadHash` are required. A bare "确认" is therefore
 * never a valid confirmation: it cannot identify which proposal it approves,
 * and multiple pending proposals across domains is the normal case rather than
 * the exception. Both identifiers remain bound, either in full or via the short code.
 * Bare agreement never identifies a proposal; matching must be unique.
 */
export function parseConfirmationText(content: string): { proposalId: string; payloadHash: string } | { shortCode: string } | undefined {
  const normalized = normalizedContent(content);
  if (!normalized || normalized.length > MAX_CONFIRMATION_CONTENT_LENGTH) return undefined;
  if (/(?:不确认|不要确认|取消确认|拒绝|不要提交)/u.test(normalized)) return undefined;
  // The affirmative marker only needs to open the message. Requiring a
  // separator after it rejected legitimate phrasings such as "我确认变更 …",
  // where the verb is followed directly by its object.
  if (!/^(?:我\s*)?(?:确认|同意|批准|可以|执行|提交|yes|ok|好的?)/iu.test(normalized)) {
    return undefined;
  }
  const short = normalized.match(/^确认\s+([a-f0-9]{12})$/iu);
  if (short?.[1]) return { shortCode: short[1].toLowerCase() };
  const ids = [...normalized.matchAll(new RegExp(UUID_IN_TEXT_PATTERN.source, "giu"))];
  const hashes = [...normalized.matchAll(new RegExp(HASH_IN_TEXT_PATTERN.source, "giu"))];
  if (ids.length !== 1 || hashes.length !== 1) return undefined;
  const proposalId = ids[0]?.[0]?.toLowerCase();
  const payloadHash = hashes[0]?.[0]?.toLowerCase();
  if (proposalId === undefined || payloadHash === undefined) return undefined;
  return { proposalId, payloadHash };
}

/**
 * The one confirmation wording the parser is guaranteed to accept.
 *
 * Both the proposal preview and the `approval_required` failure message render
 * this, so the format the owner is shown can never drift from the format the
 * parser accepts. Nothing else may define a confirmation protocol: LIVE-07-A
 * failed because the model invented its own wording, which the parser rejected.
 */
export function buildConfirmationInstruction(proposalId: string, payloadHash: string): string {
  return `确认 ${confirmationCode(proposalId, payloadHash)}`;
}

function confirmationCode(proposalId: string, payloadHash: string): string {
  return createHash("sha256").update(proposalId.toLowerCase() + ":" + payloadHash.toLowerCase()).digest("hex").slice(0, 12);
}

function scopesMatch(left: ConfirmationScope, right: ConfirmationScope): boolean {
  // Correlation aliases never override conflicting identity. Existing proposals
  // without account binding require reproposal through the current live adapter.
  const aliases = (scope: ConfirmationScope, prefix: string) =>
    scope.delivery.filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
  const accountLeft = aliases(left, "account:");
  const accountRight = aliases(right, "account:");
  if (accountLeft.length || accountRight.length) {
    if (accountLeft.length !== 1 || accountRight.length !== 1 || accountLeft[0] !== accountRight[0]) return false;
  }
  const peers = (scope: ConfirmationScope) => [...new Set([
    ...aliases(scope, "target:"), ...aliases(scope, "conversation:"),
  ].map(value => value.replace(/^qqbot:/u, "")))];
  const leftPeers = peers(left), rightPeers = peers(right);
  if (leftPeers.length !== 1 || rightPeers.length !== 1 || leftPeers[0] !== rightPeers[0]) return false;
  const leftSender = aliases(left, "sender:"), rightSender = aliases(right, "sender:");
  if (leftSender.length && rightSender.length && leftSender[0] !== rightSender[0]) return false;
  if (left.primary.startsWith("session:") && right.primary.startsWith("session:") && left.primary !== right.primary) return false;
  return true;
}

function serializeScope(scope: ConfirmationScope): string {
  const normalized = {
    primary: boundedText(scope.primary, "scope.primary", MAX_SCOPE_VALUE_LENGTH),
    delivery: uniqueStrings(scope.delivery).map((value) => boundedText(value, "scope.delivery", MAX_SCOPE_VALUE_LENGTH)),
  };
  return JSON.stringify(normalized);
}

function parseScope(value: string): ConfirmationScope {
  try {
    const parsed = JSON.parse(value) as { primary?: unknown; delivery?: unknown };
    if (typeof parsed.primary !== "string") throw new Error("scope.primary missing");
    const delivery = Array.isArray(parsed.delivery)
      ? parsed.delivery.filter((item): item is string => typeof item === "string")
      : [];
    return { primary: parsed.primary, delivery };
  } catch {
    return { primary: "invalid", delivery: [] };
  }
}

function normalizedContent(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f-\u009f]/gu, " ").replace(/\s+/gu, " ").trim();
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.length > 0)))];
}

function boundedText(value: string, name: string, maxLength: number): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maxLength) {
    throw new TypeError(`${name} is outside the allowed length`);
  }
  return value;
}

function assertHash(value: string): string {
  if (typeof value !== "string" || !HASH_PATTERN.test(value)) throw new TypeError("payloadHash must be a SHA-256 hex digest");
  return value.toLowerCase();
}

function assertUnixSeconds(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError("timestamp must be a non-negative integer");
  return value;
}
