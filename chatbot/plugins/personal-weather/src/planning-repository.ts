import { DatabaseSync } from "node:sqlite";

import type {
  TripCreateCommitInput,
  TripCreateProposalForCommit,
  TripSummary,
  UnixSeconds,
} from "./store.js";

/**
 * Persistence-only adapter for the planning domain. It owns neither owner
 * confirmation policy nor effect derivation; callers supply already validated
 * data and use WeatherStore.withPlanningTransaction() for atomic composition.
 */
export class PlanningRepository {
  readonly #database: DatabaseSync;
  readonly #subjectId: string;

  constructor(input: { database: DatabaseSync; subjectId: string }) {
    this.#database = input.database;
    this.#subjectId = input.subjectId;
  }

  getTripCreateProposal(proposalId: string): TripCreateProposalForCommit | undefined {
    const row = this.#database.prepare(`
      SELECT proposal_id, kind, status, payload_json, payload_hash,
             request_context_hash, expires_at_utc, result_entity_type, result_entity_id
      FROM change_proposals
      WHERE proposal_id = ? AND subject_id = ? AND kind = 'trip_create'
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
      resultTripId: row.result_entity_type === "trip" ? row.result_entity_id : null,
    };
  }

  expirePendingProposal(proposalId: string, atUtc: UnixSeconds): boolean {
    return Number(this.#database.prepare(`
      UPDATE change_proposals
      SET status = 'expired', updated_at_utc = ?
      WHERE proposal_id = ? AND subject_id = ? AND kind = 'trip_create' AND status = 'pending'
    `).run(atUtc, proposalId, this.#subjectId).changes) === 1;
  }

  insertPlannedTrip(input: TripCreateCommitInput, atUtc: UnixSeconds): number {
    const inserted = this.#database.prepare(`
      INSERT INTO trips (
        subject_id,
        title,
        state,
        origin_place_id,
        destination_place_id,
        destination_text,
        destination_administrative_area,
        transport_mode,
        departure_earliest_utc,
        departure_latest_utc,
        departure_precision,
        arrival_earliest_utc,
        arrival_latest_utc,
        arrival_precision,
        weather_mode,
        source_kind,
        source_summary,
        created_at_utc,
        updated_at_utc
      ) VALUES (?, ?, 'planned', ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                'owner_text', ?, ?, ?)
    `).run(
      this.#subjectId,
      input.title,
      input.originPlaceId,
      input.destinationText,
      input.destinationAdministrativeArea,
      input.transportMode,
      input.departure?.earliestUtc ?? null,
      input.departure?.latestUtc ?? null,
      input.departure?.precision ?? "unknown",
      input.arrival?.earliestUtc ?? null,
      input.arrival?.latestUtc ?? null,
      input.arrival?.precision ?? "unknown",
      input.weatherMode,
      input.sourceSummary,
      atUtc,
      atUtc,
    );
    const tripId = Number(inserted.lastInsertRowid);
    if (!Number.isSafeInteger(tripId) || tripId < 1) {
      throw new Error("Trip insert did not return a valid id");
    }
    return tripId;
  }

  markProposalCommitted(input: {
    proposalId: string;
    payloadHash: string;
    tripId: number;
    atUtc: UnixSeconds;
  }): boolean {
    return Number(this.#database.prepare(`
      UPDATE change_proposals
      SET status = 'committed',
          result_entity_type = 'trip',
          result_entity_id = ?,
          committed_at_utc = ?,
          updated_at_utc = ?
      WHERE proposal_id = ?
        AND subject_id = ?
        AND kind = 'trip_create'
        AND status = 'pending'
        AND payload_hash = ?
        AND expires_at_utc > ?
    `).run(
      input.tripId,
      input.atUtc,
      input.atUtc,
      input.proposalId,
      this.#subjectId,
      input.payloadHash,
      input.atUtc,
    ).changes) === 1;
  }

  getTripSummary(tripId: number): TripSummary | undefined {
    const row = this.#database.prepare(`
      SELECT
        trip.id,
        trip.title,
        trip.state,
        origin.display_name AS origin_display_name,
        destination.display_name AS destination_display_name,
        trip.destination_text,
        trip.destination_administrative_area,
        trip.transport_mode,
        trip.departure_earliest_utc,
        trip.departure_latest_utc,
        trip.departure_precision,
        trip.arrival_earliest_utc,
        trip.arrival_latest_utc,
        trip.arrival_precision,
        trip.weather_mode,
        trip.revision
      FROM trips AS trip
      LEFT JOIN places AS origin ON origin.id = trip.origin_place_id
      LEFT JOIN places AS destination ON destination.id = trip.destination_place_id
      WHERE trip.id = ? AND trip.subject_id = ?
      LIMIT 1
    `).get(tripId, this.#subjectId) as TripSummaryRow | undefined;
    return row ? mapTripSummary(row) : undefined;
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
  kind: TripCreateProposalForCommit["kind"];
  status: TripCreateProposalForCommit["status"];
  payload_json: string;
  payload_hash: string;
  request_context_hash: string | null;
  expires_at_utc: number;
  result_entity_type: string | null;
  result_entity_id: number | null;
};

type TripSummaryRow = {
  id: number;
  title: string;
  state: TripSummary["state"];
  origin_display_name: string | null;
  destination_display_name: string | null;
  destination_text: string | null;
  destination_administrative_area: string | null;
  transport_mode: TripSummary["transportMode"];
  departure_earliest_utc: number | null;
  departure_latest_utc: number | null;
  departure_precision: TripSummary["departurePrecision"];
  arrival_earliest_utc: number | null;
  arrival_latest_utc: number | null;
  arrival_precision: TripSummary["arrivalPrecision"];
  weather_mode: TripSummary["weatherMode"];
  revision: number;
};

function mapTripSummary(row: TripSummaryRow): TripSummary {
  return {
    id: row.id,
    title: row.title,
    state: row.state,
    originDisplayName: row.origin_display_name,
    destinationDisplayName: row.destination_display_name,
    destinationText: row.destination_text,
    destinationAdministrativeArea: row.destination_administrative_area,
    transportMode: row.transport_mode,
    departureEarliestUtc: row.departure_earliest_utc,
    departureLatestUtc: row.departure_latest_utc,
    departurePrecision: row.departure_precision,
    arrivalEarliestUtc: row.arrival_earliest_utc,
    arrivalLatestUtc: row.arrival_latest_utc,
    arrivalPrecision: row.arrival_precision,
    weatherMode: row.weather_mode,
    revision: row.revision,
  };
}
