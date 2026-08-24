import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  commitProfileChange,
  getProfileState,
  proposeProfileChange,
} from "./profile.js";
import type { QWeatherClient } from "./qweather-client.js";
import { WeatherStore } from "./store.js";
import { geoLookupFixture } from "./test-fixtures.js";

const NOW = 1_786_032_000;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("Profile P0 current_location", () => {
  it("seeds the Profile current location from the confirmed legacy weather default", () => {
    const { store } = createStore();
    try {
      const profile = getProfileState(store);
      expect(profile.currentLocation).toMatchObject({
        displayName: "广东省广州市天河区",
        source: "migrated_from_weather_default",
        confirmedAtUtc: NOW,
      });
      expect(profile.capabilities).toMatchObject({
        currentLocationChange: true,
        arbitraryFieldChange: false,
        homeLocation: false,
        tripArrivalAutoUpdate: false,
      });
      expect(store.getEffectivePlace(NOW)).toMatchObject({
        source: "current_location",
        place: { displayName: "广东省广州市天河区" },
      });
    } finally {
      store.close();
    }
  });

  it("previews then commits a confirmed current location without changing weather preferences or trips", async () => {
    const { store, databasePath } = createStore();
    try {
      const proposal = await proposeProfileChange(store, client(yangzhongFixture), {
        schema_version: 1,
        request: {
          kind: "current_location.set",
          location: { text: "扬中市", administrative_area: "镇江市" },
        },
      });
      assert.equal(proposal.ok, true);
      if (!proposal.ok || proposal.status !== "pending") return;
      expect(proposal.canonicalFacts.currentLocation).toMatchObject({
        displayName: "江苏省镇江市扬中",
        timezone: "Asia/Shanghai",
      });
      expect(proposal.previewText).toContain("广东省广州市天河区 → 江苏省镇江市扬中");
      expect(store.getCurrentLocation().place.displayName).toBe("广东省广州市天河区");

      const beforeCommit = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(countRows(beforeCommit, "change_proposals")).toBe(1);
        expect(countRows(beforeCommit, "profile_current_location")).toBe(1);
        expect(countRows(beforeCommit, "trips")).toBe(0);
        expect(countRows(beforeCommit, "location_periods")).toBe(0);
      } finally {
        beforeCommit.close();
      }

      const committed = commitProfileChange(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      });
      assert.equal(committed.ok, true);
      if (!committed.ok) return;
      expect(committed.idempotent).toBe(false);
      expect(committed.currentLocation).toMatchObject({
        displayName: "江苏省镇江市扬中",
        source: "owner_confirmed",
        confirmedAtUtc: NOW,
      });
      expect(store.getCurrentLocation().place.displayName).toBe("江苏省镇江市扬中");
      expect(store.getEffectivePlace(NOW)).toMatchObject({
        source: "current_location",
        place: { displayName: "江苏省镇江市扬中" },
      });
      // The legacy weather preference remains untouched; Profile is now the
      // source used by effective-location reads.
      expect(store.getDefaultPlace().displayName).toBe("广东省广州市天河区");

      const repeated = commitProfileChange(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      });
      expect(repeated).toMatchObject({ ok: true, idempotent: true });

      const afterCommit = new DatabaseSync(databasePath, { readOnly: true });
      try {
        expect(countRows(afterCommit, "trips")).toBe(0);
        expect(countRows(afterCommit, "location_periods")).toBe(0);
        expect(countRows(afterCommit, "audit_log")).toBe(1);
        const revision = afterCommit.prepare(
          "SELECT revision FROM profile_current_location WHERE subject_id = 'owner'",
        ).get() as { revision: number };
        expect(revision.revision).toBe(2);
      } finally {
        afterCommit.close();
      }
    } finally {
      store.close();
    }
  });

  it("requires a clarification for ambiguous locations and does not create a proposal", async () => {
    const { store } = createStore();
    try {
      const result = await proposeProfileChange(store, client({
        ...geoLookupFixture,
        location: [
          { ...geoLookupFixture.location[0], name: "朝阳", id: "101010300", adm1: "北京市", adm2: "北京市" },
          { ...geoLookupFixture.location[0], name: "朝阳", id: "101060106", adm1: "吉林省", adm2: "长春市" },
        ],
      }), {
        schema_version: 1,
        request: { kind: "current_location.set", location: { text: "朝阳区" } },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "location_ambiguous" },
      });
      if (result.ok) return;
      expect(result.candidates).toHaveLength(2);
      expect(store.listPendingProposals()).toEqual([]);
      expect(store.getCurrentLocation().place.displayName).toBe("广东省广州市天河区");
    } finally {
      store.close();
    }
  });

  it("rejects an unresolvable location without falling back to the current location", async () => {
    const { store } = createStore();
    try {
      const result = await proposeProfileChange(store, client({
        ...geoLookupFixture,
        code: "404",
        location: [],
      }), {
        schema_version: 1,
        request: { kind: "current_location.set", location: { text: "不存在地点20260823" } },
      });
      expect(result).toMatchObject({
        ok: false,
        error: { code: "location_not_found" },
      });
      expect(store.listPendingProposals()).toEqual([]);
      expect(store.getCurrentLocation().place.displayName).toBe("广东省广州市天河区");
    } finally {
      store.close();
    }
  });

  it("rejects an altered proposal hash before mutating the Profile", async () => {
    const { store } = createStore();
    try {
      const proposal = await proposeProfileChange(store, client(yangzhongFixture), {
        schema_version: 1,
        request: { kind: "current_location.set", location: { text: "扬中市" } },
      });
      assert.equal(proposal.ok, true);
      if (!proposal.ok || proposal.status !== "pending") return;

      const result = commitProfileChange(store, {
        proposal_id: proposal.proposalId,
        payload_hash: "0".repeat(64),
      });
      expect(result).toMatchObject({ ok: false, error: { code: "proposal_hash_mismatch" } });
      expect(store.getCurrentLocation().place.displayName).toBe("广东省广州市天河区");
    } finally {
      store.close();
    }
  });

  it("expires an unconfirmed location proposal without mutating the Profile", async () => {
    let now = NOW;
    const root = mkdtempSync(join(tmpdir(), "personal-profile-expiry-test-"));
    temporaryRoots.push(root);
    const store = new WeatherStore({ stateDirectory: join(root, "state"), now: () => now });
    try {
      const proposal = await proposeProfileChange(store, client(yangzhongFixture), {
        schema_version: 1,
        request: { kind: "current_location.set", location: { text: "扬中市" } },
      });
      assert.equal(proposal.ok, true);
      if (!proposal.ok || proposal.status !== "pending") return;

      now += 24 * 60 * 60;
      const result = commitProfileChange(store, {
        proposal_id: proposal.proposalId,
        payload_hash: proposal.payloadHash,
      });
      expect(result).toMatchObject({ ok: false, error: { code: "proposal_expired" } });
      expect(store.getCurrentLocation().place.displayName).toBe("广东省广州市天河区");
      expect(store.listPendingProposals()).toEqual([]);
    } finally {
      store.close();
    }
  });
});

const yangzhongFixture = {
  ...geoLookupFixture,
  location: [
    {
      ...geoLookupFixture.location[0],
      name: "扬中",
      id: "101190704",
      lat: "32.2373",
      lon: "119.8281",
      adm1: "江苏省",
      adm2: "镇江市",
      type: "city",
    },
  ],
};

function client(payload: unknown): QWeatherClient {
  return {
    lookupPlace: vi.fn(async () => payload),
  } as unknown as QWeatherClient;
}

function createStore() {
  const root = mkdtempSync(join(tmpdir(), "personal-profile-test-"));
  temporaryRoots.push(root);
  return {
    store: new WeatherStore({ stateDirectory: join(root, "state"), now: () => NOW }),
    databasePath: join(root, "state", "weather.sqlite"),
  };
}

function countRows(database: DatabaseSync, table: string): number {
  return Number((database.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as { count: number }).count);
}
