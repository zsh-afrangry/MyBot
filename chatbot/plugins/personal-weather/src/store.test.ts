import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, test } from "vitest";

import { WeatherStore } from "./store.js";

const FIXED_NOW = 1_786_032_000;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const temporaryRoot of temporaryRoots.splice(0)) {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test("creates a versioned private database and seeds only the confirmed default place", () => {
  const fixture = createStore();
  const { store, stateDirectory, databasePath } = fixture;

  try {
    assert.equal(statSync(stateDirectory).mode & 0o777, 0o700);
    assert.equal(statSync(databasePath).mode & 0o777, 0o600);

    const place = store.getDefaultPlace();
    assert.equal(place.displayName, "广东省广州市天河区");
    assert.equal(place.precision, "district");
    assert.equal(place.timezone, "Asia/Shanghai");
    assert.equal(place.source, "qweather_location_list");
    assert.equal(place.qweatherLocationId, "101280109");
    assert.ok(Math.abs(place.latitude - 23.1356) < 0.000001);
    assert.ok(Math.abs(place.longitude - 113.3354) < 0.000001);

    const preferences = store.getNotificationPreferences();
    assert.equal(preferences.defaultPlaceId, place.id);
    assert.equal(preferences.dailyEnabled, true);
    assert.equal(preferences.dailyMinuteOfDay, 630);
    assert.equal(preferences.dailyTimezoneMode, "fixed");
    assert.equal(preferences.dailyTimezone, "Asia/Shanghai");

    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const tableNames = database.prepare(`
        SELECT name
        FROM sqlite_schema
        WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
        ORDER BY name
      `).all().map((row) => (row as { name: string }).name);

      assert.deepEqual(tableNames, [
        "api_cache",
        "audit_log",
        "change_proposals",
        "location_periods",
        "notification_preferences",
        "notification_state",
        "places",
        "schema_migrations",
        "trips",
      ]);

      assert.equal(queryCount(database, "places"), 1);
      assert.equal(queryCount(database, "notification_preferences"), 1);
      assert.equal(queryCount(database, "trips"), 0);
      assert.equal(queryCount(database, "location_periods"), 0);
      assert.equal(queryCount(database, "change_proposals"), 0);

      const migrations = database.prepare(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      ).all().map((row) => ({
        version: (row as { version: number }).version,
        name: (row as { name: string }).name,
      }));
      assert.deepEqual(migrations, [
        { version: 1, name: "initial_personal_weather_schema" },
        { version: 2, name: "trip_destination_text_for_unresolved_places" },
      ]);
      const tripColumns = database.prepare("PRAGMA table_info(trips)").all()
        .map((row) => (row as { name: string }).name);
      assert.ok(tripColumns.includes("destination_text"));
      assert.ok(tripColumns.includes("destination_administrative_area"));
      assert.equal(
        (database.prepare("PRAGMA user_version").get() as { user_version: number }).user_version,
        2,
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
  }

  // Reopening must not duplicate or overwrite initialized business data.
  const reopened = new WeatherStore({ stateDirectory, now: () => FIXED_NOW + 1 });
  try {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      assert.equal(queryCount(database, "places"), 1);
      assert.equal(queryCount(database, "notification_preferences"), 1);
      assert.equal(queryCount(database, "schema_migrations"), 2);
    } finally {
      database.close();
    }
  } finally {
    reopened.close();
  }
});

test("confirmed half-open location periods override the default only inside the interval", () => {
  const { store, databasePath } = createStore();

  try {
    const periodId = insertPlaceAndPeriod(databasePath, {
      fromUtc: 2_000,
      untilUtc: 3_000,
      recordState: "confirmed",
    });

    assert.equal(store.getEffectivePlace(1_999).source, "default");

    const atStart = store.getEffectivePlace(2_000);
    assert.equal(atStart.source, "location_period");
    assert.equal(atStart.place.displayName, "江苏省无锡市滨湖区");
    assert.equal(atStart.locationPeriodId, periodId);
    assert.equal(atStart.effectiveFromUtc, 2_000);
    assert.equal(atStart.effectiveUntilUtc, 3_000);

    assert.equal(store.getEffectivePlace(2_999).source, "location_period");
    assert.equal(store.getEffectivePlace(3_000).source, "default");
  } finally {
    store.close();
  }
});

test("cancelled periods never override the default place", () => {
  const { store, databasePath } = createStore();

  try {
    insertPlaceAndPeriod(databasePath, {
      fromUtc: 2_000,
      untilUtc: 3_000,
      recordState: "cancelled",
    });
    assert.equal(store.getEffectivePlace(2_500).source, "default");
  } finally {
    store.close();
  }
});

test("database triggers reject overlapping confirmed periods and allow adjacent periods", () => {
  const { store, databasePath } = createStore();

  try {
    const firstPeriodId = insertPlaceAndPeriod(databasePath, {
      fromUtc: 2_000,
      untilUtc: 3_000,
      recordState: "confirmed",
    });

    assert.doesNotThrow(() => {
      insertPeriodForExistingPlace(databasePath, {
        placeKey: "test:wuxi:binhu",
        fromUtc: 3_000,
        untilUtc: 4_000,
        recordState: "confirmed",
      });
    });

    assert.throws(
      () => {
        insertPeriodForExistingPlace(databasePath, {
          placeKey: "test:wuxi:binhu",
          fromUtc: 2_999,
          untilUtc: 4_000,
          recordState: "confirmed",
        });
      },
      /overlaps an existing period/,
    );

    const database = new DatabaseSync(databasePath);
    try {
      assert.throws(
        () => database.prepare(`
          UPDATE location_periods
          SET effective_until_utc = 3500, updated_at_utc = updated_at_utc + 1
          WHERE id = ?
        `).run(firstPeriodId),
        /overlaps an existing period/,
      );
    } finally {
      database.close();
    }
  } finally {
    store.close();
  }
});

test("tentative trips may omit destination, dates, and transport without changing location", () => {
  const { store, databasePath } = createStore();

  try {
    const database = new DatabaseSync(databasePath);
    try {
      database.prepare(`
        INSERT INTO trips (
          subject_id,
          title,
          state,
          transport_mode,
          departure_precision,
          arrival_precision,
          weather_mode,
          source_kind,
          source_summary,
          created_at_utc,
          updated_at_utc
        ) VALUES ('owner', ?, 'tentative', 'unknown', 'unknown', 'unknown', 'none',
                  'owner_text', ?, ?, ?)
      `).run("近期出行计划（细节待定）", "主人确认保存；时间、目的地和交通方式待定", FIXED_NOW, FIXED_NOW);
      assert.equal(queryCount(database, "trips"), 1);
      assert.equal(queryCount(database, "location_periods"), 0);
    } finally {
      database.close();
    }

    assert.equal(store.getEffectivePlace(FIXED_NOW).source, "default");
  } finally {
    store.close();
  }
});

test("rejects invalid timestamps and use after close", () => {
  const { store } = createStore();
  assert.throws(() => store.getEffectivePlace(-1), /non-negative Unix-seconds integer/);
  assert.throws(() => store.getEffectivePlace(1.5), /non-negative Unix-seconds integer/);

  store.close();
  assert.throws(() => store.getDefaultPlace(), /WeatherStore is closed/);
  assert.doesNotThrow(() => store.close());
});

test("stores only fresh bounded API cache entries and expires them deterministically", () => {
  const { store } = createStore();
  try {
    const place = store.getDefaultPlace();
    store.putApiCache({
      cacheKey: `v1:current:${place.id}`,
      endpointKind: "current",
      placeId: place.id,
      metadataTag: "fixture-tag",
      fetchedAtUtc: 1_000,
      expiresAtUtc: 1_600,
      payload: { metadata: { tag: "fixture-tag" }, condition: { text: "多云" } },
    });

    assert.deepEqual(store.getFreshApiCache(`v1:current:${place.id}`, 1_599), {
      cacheKey: `v1:current:${place.id}`,
      endpointKind: "current",
      placeId: place.id,
      metadataTag: "fixture-tag",
      fetchedAtUtc: 1_000,
      expiresAtUtc: 1_600,
      payload: { metadata: { tag: "fixture-tag" }, condition: { text: "多云" } },
    });
    assert.equal(store.getFreshApiCache(`v1:current:${place.id}`, 1_600), undefined);
    assert.equal(store.deleteExpiredApiCache(1_600), 1);
    assert.equal(store.deleteExpiredApiCache(1_600), 0);

    assert.throws(
      () =>
        store.putApiCache({
          cacheKey: "v1:bad",
          endpointKind: "current",
          fetchedAtUtc: 1_000,
          expiresAtUtc: 1_000,
          payload: {},
        }),
      /later than/,
    );
  } finally {
    store.close();
  }
});

function createStore(): {
  store: WeatherStore;
  stateDirectory: string;
  databasePath: string;
} {
  const temporaryRoot = mkdtempSync(join(tmpdir(), "personal-weather-store-"));
  temporaryRoots.push(temporaryRoot);
  const stateDirectory = join(temporaryRoot, "state");
  const store = new WeatherStore({ stateDirectory, now: () => FIXED_NOW });
  return { store, stateDirectory, databasePath: store.databasePath };
}

function queryCount(database: DatabaseSync, tableName: string): number {
  const allowedTables = new Set([
    "places",
    "notification_preferences",
    "trips",
    "location_periods",
    "change_proposals",
    "schema_migrations",
  ]);
  assert.ok(allowedTables.has(tableName), `Unexpected table name: ${tableName}`);
  const row = database.prepare(`SELECT COUNT(*) AS count FROM ${tableName}`).get() as {
    count: number;
  };
  return row.count;
}

function insertPlaceAndPeriod(
  databasePath: string,
  period: {
    fromUtc: number;
    untilUtc: number | null;
    recordState: "confirmed" | "cancelled";
  },
): number {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
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
        source,
        created_at_utc,
        updated_at_utc
      ) VALUES ('test:wuxi:binhu', '江苏省无锡市滨湖区', 'CN', '江苏省', '无锡市',
                '滨湖区', 31.5260, 120.2840, 'Asia/Shanghai', 'district', 'operator', ?, ?)
    `).run(FIXED_NOW, FIXED_NOW);

    const place = database.prepare(
      "SELECT id FROM places WHERE place_key = 'test:wuxi:binhu'",
    ).get() as { id: number };
    const result = database.prepare(`
      INSERT INTO location_periods (
        subject_id,
        place_id,
        effective_from_utc,
        effective_until_utc,
        basis,
        record_state,
        source_kind,
        source_summary,
        created_at_utc,
        updated_at_utc
      ) VALUES ('owner', ?, ?, ?, 'trip_schedule', ?, 'operator', 'test fixture', ?, ?)
    `).run(
      place.id,
      period.fromUtc,
      period.untilUtc,
      period.recordState,
      FIXED_NOW,
      FIXED_NOW,
    );
    return Number(result.lastInsertRowid);
  } finally {
    database.close();
  }
}

function insertPeriodForExistingPlace(
  databasePath: string,
  period: {
    placeKey: string;
    fromUtc: number;
    untilUtc: number | null;
    recordState: "confirmed" | "cancelled";
  },
): number {
  const database = new DatabaseSync(databasePath);
  try {
    database.exec("PRAGMA foreign_keys = ON");
    const place = database.prepare(
      "SELECT id FROM places WHERE place_key = ?",
    ).get(period.placeKey) as { id: number } | undefined;
    if (!place) {
      throw new Error(`Missing test place: ${period.placeKey}`);
    }

    const result = database.prepare(`
      INSERT INTO location_periods (
        subject_id,
        place_id,
        effective_from_utc,
        effective_until_utc,
        basis,
        record_state,
        source_kind,
        source_summary,
        created_at_utc,
        updated_at_utc
      ) VALUES ('owner', ?, ?, ?, 'trip_schedule', ?, 'operator', 'test fixture', ?, ?)
    `).run(
      place.id,
      period.fromUtc,
      period.untilUtc,
      period.recordState,
      FIXED_NOW,
      FIXED_NOW,
    );
    return Number(result.lastInsertRowid);
  } finally {
    database.close();
  }
}
