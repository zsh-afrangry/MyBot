import { DatabaseSync } from "node:sqlite";

import {
  checkApprovalGrant,
  markConfirmationProposalCommitted,
  markConfirmationProposalExpired,
  type ConfirmationGrantCheck,
  type ConfirmationScope,
} from "./confirmation-gate.js";
import type { UnixSeconds } from "./store.js";
import type { ProfileLocationRecord } from "./weather-location.js";

export interface LocationSetProposalForCommit {
  proposalId: string;
  kind: "location_set";
  status: "pending" | "committed" | "cancelled" | "expired" | "rejected";
  payloadJson: string;
  payloadHash: string;
  requestContextHash: string | null;
  expiresAtUtc: UnixSeconds;
  resultPlaceId: number | null;
}

/**
 * Persistence-only adapter for the Profile domain. It owns neither natural
 * language interpretation nor confirmation policy; callers pass frozen,
 * validated values inside WeatherStore.withProfileTransaction().
 */
export class ProfileRepository {
  readonly #database: DatabaseSync;
  readonly #subjectId: string;

  constructor(input: { database: DatabaseSync; subjectId: string }) {
    this.#database = input.database;
    this.#subjectId = input.subjectId;
  }

  getLocationSetProposal(proposalId: string): LocationSetProposalForCommit | undefined {
    const row = this.#database.prepare(`
      SELECT proposal_id, kind, status, payload_json, payload_hash,
             request_context_hash, expires_at_utc, result_entity_type, result_entity_id
      FROM change_proposals
      WHERE proposal_id = ? AND subject_id = ? AND kind = 'location_set'
      LIMIT 1
    `).get(proposalId, this.#subjectId) as ProposalRow | undefined;
    if (!row) return undefined;

    return {
      proposalId: row.proposal_id,
      kind: row.kind,
      status: row.status,
      payloadJson: row.payload_json,
      payloadHash: row.payload_hash,
      requestContextHash: row.request_context_hash,
      expiresAtUtc: row.expires_at_utc,
      resultPlaceId: row.result_entity_type === "profile_current_location"
        ? row.result_entity_id
        : null,
    };
  }

  expirePendingProposal(proposalId: string, atUtc: UnixSeconds): boolean {
    const changed = Number(this.#database.prepare(`
      UPDATE change_proposals
      SET status = 'expired', updated_at_utc = ?
      WHERE proposal_id = ? AND subject_id = ? AND kind = 'location_set' AND status = 'pending'
    `).run(atUtc, proposalId, this.#subjectId).changes) === 1;
    if (changed) {
      markConfirmationProposalExpired(this.#database, {
        proposalId,
        subjectId: this.#subjectId,
        atUtc,
      });
    }
    return changed;
  }

  checkApprovalGrant(input: {
    proposalId: string;
    payloadHash: string;
    scope: ConfirmationScope;
    atUtc: UnixSeconds;
    consume: boolean;
  }): ConfirmationGrantCheck {
    return checkApprovalGrant(this.#database, {
      proposalId: input.proposalId,
      domain: "personal_profile",
      subjectId: this.#subjectId,
      payloadHash: input.payloadHash,
      scope: input.scope,
      nowUtc: input.atUtc,
      consume: input.consume,
    });
  }

  markConfirmationProposalCommitted(proposalId: string, atUtc: UnixSeconds): void {
    markConfirmationProposalCommitted(this.#database, {
      proposalId,
      subjectId: this.#subjectId,
      atUtc,
    });
  }

  /** Reuse a known QWeather place rather than inserting duplicate coordinates. */
  upsertConfirmedPlace(input: ProfileLocationRecord, atUtc: UnixSeconds): number {
    const existing = this.#database.prepare(`
      SELECT id
      FROM places
      WHERE qweather_location_id = ?
      LIMIT 1
    `).get(input.qweatherLocationId) as { id: number } | undefined;
    if (existing) return existing.id;

    const inserted = this.#database.prepare(`
      INSERT INTO places (
        place_key, display_name, country_code, adm1, adm2, district, locality_name,
        latitude, longitude, timezone, precision, qweather_location_id, source,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'owner_confirmed', ?, ?)
    `).run(
      input.placeKey,
      input.displayName,
      input.countryCode,
      input.adm1,
      input.adm2,
      input.district,
      input.localityName,
      input.latitude,
      input.longitude,
      input.timezone,
      input.precision,
      input.qweatherLocationId,
      atUtc,
      atUtc,
    );
    const placeId = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(placeId) || placeId < 1) {
      throw new Error("Profile place insert did not return a valid id");
    }
    return placeId;
  }

  replaceCurrentLocation(input: {
    placeId: number;
    sourceSummary: string;
    atUtc: UnixSeconds;
  }): void {
    const changes = Number(this.#database.prepare(`
      UPDATE profile_current_location
      SET place_id = ?,
          source_kind = 'owner_text',
          source_summary = ?,
          revision = revision + 1,
          confirmed_at_utc = ?,
          updated_at_utc = ?
      WHERE subject_id = ?
    `).run(
      input.placeId,
      input.sourceSummary,
      input.atUtc,
      input.atUtc,
      this.#subjectId,
    ).changes);
    if (changes !== 1) {
      throw new Error("Profile current location record is unavailable");
    }
  }

  markProposalCommitted(input: {
    proposalId: string;
    payloadHash: string;
    placeId: number;
    atUtc: UnixSeconds;
  }): boolean {
    return Number(this.#database.prepare(`
      UPDATE change_proposals
      SET status = 'committed',
          result_entity_type = 'profile_current_location',
          result_entity_id = ?,
          committed_at_utc = ?,
          updated_at_utc = ?
      WHERE proposal_id = ?
        AND subject_id = ?
        AND kind = 'location_set'
        AND status = 'pending'
        AND payload_hash = ?
        AND expires_at_utc > ?
    `).run(
      input.placeId,
      input.atUtc,
      input.atUtc,
      input.proposalId,
      this.#subjectId,
      input.payloadHash,
      input.atUtc,
    ).changes) === 1;
  }

  insertOwnerAudit(input: {
    action: string;
    entityType: string;
    entityId: string | null;
    proposalId: string | null;
    summaryJson: string;
    atUtc: UnixSeconds;
  }): void {
    this.#database.prepare(`
      INSERT INTO audit_log (
        subject_id, actor_kind, action, entity_type, entity_id, proposal_id,
        change_summary_json, created_at_utc
      ) VALUES (?, 'owner', ?, ?, ?, ?, ?, ?)
    `).run(
      this.#subjectId,
      input.action,
      input.entityType,
      input.entityId,
      input.proposalId,
      input.summaryJson,
      input.atUtc,
    );
  }
}

type ProposalRow = {
  proposal_id: string;
  kind: LocationSetProposalForCommit["kind"];
  status: LocationSetProposalForCommit["status"];
  payload_json: string;
  payload_hash: string;
  request_context_hash: string | null;
  expires_at_utc: number;
  result_entity_type: string | null;
  result_entity_id: number | null;
};
