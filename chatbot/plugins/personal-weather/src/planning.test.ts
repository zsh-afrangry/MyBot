import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
  commitPlanningProposal,
  getPlanningState,
  proposePlanningChange,
} from "./planning.js";
import { WeatherStore } from "./store.js";

const NOW = Math.floor(Date.now() / 1000);
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("P2 planning slice", () => {
  it("returns a minimized state with the confirmed Tianhe default", () => {
    const { store } = createStore();
    try {
      const state = getPlanningState(store);
      expect(state.ok).toBe(true);
      expect(state.weather.defaultPlace).toEqual({
        displayName: "广东省广州市天河区",
        countryCode: "CN",
        timezone: "Asia/Shanghai",
        precision: "district",
      });
      expect(state.weather.effectiveSource).toBe("default");
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
            earliest: "2026-08-16T14:00:00+08:00",
            latest: "2026-08-16T16:00:00+08:00",
            precision: "window",
            timezone: "Asia/Shanghai",
          },
          weather_mode: "switch_at_arrival",
        },
      });
      assert.equal(proposal.ok, true);
      if (!proposal.ok) return;

      const committed = commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      });
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
      expect(state.pendingProposals).toEqual([]);
      expect(store.getEffectivePlace(NOW).source).toBe("default");

      const retried = commitPlanningProposal(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      });
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

function createStore(): { store: WeatherStore; databasePath: string } {
  const root = mkdtempSync(join(tmpdir(), "personal-weather-planning-"));
  temporaryRoots.push(root);
  const store = new WeatherStore({ stateDirectory: join(root, "state"), now: () => NOW });
  return { store, databasePath: store.databasePath };
}

function countRows(database: DatabaseSync, tableName: string): number {
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as { count: number };
  return row.count;
}
