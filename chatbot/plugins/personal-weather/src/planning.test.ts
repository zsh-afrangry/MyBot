import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";

import {
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

describe("P2A planning slice", () => {
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
      expect(state.capabilities.proposalCommit).toBe(false);
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
