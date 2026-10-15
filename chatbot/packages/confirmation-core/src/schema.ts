import type { DatabaseSync } from "node:sqlite";

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

export function ensureConfirmationGateSchema(database: DatabaseSync): void {
  database.exec(CONFIRMATION_GATE_SCHEMA_SQL);
}
