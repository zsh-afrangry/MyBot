import { scopeFromToolContext } from "@kurumi/confirmation-core";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  commitPlanningProposal,
  getPlanningState,
  formatPlanningDateTime,
  proposePlanningChange,
} from "./planning.js";
import { WeatherStore } from "./store.js";

const CONFIRMATION_SCOPE = scopeFromToolContext({ messageChannel: "qqbot", senderIsOwner: true,
  deliveryContext: { to: "qqbot:c2c:test-owner", accountId: "default" } })!;
const NOW = Math.floor(Date.now() / 1000);
const FUTURE_ARRIVAL_EARLIEST = new Date(
  (NOW + 2 * 24 * 60 * 60) * 1000,
).toISOString();
const FUTURE_ARRIVAL_LATEST = new Date(
  (NOW + 2 * 24 * 60 * 60 + 2 * 60 * 60) * 1000,
).toISOString();
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("P2 planning slice", () => {
  it("displays proposal expiry across the UTC/local date boundary without changing frozen facts", () => {
    const { store, databasePath } = createStore(1787761008 - 86400);
    try {
      const result = proposePlanningChange(store, { schema_version: 1, request: {
        kind: "trip.create", destination: { text: "南京" }, transport_mode: "rail", weather_mode: "none",
      } }, CONFIRMATION_SCOPE);
      assert.equal(result.ok, true);
      if (!result.ok) return;
      const display = { utc: "2026-08-26T16:16:48.000Z", local: "2026-08-27T00:16:48+08:00", timezone: "Asia/Shanghai" };
      expect(result.expiresAtDisplay).toEqual(display);
      expect(result.previewText).toContain(`提案确认截止：${display.local}`);
      expect(getPlanningState(store).pendingProposals[0]?.expiresAtDisplay).toEqual(display);
      const db = new DatabaseSync(databasePath, { readOnly: true });
      try {
        const row = db.prepare("SELECT expires_at_utc,payload_hash,payload_json FROM change_proposals WHERE proposal_id=?").get(result.proposalId) as { expires_at_utc: number; payload_hash: string; payload_json: string };
        expect(row.expires_at_utc).toBe(1787761008);
        expect(row.payload_hash).toBe(result.payloadHash);
        expect(row.payload_json).not.toContain("expiresAtDisplay");
        expect(countRows(db, "trips")).toBe(0);
      } finally { db.close(); }
    } finally { store.close(); }
  });
  it("renders the observed flight on August 15 in Shanghai and handles timezone date boundaries", () => {
    expect(formatPlanningDateTime(1786753500, "Asia/Shanghai")).toBe("2026-08-15T08:25:00+08:00");
    expect(formatPlanningDateTime(1786762200, "Asia/Shanghai")).toBe("2026-08-15T10:50:00+08:00");
    expect(formatPlanningDateTime(1786753500, "America/New_York")).toBe("2026-08-14T20:25:00-04:00");
    expect(formatPlanningDateTime(1786753500, "UTC")).toBe("2026-08-15T00:25:00+00:00");
    expect(formatPlanningDateTime(null, "Asia/Shanghai")).toBeNull();
  });
  it("returns a minimized state with the confirmed Tianhe default", () => {
    const { store } = createStore();
    try {
      const state = getPlanningState(store);
      expect(state.ok).toBe(true);
      expect(state.profile.currentLocation).toEqual({
        displayName: "广东省广州市天河区",
        countryCode: "CN",
        timezone: "Asia/Shanghai",
        precision: "district",
      });
      expect(state.profile.currentLocationSource).toBe("migrated_from_weather_default");
      expect(state.weather.effectiveSource).toBe("current_location");
      expect(state.weather.dailyBrief.localTime).toBe("10:30");
      expect(state.trips).toEqual([]);
      expect(state.pendingProposals).toEqual([]);
      expect(state.capabilities.proposalCommit).toBe(true);
      expect(JSON.stringify(state)).not.toContain("latitude");
      expect(JSON.stringify(state)).not.toContain("qweatherLocationId");
    } finally {
      store.close();
    }
  });

  it("persists a typed pending proposal without committing business state", () => {
    const { store, databasePath } = createStore();
    try {
      const result = proposePlanningChange(store, {
        schema_version: 1,
        request: {
          kind: "trip.create",
          destination: { text: "无锡", administrative_area: "江苏省" },
          transport_mode: "air",
        },
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      expect(result.status).toBe("pending");
      expect(result.kind).toBe("trip_create");
      expect(result.payloadHash).toMatch(/^[a-f0-9]{64}$/u);
      expect(result.requiresConfirmation).toBe(true);
      expect(result.derivedEffects).toEqual([]);
      expect(result.missingFields).toEqual(["destination_place", "arrival_time_window"]);
      expect(result.previewText).toContain("不修改地点");
      expect(result.previewText).not.toContain("后续版本");

      const state = getPlanningState(store);
      expect(state.pendingProposals).toHaveLength(1);
      expect(state.pendingProposals[0]?.proposalId).toBe(result.proposalId);

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(countRows(database, "change_proposals")).toBe(1);
        expect(countRows(database, "trips")).toBe(0);
        expect(countRows(database, "location_periods")).toBe(0);
        expect(countRows(database, "notification_preferences")).toBe(1);
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it("rejects unknown fields, unsupported requests, and invalid windows", () => {
    const { store } = createStore();
    try {
      const unknown = proposePlanningChange(store, {
        schema_version: 1,
        request: {
          kind: "trip.create",
          destination: { text: "无锡" },
          effects: [{ action: "location_set" }],
        },
      });
      expect(unknown).toMatchObject({ ok: false, error: { code: "invalid_input" } });

      const unsupported = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "location.set", destination: { text: "无锡" } },
      });
      expect(unsupported).toMatchObject({ ok: false, error: { code: "unsupported_request" } });

      const invalidWindow = proposePlanningChange(store, {
        schema_version: 1,
        request: {
          kind: "trip.create",
          destination: { text: "无锡" },
          arrival: {
            earliest: "2026-08-16T18:00:00+08:00",
            latest: "2026-08-16T17:00:00+08:00",
            precision: "exact",
            timezone: "Asia/Shanghai",
          },
        },
      });
      expect(invalidWindow).toMatchObject({ ok: false, error: { code: "invalid_input" } });
    } finally {
      store.close();
    }
  });

  it("commits an exact pending proposal once, preserves unresolved destination text, and audits it", () => {
    const { store, databasePath } = createStore();
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: {
          kind: "trip.create",
          title: "无锡出行",
          destination: { text: "无锡", administrative_area: "江苏省" },
          transport_mode: "air",
          arrival: {
            earliest: FUTURE_ARRIVAL_EARLIEST,
            latest: FUTURE_ARRIVAL_LATEST,
            precision: "window",
            timezone: "Asia/Shanghai",
          },
          weather_mode: "switch_at_arrival",
        },
      }, CONFIRMATION_SCOPE);
      assert.equal(proposal.ok, true);
      if (!proposal.ok) return;

      expect(store.recordInboundConfirmation({
        channel: "qqbot",
        conversationId: "qqbot:c2c:test-owner",
        accountId: "default",
        messageId: "planning-confirm-1",
        content: `确认 ${proposal.proposalId} ${proposal.payloadHash}`,
        isGroup: false,
        senderIsOwner: true,
      })).toBe(true);

      const committed = commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, CONFIRMATION_SCOPE);
      assert.equal(committed.ok, true);
      if (!committed.ok) return;
      expect(committed.status).toBe("committed");
      expect(committed.idempotent).toBe(false);
      expect(committed.trip).toMatchObject({
        title: "无锡出行",
        state: "planned",
        destinationText: "无锡",
        destinationAdministrativeArea: "江苏省",
        destinationDisplayName: null,
        transportMode: "air",
        weatherMode: "switch_at_arrival",
      });
      expect(committed.locationPeriodCreated).toBe(false);
      expect(committed.weatherLocationChanged).toBe(false);

      const state = getPlanningState(store);
      expect(state.trips).toHaveLength(1);
      expect(state.trips[0]?.displayTimes).toMatchObject({
        timezone: "Asia/Shanghai", timezoneSource: "profile.currentLocation",
        departureEarliest: null, departureLatest: null,
        arrivalEarliest: formatPlanningDateTime(Date.parse(FUTURE_ARRIVAL_EARLIEST) / 1000, "Asia/Shanghai"),
        arrivalLatest: formatPlanningDateTime(Date.parse(FUTURE_ARRIVAL_LATEST) / 1000, "Asia/Shanghai"),
      });
      expect(state.pendingProposals).toEqual([]);
      expect(store.getEffectivePlace(NOW).source).toBe("current_location");

      const retried = commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      }, CONFIRMATION_SCOPE);
      expect(retried).toMatchObject({ ok: true, idempotent: true, trip: { id: committed.trip.id } });

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(countRows(database, "trips")).toBe(1);
        expect(countRows(database, "location_periods")).toBe(0);
        expect(
          database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'trip.committed'").get(),
        ).toEqual({ count: 1 });
      } finally {
        database.close();
      }
    } finally {
      store.close();
    }
  });

  it("rolls back a planning repository write when the service transaction fails", () => {
    const { store } = createStore();
    try {
      const originPlaceId = store.getDefaultPlace().id;
      expect(() => store.withPlanningTransaction((repository) => {
        repository.insertPlannedTrip({
          proposalId: "00000000-0000-4000-8000-000000000001",
          payloadHash: "0".repeat(64),
          title: "事务回滚验证行程",
          originPlaceId,
          destinationText: "无锡",
          destinationAdministrativeArea: "江苏省",
          transportMode: "air",
          departure: null,
          arrival: null,
          weatherMode: "none",
          sourceSummary: "测试事务失败时不保留行程。",
        }, NOW);
        throw new Error("intentional planning transaction failure");
      })).toThrow("intentional planning transaction failure");

      expect(getPlanningState(store).trips).toEqual([]);
    } finally {
      store.close();
    }
  });

  it("rejects a mismatched hash and expires an outdated proposal without creating a trip", () => {
    let now = NOW;
    const root = mkdtempSync(join(tmpdir(), "personal-weather-planning-expiry-"));
    temporaryRoots.push(root);
    const store = new WeatherStore({ stateDirectory: join(root, "state"), now: () => now });
    try {
      const proposal = proposePlanningChange(store, {
        schema_version: 1,
        request: { kind: "trip.create", destination: { text: "无锡" } },
      });
      assert.equal(proposal.ok, true);
      if (!proposal.ok) return;

      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: "0".repeat(64),
      })).toMatchObject({ ok: false, error: { code: "proposal_hash_mismatch" } });

      now += 24 * 60 * 60;
      expect(commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      })).toMatchObject({ ok: false, error: { code: "proposal_expired" } });
      expect(getPlanningState(store).trips).toEqual([]);
    } finally {
      store.close();
    }
  });
});

function createStore(nowUtc = NOW): { store: WeatherStore; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "personal-weather-planning-"));
  temporaryRoots.push(root);
  const store = new WeatherStore({ stateDirectory: join(root, "state"), now: () => nowUtc });
  return { store, databasePath: store.databasePath };
}

function countRows(database: DatabaseSync, tableName: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}
