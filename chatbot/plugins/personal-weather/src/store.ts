import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { PlanningRepository } from "./planning-repository.js";

const DATABASE_FILE_NAME = "weather.sqlite";
/** Internal subject key for this single-owner deployment. */
export const OWNER_SUBJECT_ID = "owner";
const LATEST_SCHEMA_VERSION = 2;
// Keep this as a string: SQLite's maximum signed integer is larger than
// JavaScript's Number.MAX_SAFE_INTEGER, and the value is interpolated into SQL.
const SQLITE_MAX_INTEGER_LITERAL = "9223372036854775807";

// Reviewed QWeather LocationList metadata for Tianhe. These district-level
// coordinates are sufficient for weather lookup without storing a home address
// or precise GPS. The preferences seed, rather than this metadata source, records
// that the owner confirmed Tianhe as the default place.
const DEFAULT_PLACE = {
  placeKey: "cn:guangdong:guangzhou:tianhe:district-centre",
  displayName: "广东省广州市天河区",
  countryCode: "CN",
  adm1: "广东省",
  adm2: "广州市",
  district: "天河区",
  latitude: 23.1356,
  longitude: 113.3354,
  timezone: "Asia/Shanghai",
  precision: "district",
  qweatherLocationId: "101280109",
  source: "qweather_location_list",
} as const;

const INITIAL_SCHEMA_SQL = String.raw`
  CREATE TABLE places (
    id INTEGER PRIMARY KEY,
    place_key TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 200),
    country_code TEXT NOT NULL DEFAULT 'CN' CHECK (length(country_code) = 2),
    adm1 TEXT,
    adm2 TEXT,
    district TEXT,
    latitude REAL NOT NULL CHECK (latitude BETWEEN -90.0 AND 90.0),
    longitude REAL NOT NULL CHECK (longitude BETWEEN -180.0 AND 180.0),
    timezone TEXT NOT NULL CHECK (length(timezone) BETWEEN 1 AND 100),
    precision TEXT NOT NULL CHECK (precision IN ('city', 'district', 'point')),
    qweather_location_id TEXT,
    source TEXT NOT NULL CHECK (
      source IN ('qweather', 'qweather_location_list', 'owner_confirmed', 'operator')
    ),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE UNIQUE INDEX places_qweather_location_id_unique
    ON places(qweather_location_id)
    WHERE qweather_location_id IS NOT NULL;

  CREATE TABLE notification_preferences (
    subject_id TEXT PRIMARY KEY,
    default_place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
    daily_enabled INTEGER NOT NULL DEFAULT 1 CHECK (daily_enabled IN (0, 1)),
    daily_minute_of_day INTEGER NOT NULL DEFAULT 630
      CHECK (daily_minute_of_day BETWEEN 0 AND 1439),
    daily_timezone_mode TEXT NOT NULL DEFAULT 'fixed'
      CHECK (daily_timezone_mode IN ('fixed', 'active_place')),
    daily_timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai'
      CHECK (length(daily_timezone) BETWEEN 1 AND 100),
    quiet_start_minute INTEGER CHECK (quiet_start_minute BETWEEN 0 AND 1439),
    quiet_end_minute INTEGER CHECK (quiet_end_minute BETWEEN 0 AND 1439),
    urgent_break_quiet INTEGER NOT NULL DEFAULT 1 CHECK (urgent_break_quiet IN (0, 1)),
    official_alerts_enabled INTEGER NOT NULL DEFAULT 1
      CHECK (official_alerts_enabled IN (0, 1)),
    rain_enabled INTEGER NOT NULL DEFAULT 0 CHECK (rain_enabled IN (0, 1)),
    heat_enabled INTEGER NOT NULL DEFAULT 0 CHECK (heat_enabled IN (0, 1)),
    heat_threshold_c REAL NOT NULL DEFAULT 35.0
      CHECK (heat_threshold_c BETWEEN -50.0 AND 70.0),
    cooldown_minutes INTEGER NOT NULL DEFAULT 120
      CHECK (cooldown_minutes BETWEEN 0 AND 10080),
    travel_dual_city_enabled INTEGER NOT NULL DEFAULT 1
      CHECK (travel_dual_city_enabled IN (0, 1)),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc),
    CHECK (
      (quiet_start_minute IS NULL AND quiet_end_minute IS NULL)
      OR (quiet_start_minute IS NOT NULL AND quiet_end_minute IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE trips (
    id INTEGER PRIMARY KEY,
    subject_id TEXT NOT NULL DEFAULT 'owner',
    title TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
    state TEXT NOT NULL
      CHECK (state IN ('tentative', 'planned', 'in_progress', 'completed', 'cancelled')),
    origin_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
    destination_place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
    transport_mode TEXT NOT NULL DEFAULT 'unknown'
      CHECK (transport_mode IN ('unknown', 'air', 'rail', 'car', 'bus', 'ship', 'other')),
    service_number TEXT CHECK (length(service_number) <= 80),
    departure_earliest_utc INTEGER CHECK (departure_earliest_utc >= 0),
    departure_latest_utc INTEGER CHECK (departure_latest_utc >= 0),
    departure_precision TEXT NOT NULL DEFAULT 'unknown'
      CHECK (departure_precision IN ('unknown', 'date', 'window', 'exact')),
    arrival_earliest_utc INTEGER CHECK (arrival_earliest_utc >= 0),
    arrival_latest_utc INTEGER CHECK (arrival_latest_utc >= 0),
    arrival_precision TEXT NOT NULL DEFAULT 'unknown'
      CHECK (arrival_precision IN ('unknown', 'date', 'window', 'exact')),
    weather_mode TEXT NOT NULL DEFAULT 'none'
      CHECK (weather_mode IN ('none', 'dual_city', 'switch_at_arrival')),
    next_review_at_utc INTEGER CHECK (next_review_at_utc >= 0),
    source_kind TEXT NOT NULL
      CHECK (source_kind IN ('owner_text', 'screenshot_confirmed', 'operator')),
    source_summary TEXT CHECK (length(source_summary) <= 1000),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc),
    CHECK (
      (
        departure_earliest_utc IS NULL
        AND departure_latest_utc IS NULL
        AND departure_precision = 'unknown'
      ) OR (
        departure_earliest_utc IS NOT NULL
        AND departure_latest_utc IS NOT NULL
        AND departure_earliest_utc <= departure_latest_utc
        AND departure_precision <> 'unknown'
      )
    ),
    CHECK (
      (
        arrival_earliest_utc IS NULL
        AND arrival_latest_utc IS NULL
        AND arrival_precision = 'unknown'
      ) OR (
        arrival_earliest_utc IS NOT NULL
        AND arrival_latest_utc IS NOT NULL
        AND arrival_earliest_utc <= arrival_latest_utc
        AND arrival_precision <> 'unknown'
      )
    )
  ) STRICT;

  CREATE INDEX trips_subject_state_index ON trips(subject_id, state, updated_at_utc DESC);

  CREATE TABLE location_periods (
    id INTEGER PRIMARY KEY,
    subject_id TEXT NOT NULL DEFAULT 'owner',
    place_id INTEGER NOT NULL REFERENCES places(id) ON DELETE RESTRICT,
    effective_from_utc INTEGER NOT NULL CHECK (effective_from_utc >= 0),
    effective_until_utc INTEGER CHECK (
      effective_until_utc IS NULL OR effective_until_utc > effective_from_utc
    ),
    basis TEXT NOT NULL CHECK (basis IN ('owner_current', 'trip_schedule', 'manual')),
    trip_id INTEGER REFERENCES trips(id) ON DELETE RESTRICT,
    record_state TEXT NOT NULL DEFAULT 'confirmed'
      CHECK (record_state IN ('confirmed', 'superseded', 'cancelled')),
    source_kind TEXT NOT NULL CHECK (source_kind IN ('owner_text', 'trip', 'operator')),
    source_summary TEXT CHECK (length(source_summary) <= 1000),
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX location_periods_effective_index
    ON location_periods(subject_id, record_state, effective_from_utc DESC);

  CREATE UNIQUE INDEX location_periods_one_open_ended_confirmed
    ON location_periods(subject_id)
    WHERE record_state = 'confirmed' AND effective_until_utc IS NULL;

  CREATE TRIGGER location_periods_no_confirmed_overlap_insert
  BEFORE INSERT ON location_periods
  WHEN NEW.record_state = 'confirmed'
  BEGIN
    SELECT RAISE(ABORT, 'confirmed location period overlaps an existing period')
    WHERE EXISTS (
      SELECT 1
      FROM location_periods AS existing
      WHERE existing.subject_id = NEW.subject_id
        AND existing.record_state = 'confirmed'
        AND existing.effective_from_utc
              < COALESCE(NEW.effective_until_utc, ${SQLITE_MAX_INTEGER_LITERAL})
        AND NEW.effective_from_utc
              < COALESCE(existing.effective_until_utc, ${SQLITE_MAX_INTEGER_LITERAL})
    );
  END;

  CREATE TRIGGER location_periods_no_confirmed_overlap_update
  BEFORE UPDATE OF subject_id, effective_from_utc, effective_until_utc, record_state
    ON location_periods
  WHEN NEW.record_state = 'confirmed'
  BEGIN
    SELECT RAISE(ABORT, 'confirmed location period overlaps an existing period')
    WHERE EXISTS (
      SELECT 1
      FROM location_periods AS existing
      WHERE existing.id <> NEW.id
        AND existing.subject_id = NEW.subject_id
        AND existing.record_state = 'confirmed'
        AND existing.effective_from_utc
              < COALESCE(NEW.effective_until_utc, ${SQLITE_MAX_INTEGER_LITERAL})
        AND NEW.effective_from_utc
              < COALESCE(existing.effective_until_utc, ${SQLITE_MAX_INTEGER_LITERAL})
    );
  END;

  CREATE TABLE change_proposals (
    proposal_id TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (
      kind IN (
        'trip_create',
        'trip_update',
        'trip_cancel',
        'location_set',
        'location_cancel',
        'preferences_update'
      )
    ),
    subject_id TEXT NOT NULL DEFAULT 'owner',
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_hash TEXT NOT NULL CHECK (length(payload_hash) BETWEEN 32 AND 128),
    preview_text TEXT NOT NULL CHECK (length(preview_text) BETWEEN 1 AND 4000),
    base_entity_type TEXT,
    base_entity_id INTEGER,
    base_revision INTEGER CHECK (base_revision >= 1),
    request_context_hash TEXT CHECK (length(request_context_hash) BETWEEN 32 AND 128),
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK (status IN ('pending', 'committed', 'cancelled', 'expired', 'rejected')),
    expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc >= 0),
    result_entity_type TEXT,
    result_entity_id INTEGER,
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    committed_at_utc INTEGER CHECK (committed_at_utc >= created_at_utc),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX change_proposals_pending_index
    ON change_proposals(subject_id, status, expires_at_utc);

  CREATE TABLE audit_log (
    id INTEGER PRIMARY KEY,
    subject_id TEXT NOT NULL DEFAULT 'owner',
    actor_kind TEXT NOT NULL CHECK (actor_kind IN ('owner', 'operator', 'scheduler', 'system')),
    action TEXT NOT NULL CHECK (length(action) BETWEEN 1 AND 100),
    entity_type TEXT NOT NULL CHECK (length(entity_type) BETWEEN 1 AND 100),
    entity_id TEXT,
    proposal_id TEXT REFERENCES change_proposals(proposal_id) ON DELETE SET NULL,
    change_summary_json TEXT NOT NULL CHECK (json_valid(change_summary_json)),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0)
  ) STRICT;

  CREATE INDEX audit_log_entity_index
    ON audit_log(entity_type, entity_id, created_at_utc DESC);

  CREATE TABLE notification_state (
    subject_id TEXT NOT NULL DEFAULT 'owner',
    event_kind TEXT NOT NULL CHECK (length(event_kind) BETWEEN 1 AND 100),
    event_key TEXT NOT NULL CHECK (length(event_key) BETWEEN 1 AND 500),
    place_id INTEGER REFERENCES places(id) ON DELETE RESTRICT,
    payload_hash TEXT CHECK (length(payload_hash) BETWEEN 32 AND 128),
    status TEXT NOT NULL
      CHECK (status IN ('observed', 'notified', 'resolved', 'suppressed', 'failed')),
    first_seen_at_utc INTEGER NOT NULL CHECK (first_seen_at_utc >= 0),
    last_seen_at_utc INTEGER NOT NULL CHECK (last_seen_at_utc >= first_seen_at_utc),
    last_notified_at_utc INTEGER CHECK (last_notified_at_utc >= first_seen_at_utc),
    cooldown_until_utc INTEGER CHECK (cooldown_until_utc >= first_seen_at_utc),
    PRIMARY KEY (subject_id, event_kind, event_key)
  ) STRICT, WITHOUT ROWID;

  CREATE TABLE api_cache (
    cache_key TEXT PRIMARY KEY CHECK (length(cache_key) BETWEEN 1 AND 500),
    endpoint_kind TEXT NOT NULL CHECK (length(endpoint_kind) BETWEEN 1 AND 100),
    place_id INTEGER REFERENCES places(id) ON DELETE CASCADE,
    metadata_tag TEXT CHECK (length(metadata_tag) <= 500),
    payload_hash TEXT CHECK (length(payload_hash) BETWEEN 32 AND 128),
    fetched_at_utc INTEGER NOT NULL CHECK (fetched_at_utc >= 0),
    expires_at_utc INTEGER NOT NULL CHECK (expires_at_utc > fetched_at_utc),
    response_size_bytes INTEGER NOT NULL
      CHECK (response_size_bytes BETWEEN 2 AND 1048576),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    created_at_utc INTEGER NOT NULL CHECK (created_at_utc >= 0),
    updated_at_utc INTEGER NOT NULL CHECK (updated_at_utc >= created_at_utc)
  ) STRICT;

  CREATE INDEX api_cache_expiry_index ON api_cache(expires_at_utc);
`;

export type UnixSeconds = number;

export interface WeatherStoreOptions {
  /** Dedicated state directory. The store enforces mode 0700 on this directory. */
  stateDirectory: string;
  /** Injectable clock for deterministic migrations/tests. Value is Unix seconds. */
  now?: () => UnixSeconds;
}

export interface Place {
  id: number;
  placeKey: string;
  displayName: string;
  countryCode: string;
  adm1: string | null;
  adm2: string | null;
  district: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
  precision: "city" | "district" | "point";
  qweatherLocationId: string | null;
  source: "qweather" | "qweather_location_list" | "owner_confirmed" | "operator";
}

export interface NotificationPreferences {
  subjectId: string;
  defaultPlaceId: number;
  dailyEnabled: boolean;
  dailyMinuteOfDay: number;
  dailyTimezoneMode: "fixed" | "active_place";
  dailyTimezone: string;
  quietStartMinute: number | null;
  quietEndMinute: number | null;
  urgentBreakQuiet: boolean;
  officialAlertsEnabled: boolean;
  rainEnabled: boolean;
  heatEnabled: boolean;
  heatThresholdC: number;
  cooldownMinutes: number;
  travelDualCityEnabled: boolean;
  revision: number;
}

export type EffectivePlace =
  | {
      source: "location_period";
      place: Place;
      locationPeriodId: number;
      effectiveFromUtc: UnixSeconds;
      effectiveUntilUtc: UnixSeconds | null;
    }
  | {
      source: "default";
      place: Place;
      locationPeriodId: null;
      effectiveFromUtc: null;
      effectiveUntilUtc: null;
    };

export interface TripSummary {
  id: number;
  title: string;
  state: "tentative" | "planned" | "in_progress" | "completed" | "cancelled";
  originDisplayName: string | null;
  destinationDisplayName: string | null;
  /** Owner-confirmed destination text, retained until a controlled place lookup resolves it. */
  destinationText: string | null;
  destinationAdministrativeArea: string | null;
  transportMode: "unknown" | "air" | "rail" | "car" | "bus" | "ship" | "other";
  departureEarliestUtc: UnixSeconds | null;
  departureLatestUtc: UnixSeconds | null;
  departurePrecision: "unknown" | "date" | "window" | "exact";
  arrivalEarliestUtc: UnixSeconds | null;
  arrivalLatestUtc: UnixSeconds | null;
  arrivalPrecision: "unknown" | "date" | "window" | "exact";
  weatherMode: "none" | "dual_city" | "switch_at_arrival";
  revision: number;
}

export interface PendingProposalSummary {
  proposalId: string;
  kind:
    | "trip_create"
    | "trip_update"
    | "trip_cancel"
    | "location_set"
    | "location_cancel"
    | "preferences_update";
  status: "pending" | "committed" | "cancelled" | "expired" | "rejected";
  previewText: string;
  payloadHash: string;
  expiresAtUtc: UnixSeconds;
  createdAtUtc: UnixSeconds;
}

export interface CreatedPendingProposal extends PendingProposalSummary {
  requestContextHash: string;
}

/**
 * Internal-only view of a proposal used by the deterministic planning service.
 * This is never returned to the model: it contains the frozen payload that must
 * be hash-checked before a commit can occur.
 */
export interface TripCreateProposalForCommit {
  proposalId: string;
  kind: "trip_create";
  status: "pending" | "committed" | "cancelled" | "expired" | "rejected";
  payloadJson: string;
  payloadHash: string;
  requestContextHash: string | null;
  expiresAtUtc: UnixSeconds;
  resultTripId: number | null;
}

export interface TripCreateCommitInput {
  proposalId: string;
  payloadHash: string;
  title: string;
  originPlaceId: number | null;
  destinationText: string;
  destinationAdministrativeArea: string | null;
  transportMode: TripSummary["transportMode"];
  departure: {
    earliestUtc: UnixSeconds;
    latestUtc: UnixSeconds;
    precision: Exclude<TripSummary["departurePrecision"], "unknown">;
  } | null;
  arrival: {
    earliestUtc: UnixSeconds;
    latestUtc: UnixSeconds;
    precision: Exclude<TripSummary["arrivalPrecision"], "unknown">;
  } | null;
  weatherMode: TripSummary["weatherMode"];
  /** A bounded, non-sensitive explanation generated by the planning policy. */
  sourceSummary: string;
}

export interface CachedApiResponse {
  cacheKey: string;
  endpointKind: string;
  placeId: number | null;
  metadataTag: string | null;
  fetchedAtUtc: UnixSeconds;
  expiresAtUtc: UnixSeconds;
  payload: unknown;
}

type PlaceRow = {
  id: number;
  place_key: string;
  display_name: string;
  country_code: string;
  adm1: string | null;
  adm2: string | null;
  district: string | null;
  latitude: number;
  longitude: number;
  timezone: string;
  precision: Place["precision"];
  qweather_location_id: string | null;
  source: Place["source"];
};

type PreferencesRow = {
  subject_id: string;
  default_place_id: number;
  daily_enabled: number;
  daily_minute_of_day: number;
  daily_timezone_mode: NotificationPreferences["dailyTimezoneMode"];
  daily_timezone: string;
  quiet_start_minute: number | null;
  quiet_end_minute: number | null;
  urgent_break_quiet: number;
  official_alerts_enabled: number;
  rain_enabled: number;
  heat_enabled: number;
  heat_threshold_c: number;
  cooldown_minutes: number;
  travel_dual_city_enabled: number;
  revision: number;
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

type PendingProposalRow = {
  proposal_id: string;
  kind: PendingProposalSummary["kind"];
  status: PendingProposalSummary["status"];
  preview_text: string;
  payload_hash: string;
  expires_at_utc: number;
  created_at_utc: number;
};

type Migration = {
  version: number;
  name: string;
  apply: (database: DatabaseSync, appliedAtUtc: UnixSeconds) => void;
};

const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial_personal_weather_schema",
    apply(database, appliedAtUtc) {
      database.exec(INITIAL_SCHEMA_SQL);

      database.prepare(`
        INSERT INTO places (
          place_key,
          display_name,
          country_code,
          adm1,
          adm2,
          district,
          latitude,
          longitude,
          timezone,
          precision,
          qweather_location_id,
          source,
          created_at_utc,
          updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(place_key) DO NOTHING
      `).run(
        DEFAULT_PLACE.placeKey,
        DEFAULT_PLACE.displayName,
        DEFAULT_PLACE.countryCode,
        DEFAULT_PLACE.adm1,
        DEFAULT_PLACE.adm2,
        DEFAULT_PLACE.district,
        DEFAULT_PLACE.latitude,
        DEFAULT_PLACE.longitude,
        DEFAULT_PLACE.timezone,
        DEFAULT_PLACE.precision,
        DEFAULT_PLACE.qweatherLocationId,
        DEFAULT_PLACE.source,
        appliedAtUtc,
        appliedAtUtc,
      );

      const defaultPlace = database.prepare(
        "SELECT id FROM places WHERE place_key = ?",
      ).get(DEFAULT_PLACE.placeKey) as { id: number } | undefined;

      if (!defaultPlace) {
        throw new Error("Failed to seed the confirmed Guangzhou Tianhe default place");
      }

      database.prepare(`
        INSERT INTO notification_preferences (
          subject_id,
          default_place_id,
          daily_enabled,
          daily_minute_of_day,
          daily_timezone_mode,
          daily_timezone,
          created_at_utc,
          updated_at_utc
        ) VALUES (?, ?, 1, 630, 'fixed', 'Asia/Shanghai', ?, ?)
        ON CONFLICT(subject_id) DO NOTHING
      `).run(OWNER_SUBJECT_ID, defaultPlace.id, appliedAtUtc, appliedAtUtc);
    },
  },
  {
    version: 2,
    name: "trip_destination_text_for_unresolved_places",
    apply(database) {
      // A trip can be confirmed before its destination has been resolved to a
      // QWeather place. Keep the owner's short destination text separately so
      // the committed record remains useful without inventing coordinates.
      database.exec(`
        ALTER TABLE trips
          ADD COLUMN destination_text TEXT CHECK (length(destination_text) BETWEEN 1 AND 200);
        ALTER TABLE trips
          ADD COLUMN destination_administrative_area TEXT
            CHECK (
              destination_administrative_area IS NULL
              OR length(destination_administrative_area) BETWEEN 1 AND 200
            );
      `);
    },
  },
];

export class WeatherStore {
  readonly stateDirectory: string;
  readonly databasePath: string;

  #database: DatabaseSync;
  #closed = false;
  #now: () => UnixSeconds;

  constructor(options: WeatherStoreOptions) {
    this.stateDirectory = prepareStateDirectory(options.stateDirectory);
    this.databasePath = join(this.stateDirectory, DATABASE_FILE_NAME);
    this.#now = options.now ?? currentUnixSeconds;

    prepareDatabaseFile(this.databasePath);
    this.#database = new DatabaseSync(this.databasePath);

    try {
      configureDatabase(this.#database);
      applyMigrations(this.#database, normalizeUnixSeconds(this.#now()));
      // SQLite may adjust the main file while opening/configuring it. Reassert the
      // intended mode after initialization; the containing 0700 directory also
      // protects WAL/SHM sidecars.
      chmodSync(this.databasePath, 0o600);
    } catch (error) {
      this.#database.close();
      this.#closed = true;
      throw error;
    }
  }

  close(): void {
    if (!this.#closed) {
      this.#database.close();
      this.#closed = true;
    }
  }

  getDefaultPlace(subjectId = OWNER_SUBJECT_ID): Place {
    assertSubjectId(subjectId);
    this.#assertOpen();

    const row = this.#database.prepare(`
      SELECT place.*
      FROM notification_preferences AS preferences
      JOIN places AS place ON place.id = preferences.default_place_id
      WHERE preferences.subject_id = ?
    `).get(subjectId) as PlaceRow | undefined;

    if (!row) {
      throw new Error(`No default weather place is configured for subject ${subjectId}`);
    }

    return mapPlace(row);
  }

  getNotificationPreferences(subjectId = OWNER_SUBJECT_ID): NotificationPreferences {
    assertSubjectId(subjectId);
    this.#assertOpen();

    const row = this.#database.prepare(`
      SELECT *
      FROM notification_preferences
      WHERE subject_id = ?
    `).get(subjectId) as PreferencesRow | undefined;

    if (!row) {
      throw new Error(`No notification preferences are configured for subject ${subjectId}`);
    }

    return {
      subjectId: row.subject_id,
      defaultPlaceId: row.default_place_id,
      dailyEnabled: row.daily_enabled === 1,
      dailyMinuteOfDay: row.daily_minute_of_day,
      dailyTimezoneMode: row.daily_timezone_mode,
      dailyTimezone: row.daily_timezone,
      quietStartMinute: row.quiet_start_minute,
      quietEndMinute: row.quiet_end_minute,
      urgentBreakQuiet: row.urgent_break_quiet === 1,
      officialAlertsEnabled: row.official_alerts_enabled === 1,
      rainEnabled: row.rain_enabled === 1,
      heatEnabled: row.heat_enabled === 1,
      heatThresholdC: row.heat_threshold_c,
      cooldownMinutes: row.cooldown_minutes,
      travelDualCityEnabled: row.travel_dual_city_enabled === 1,
      revision: row.revision,
    };
  }

  /**
   * Resolve the weather place at a trusted system timestamp.
   *
   * Confirmed periods use half-open [from, until) semantics. A matching period
   * overrides the configured default place; no model write or timer mutation is
   * needed when a future period becomes effective.
   */
  getEffectivePlace(
    atUtc: UnixSeconds = normalizeUnixSeconds(this.#now()),
    subjectId = OWNER_SUBJECT_ID,
  ): EffectivePlace {
    const normalizedAtUtc = normalizeUnixSeconds(atUtc);
    assertSubjectId(subjectId);
    this.#assertOpen();

    const row = this.#database.prepare(`
      SELECT
        place.*,
        period.id AS location_period_id,
        period.effective_from_utc,
        period.effective_until_utc
      FROM location_periods AS period
      JOIN places AS place ON place.id = period.place_id
      WHERE period.subject_id = ?
        AND period.record_state = 'confirmed'
        AND period.effective_from_utc <= ?
        AND (
          period.effective_until_utc IS NULL
          OR ? < period.effective_until_utc
        )
      ORDER BY period.effective_from_utc DESC, period.id DESC
      LIMIT 1
    `).get(subjectId, normalizedAtUtc, normalizedAtUtc) as
      | (PlaceRow & {
          location_period_id: number;
          effective_from_utc: number;
          effective_until_utc: number | null;
        })
      | undefined;

    if (row) {
      return {
        source: "location_period",
        place: mapPlace(row),
        locationPeriodId: row.location_period_id,
        effectiveFromUtc: row.effective_from_utc,
        effectiveUntilUtc: row.effective_until_utc,
      };
    }

    return {
      source: "default",
      place: this.getDefaultPlace(subjectId),
      locationPeriodId: null,
      effectiveFromUtc: null,
      effectiveUntilUtc: null,
    };
  }

  getNowUtc(): UnixSeconds {
    this.#assertOpen();
    return normalizeUnixSeconds(this.#now());
  }

  listTripSummaries(
    subjectId = OWNER_SUBJECT_ID,
    limit = 10,
  ): TripSummary[] {
    assertSubjectId(subjectId);
    assertListLimit(limit);
    this.#assertOpen();

    const rows = this.#database.prepare(`
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
      WHERE trip.subject_id = ?
      ORDER BY
        CASE trip.state
          WHEN 'in_progress' THEN 0
          WHEN 'planned' THEN 1
          WHEN 'tentative' THEN 2
          ELSE 3
        END,
        COALESCE(trip.arrival_earliest_utc, trip.departure_earliest_utc,
                 ${SQLITE_MAX_INTEGER_LITERAL}) ASC,
        trip.updated_at_utc DESC
      LIMIT ?
    `).all(subjectId, limit) as Array<TripSummaryRow>;

    return rows.map(mapTripSummary);
  }

  /**
   * Exposes a narrowly scoped planning repository inside one SQLite
   * BEGIN IMMEDIATE transaction. Domain services decide policy and effects;
   * this store owns only lifecycle, locking and commit/rollback mechanics.
   */
  withPlanningTransaction<T>(callback: (repository: PlanningRepository) => T): T {
    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(new PlanningRepository({
        database: this.#database,
        subjectId: OWNER_SUBJECT_ID,
      }));
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }
  }

  listPendingProposals(
    subjectId = OWNER_SUBJECT_ID,
    atUtc = this.getNowUtc(),
    limit = 10,
  ): PendingProposalSummary[] {
    assertSubjectId(subjectId);
    assertListLimit(limit);
    const normalizedAtUtc = normalizeUnixSeconds(atUtc);
    this.#assertOpen();

    const rows = this.#database.prepare(`
      SELECT proposal_id, kind, status, preview_text, payload_hash,
             expires_at_utc, created_at_utc
      FROM change_proposals
      WHERE subject_id = ?
        AND status = 'pending'
        AND expires_at_utc > ?
      ORDER BY created_at_utc DESC
      LIMIT ?
    `).all(subjectId, normalizedAtUtc, limit) as Array<PendingProposalRow>;

    return rows.map((row) => ({
      proposalId: row.proposal_id,
      kind: row.kind,
      status: row.status,
      previewText: row.preview_text,
      payloadHash: row.payload_hash,
      expiresAtUtc: row.expires_at_utc,
      createdAtUtc: row.created_at_utc,
    }));
  }

  createPendingProposal(input: {
    kind: "trip_create";
    payloadJson: string;
    previewText: string;
    expiresAtUtc: UnixSeconds;
  }): CreatedPendingProposal {
    if (input.kind !== "trip_create") {
      throw new TypeError("P2A only accepts trip_create proposals");
    }
    assertJsonText(input.payloadJson, "payloadJson", 64 * 1024);
    assertMultilineText(input.previewText, "previewText", 4000);

    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(input.payloadJson) as unknown;
    } catch {
      throw new TypeError("payloadJson must contain valid JSON");
    }
    if (parsedPayload === null || typeof parsedPayload !== "object") {
      throw new TypeError("payloadJson must contain a JSON object");
    }

    const createdAtUtc = this.getNowUtc();
    const expiresAtUtc = normalizeUnixSeconds(input.expiresAtUtc);
    const maximumLifetime = 7 * 24 * 60 * 60;
    if (expiresAtUtc <= createdAtUtc || expiresAtUtc > createdAtUtc + maximumLifetime) {
      throw new TypeError("Proposal expiry must be within seven days");
    }

    const proposalId = randomUUID();
    const payloadHash = createHash("sha256").update(input.payloadJson).digest("hex");
    const requestContextHash = createHash("sha256")
      .update(`${OWNER_SUBJECT_ID}|${input.kind}|${payloadHash}`)
      .digest("hex");

    this.#assertOpen();
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      this.#database.prepare(`
        INSERT INTO change_proposals (
          proposal_id, kind, subject_id, payload_json, payload_hash, preview_text,
          request_context_hash, status, expires_at_utc, created_at_utc, updated_at_utc
        ) VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?)
      `).run(
        proposalId,
        input.kind,
        OWNER_SUBJECT_ID,
        input.payloadJson,
        payloadHash,
        input.previewText,
        requestContextHash,
        expiresAtUtc,
        createdAtUtc,
        createdAtUtc,
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#database.exec("ROLLBACK");
      throw error;
    }

    return {
      proposalId,
      kind: input.kind,
      status: "pending",
      previewText: input.previewText,
      payloadHash,
      expiresAtUtc,
      createdAtUtc,
      requestContextHash,
    };
  }

  getFreshApiCache(
    cacheKey: string,
    atUtc: UnixSeconds = normalizeUnixSeconds(this.#now()),
  ): CachedApiResponse | undefined {
    assertCacheKey(cacheKey);
    const normalizedAtUtc = normalizeUnixSeconds(atUtc);
    this.#assertOpen();

    const row = this.#database.prepare(`
      SELECT cache_key, endpoint_kind, place_id, metadata_tag,
             fetched_at_utc, expires_at_utc, response_json
      FROM api_cache
      WHERE cache_key = ? AND ? < expires_at_utc
    `).get(cacheKey, normalizedAtUtc) as
      | {
          cache_key: string;
          endpoint_kind: string;
          place_id: number | null;
          metadata_tag: string | null;
          fetched_at_utc: number;
          expires_at_utc: number;
          response_json: string;
        }
      | undefined;

    if (!row) {
      return undefined;
    }
    try {
      return {
        cacheKey: row.cache_key,
        endpointKind: row.endpoint_kind,
        placeId: row.place_id,
        metadataTag: row.metadata_tag,
        fetchedAtUtc: row.fetched_at_utc,
        expiresAtUtc: row.expires_at_utc,
        payload: JSON.parse(row.response_json) as unknown,
      };
    } catch {
      this.#database.prepare("DELETE FROM api_cache WHERE cache_key = ?").run(cacheKey);
      return undefined;
    }
  }

  putApiCache(input: {
    cacheKey: string;
    endpointKind: string;
    placeId?: number;
    metadataTag?: string;
    fetchedAtUtc: UnixSeconds;
    expiresAtUtc: UnixSeconds;
    payload: unknown;
  }): void {
    assertCacheKey(input.cacheKey);
    assertShortText(input.endpointKind, "endpointKind", 100);
    if (input.metadataTag !== undefined) {
      assertShortText(input.metadataTag, "metadataTag", 500);
    }
    const fetchedAtUtc = normalizeUnixSeconds(input.fetchedAtUtc);
    const expiresAtUtc = normalizeUnixSeconds(input.expiresAtUtc);
    if (expiresAtUtc <= fetchedAtUtc) {
      throw new TypeError("expiresAtUtc must be later than fetchedAtUtc");
    }
    if (
      input.placeId !== undefined &&
      (!Number.isSafeInteger(input.placeId) || input.placeId < 1)
    ) {
      throw new TypeError("placeId must be a positive integer");
    }

    const responseJson = JSON.stringify(input.payload);
    if (responseJson === undefined) {
      throw new TypeError("API cache payload must be JSON serializable");
    }
    const responseSizeBytes = Buffer.byteLength(responseJson, "utf8");
    if (responseSizeBytes < 2 || responseSizeBytes > 1024 * 1024) {
      throw new TypeError("API cache payload is outside the allowed size range");
    }
    const payloadHash = createHash("sha256").update(responseJson).digest("hex");
    this.#assertOpen();

    this.#database.prepare(`
      INSERT INTO api_cache (
        cache_key, endpoint_kind, place_id, metadata_tag, payload_hash,
        fetched_at_utc, expires_at_utc, response_size_bytes, response_json,
        created_at_utc, updated_at_utc
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        endpoint_kind = excluded.endpoint_kind,
        place_id = excluded.place_id,
        metadata_tag = excluded.metadata_tag,
        payload_hash = excluded.payload_hash,
        fetched_at_utc = excluded.fetched_at_utc,
        expires_at_utc = excluded.expires_at_utc,
        response_size_bytes = excluded.response_size_bytes,
        response_json = excluded.response_json,
        updated_at_utc = excluded.updated_at_utc
    `).run(
      input.cacheKey,
      input.endpointKind,
      input.placeId ?? null,
      input.metadataTag ?? null,
      payloadHash,
      fetchedAtUtc,
      expiresAtUtc,
      responseSizeBytes,
      responseJson,
      fetchedAtUtc,
      fetchedAtUtc,
    );
  }

  deleteExpiredApiCache(
    atUtc: UnixSeconds = normalizeUnixSeconds(this.#now()),
  ): number {
    const normalizedAtUtc = normalizeUnixSeconds(atUtc);
    this.#assertOpen();
    return Number(
      this.#database
        .prepare("DELETE FROM api_cache WHERE expires_at_utc <= ?")
        .run(normalizedAtUtc).changes,
    );
  }

  deleteApiCache(cacheKey: string): boolean {
    assertCacheKey(cacheKey);
    this.#assertOpen();
    return (
      Number(
        this.#database.prepare("DELETE FROM api_cache WHERE cache_key = ?").run(cacheKey)
          .changes,
      ) > 0
    );
  }

  #assertOpen(): void {
    if (this.#closed) {
      throw new Error("WeatherStore is closed");
    }
  }
}

function prepareStateDirectory(inputPath: string): string {
  if (typeof inputPath !== "string" || inputPath.trim().length === 0) {
    throw new TypeError("stateDirectory must be a non-empty path");
  }

  const stateDirectory = resolve(inputPath);
  mkdirSync(stateDirectory, { recursive: true, mode: 0o700 });

  const stateDirectoryStat = lstatSync(stateDirectory);
  if (stateDirectoryStat.isSymbolicLink() || !stateDirectoryStat.isDirectory()) {
    throw new Error("stateDirectory must be a real directory, not a symlink");
  }

  chmodSync(stateDirectory, 0o700);
  return stateDirectory;
}

function prepareDatabaseFile(databasePath: string): void {
  if (existsSync(databasePath)) {
    const databaseStat = lstatSync(databasePath);
    if (databaseStat.isSymbolicLink() || !databaseStat.isFile()) {
      throw new Error("weather.sqlite must be a regular file, not a symlink");
    }
  }

  const noFollow = constants.O_NOFOLLOW ?? 0;
  const createFlags = constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow;
  const existingFlags = constants.O_RDWR | noFollow;
  const fileDescriptor = openSync(
    databasePath,
    existsSync(databasePath) ? existingFlags : createFlags,
    0o600,
  );
  closeSync(fileDescriptor);
  chmodSync(databasePath, 0o600);
}

function configureDatabase(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA synchronous = NORMAL");
  database.exec("PRAGMA busy_timeout = 5000");
  database.exec("PRAGMA secure_delete = ON");
  database.exec("PRAGMA temp_store = MEMORY");
}

function applyMigrations(database: DatabaseSync, appliedAtUtc: UnixSeconds): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      applied_at_utc INTEGER NOT NULL CHECK (applied_at_utc >= 0)
    ) STRICT;
  `);

  const appliedRows = database.prepare(
    "SELECT version, name FROM schema_migrations ORDER BY version",
  ).all() as Array<{ version: number; name: string }>;
  const appliedByVersion = new Map(appliedRows.map((row) => [row.version, row.name]));
  const unknownVersion = appliedRows.find((row) => row.version > LATEST_SCHEMA_VERSION);

  if (unknownVersion) {
    throw new Error(
      `Database schema version ${unknownVersion.version} is newer than supported version ${LATEST_SCHEMA_VERSION}`,
    );
  }

  for (const migration of MIGRATIONS) {
    const appliedName = appliedByVersion.get(migration.version);
    if (appliedName !== undefined) {
      if (appliedName !== migration.name) {
        throw new Error(
          `Migration ${migration.version} name mismatch: database=${appliedName}, code=${migration.name}`,
        );
      }
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      migration.apply(database, appliedAtUtc);
      database.prepare(
        "INSERT INTO schema_migrations(version, name, applied_at_utc) VALUES (?, ?, ?)",
      ).run(migration.version, migration.name, appliedAtUtc);
      database.exec(`PRAGMA user_version = ${migration.version}`);
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }
}

function mapPlace(row: PlaceRow): Place {
  return {
    id: row.id,
    placeKey: row.place_key,
    displayName: row.display_name,
    countryCode: row.country_code,
    adm1: row.adm1,
    adm2: row.adm2,
    district: row.district,
    latitude: row.latitude,
    longitude: row.longitude,
    timezone: row.timezone,
    precision: row.precision,
    qweatherLocationId: row.qweather_location_id,
    source: row.source,
  };

}

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

function currentUnixSeconds(): UnixSeconds {
  return Math.floor(Date.now() / 1000);
}

function normalizeUnixSeconds(value: number): UnixSeconds {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError("UTC timestamp must be a non-negative Unix-seconds integer");
  }
  return value;
}

function assertSubjectId(subjectId: string): void {
  if (
    typeof subjectId !== "string"
    || subjectId.length === 0
    || subjectId.length > 100
  ) {
    throw new TypeError("subjectId must contain between 1 and 100 characters");
  }
}

function assertCacheKey(cacheKey: string): void {
  assertShortText(cacheKey, "cacheKey", 500);
}

function assertListLimit(limit: number): void {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 50) {
    throw new TypeError("limit must be an integer between 1 and 50");
  }
}

function assertJsonText(value: string, name: string, maximumBytes: number): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${name} must be a non-empty string`);
  }
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new TypeError(`${name} exceeds the allowed size`);
  }
  if (/\u0000/u.test(value)) {
    throw new TypeError(`${name} contains an unsafe character`);
  }
}

function assertMultilineText(value: string, name: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must contain safe text between 1 and ${maximum} characters`);
  }
}

function assertShortText(value: string, name: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError(`${name} must contain safe text between 1 and ${maximum} characters`);
  }
}
