import { describe, expect, it } from "vitest";

import {
  QWEATHER_TEXT_LIMITS,
  parseQWeatherAlerts,
  parseQWeatherCurrent,
  parseQWeatherDaily,
  parseQWeatherGeoLookup,
  parseQWeatherHourly,
  sanitizeQWeatherText,
} from "./parsers.js";
import {
  alertFixture,
  currentFixture,
  dailyFixture,
  geoLookupFixture,
  hourlyFixture,
  metadataFixture,
} from "./test-fixtures.js";
import type { ParseResult } from "./types.js";

function success<T>(result: ParseResult<T>): Extract<ParseResult<T>, { ok: true }> {
  if (!result.ok) {
    throw new Error(`Expected parse success, got ${JSON.stringify(result.issues)}`);
  }
  return result;
}

function failure<T>(result: ParseResult<T>): Extract<ParseResult<T>, { ok: false }> {
  if (result.ok) {
    throw new Error("Expected parse failure.");
  }
  return result;
}

describe("parseQWeatherCurrent", () => {
  it("parses the documented v1 shape and ignores unknown fields", () => {
    const result = success(
      parseQWeatherCurrent({
        ...currentFixture,
        futureTopLevelField: { may: "change" },
        condition: { text: "新天气类型", code: "future-condition-code", extra: true },
        precipitation: {
          ...currentFixture.precipitation,
          type: "future-precipitation-type",
        },
      }),
    );

    expect(result.data.condition).toEqual({
      text: "新天气类型",
      code: "future-condition-code",
    });
    expect(result.data.precipitation?.type).toBe("future-precipitation-type");
    expect(result.data.temperature).toEqual({ value: 31.71, unit: "°C" });
  });

  it("fails when a strict current core field is missing", () => {
    const { temperature: _temperature, ...withoutTemperature } = currentFixture;
    const result = failure(parseQWeatherCurrent(withoutTemperature));

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.temperature", code: "missing_field" }),
      ]),
    );
  });

  it("fails when core metadata or condition is malformed", () => {
    expect(parseQWeatherCurrent({ ...currentFixture, metadata: null }).ok).toBe(false);
    expect(
      parseQWeatherCurrent({ ...currentFixture, condition: { text: "多云" } }).ok,
    ).toBe(false);
  });

  it("drops malformed optional fields instead of rejecting valid core weather", () => {
    const result = success(
      parseQWeatherCurrent({
        ...currentFixture,
        humidity: 1.2,
        cloudCover: "many",
        feelsLike: null,
        uvIndex: 16,
      }),
    );

    expect(result.data.humidity).toBeUndefined();
    expect(result.data.cloudCover).toBeUndefined();
    expect(result.data.feelsLike).toBeUndefined();
    expect(result.data.uvIndex).toBeUndefined();
    expect(result.warnings.map((entry) => entry.path)).toEqual(
      expect.arrayContaining(["$.humidity", "$.cloudCover", "$.uvIndex"]),
    );
  });

  it("sanitizes required text without turning a recoverable cleanup into failure", () => {
    const result = success(
      parseQWeatherCurrent({
        ...currentFixture,
        condition: { text: "多\u0000\u202E云", code: "future-code" },
      }),
    );

    expect(result.data.condition).toEqual({ text: "多云", code: "future-code" });
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.condition.text", code: "sanitized_text" }),
      ]),
    );
  });

  it("normalizes missing attributions to an explicit empty list with a warning", () => {
    const result = success(
      parseQWeatherCurrent({
        ...currentFixture,
        metadata: { tag: "tag-without-attributions" },
      }),
    );

    expect(result.data.metadata.attributions).toEqual([]);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.metadata.attributions", code: "missing_field" }),
      ]),
    );
  });
});

describe("parseQWeatherDaily", () => {
  it("parses a valid day and turns auxiliary null into undefined", () => {
    const result = success(parseQWeatherDaily(dailyFixture));

    expect(result.data.days).toHaveLength(1);
    expect(result.data.days[0]?.nighttime?.precipitation).toBeUndefined();
    expect(result.data.days[0]?.daytime?.precipitation?.probability).toBe(0.64);
  });

  it("drops only malformed daily entries", () => {
    const malformed = {
      forecastStartTime: "2026-08-07T00:00+08:00",
      forecastEndTime: "2026-08-08T00:00+08:00",
      temperatureMax: { value: 34, unit: "°C" },
      // temperatureMin is deliberately missing.
    };
    const result = success(
      parseQWeatherDaily({ ...dailyFixture, days: [...dailyFixture.days, malformed] }),
    );

    expect(result.data.days).toHaveLength(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.days[1]", code: "dropped_item" }),
      ]),
    );
  });

  it("keeps a day but omits a malformed day/night period", () => {
    const day = {
      ...dailyFixture.days[0],
      daytime: {
        ...dailyFixture.days[0]?.daytime,
        forecastEndTime: "2026-08-06T06:00+08:00",
      },
    };
    const result = success(parseQWeatherDaily({ ...dailyFixture, days: [day] }));

    expect(result.data.days).toHaveLength(1);
    expect(result.data.days[0]?.daytime).toBeUndefined();
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.days[0].daytime", code: "dropped_item" }),
      ]),
    );
  });

  it("accepts a valid empty list so the service can mark daily data unavailable", () => {
    const result = success(parseQWeatherDaily({ metadata: metadataFixture, days: [] }));
    expect(result.data.days).toEqual([]);
  });

  it("drops an entry containing an impossible calendar date", () => {
    const result = success(
      parseQWeatherDaily({
        ...dailyFixture,
        days: [
          {
            ...dailyFixture.days[0],
            forecastStartTime: "2026-02-31T00:00+08:00",
          },
        ],
      }),
    );
    expect(result.data.days).toEqual([]);
    expect(result.warnings.some((entry) => entry.code === "dropped_item")).toBe(true);
  });

  it("rejects a malformed top-level days collection", () => {
    expect(parseQWeatherDaily({ metadata: metadataFixture, days: {} }).ok).toBe(false);
  });
});

describe("parseQWeatherHourly", () => {
  it("parses hourly data and preserves unknown enums", () => {
    const hour = {
      ...hourlyFixture.hours[0],
      wind: {
        ...hourlyFixture.hours[0]?.wind,
        direction: { degree: 215, compass: "future-compass" },
      },
      precipitation: {
        ...hourlyFixture.hours[0]?.precipitation,
        type: "future-precipitation-type",
      },
    };
    const result = success(parseQWeatherHourly({ ...hourlyFixture, hours: [hour] }));

    expect(result.data.hours[0]?.wind?.direction?.compass).toBe("future-compass");
    expect(result.data.hours[0]?.precipitation?.type).toBe("future-precipitation-type");
  });

  it("drops an item with an invalid forecast time but keeps neighboring items", () => {
    const result = success(
      parseQWeatherHourly({
        ...hourlyFixture,
        hours: [
          ...hourlyFixture.hours,
          { forecastTime: "not-a-date", condition: { text: "晴", code: "100" } },
        ],
      }),
    );

    expect(result.data.hours).toHaveLength(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.hours[1]", code: "dropped_item" }),
      ]),
    );
  });

  it("drops only an invalid precipitation probability", () => {
    const hour = {
      ...hourlyFixture.hours[0],
      precipitation: {
        ...hourlyFixture.hours[0]?.precipitation,
        probability: -0.1,
      },
    };
    const result = success(parseQWeatherHourly({ ...hourlyFixture, hours: [hour] }));

    expect(result.data.hours[0]?.precipitation?.probability).toBeUndefined();
    expect(result.data.hours[0]?.precipitation?.type).toBe("rain");
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.hours[0].precipitation.probability",
          code: "invalid_value",
        }),
      ]),
    );
  });

  it("accepts boundary ratios and UV values", () => {
    const low = {
      ...hourlyFixture.hours[0],
      humidity: 0,
      cloudCover: 0,
      uvIndex: 0,
      precipitation: { probability: 0, type: "none" },
    };
    const high = {
      ...hourlyFixture.hours[0],
      forecastTime: "2026-08-06T12:00+08:00",
      humidity: 1,
      cloudCover: 1,
      uvIndex: 15,
      precipitation: { probability: 1, type: "rain" },
    };
    const result = success(parseQWeatherHourly({ ...hourlyFixture, hours: [low, high] }));

    expect(result.data.hours).toHaveLength(2);
    expect(result.data.hours[0]?.humidity).toBe(0);
    expect(result.data.hours[1]?.uvIndex).toBe(15);
    expect(result.data.hours[1]?.precipitation?.probability).toBe(1);
  });
});

describe("parseQWeatherAlerts", () => {
  it("marks only zeroResult=true plus an originally empty array as no alerts", () => {
    const result = success(
      parseQWeatherAlerts({
        metadata: { ...metadataFixture, zeroResult: true },
        alerts: [],
      }),
    );

    expect(result.data.state).toBe("none");
    expect(result.data.alerts).toEqual([]);
  });

  it.each([false, undefined, null])(
    "keeps an empty array indeterminate when zeroResult is %s",
    (zeroResult) => {
      const metadata = { ...metadataFixture, zeroResult };
      const result = success(parseQWeatherAlerts({ metadata, alerts: [] }));

      expect(result.data.state).toBe("indeterminate");
      expect(result.warnings.some((entry) => entry.code === "inconsistent_response")).toBe(true);
    },
  );

  it("prefers active alert data over a contradictory zeroResult=true flag", () => {
    const result = success(
      parseQWeatherAlerts({
        ...alertFixture,
        metadata: { ...alertFixture.metadata, zeroResult: true },
      }),
    );

    expect(result.data.state).toBe("active");
    expect(result.data.alerts).toHaveLength(1);
    expect(result.warnings.some((entry) => entry.code === "inconsistent_response")).toBe(true);
  });

  it("keeps unknown alert enums and maps documented null auxiliaries to undefined", () => {
    const alert = {
      ...alertFixture.alerts[0],
      messageType: { code: "future-message-type", supersedes: null },
      severity: "future-severity",
    };
    const result = success(parseQWeatherAlerts({ ...alertFixture, alerts: [alert] }));
    const parsed = result.data.alerts[0];

    expect(parsed?.messageType?.code).toBe("future-message-type");
    expect(parsed?.messageType?.supersedes).toBeUndefined();
    expect(parsed?.severity).toBe("future-severity");
    expect(parsed?.urgency).toBeUndefined();
    expect(parsed?.onsetTime).toBeUndefined();
  });

  it("does not infer no-alerts when a non-empty raw array contains only broken alerts", () => {
    const result = success(
      parseQWeatherAlerts({
        metadata: { ...metadataFixture, zeroResult: true },
        alerts: [{ headline: "missing id" }],
      }),
    );

    expect(result.data.alerts).toEqual([]);
    expect(result.data.state).toBe("indeterminate");
  });

  it("removes unsafe controls and bounds long alert text", () => {
    const alert = {
      ...alertFixture.alerts[0],
      headline: "暴雨\u0000\u202E预警",
      description: `${"雨".repeat(QWEATHER_TEXT_LIMITS.description + 100)}\u0000`,
    };
    const result = success(parseQWeatherAlerts({ ...alertFixture, alerts: [alert] }));
    const parsed = result.data.alerts[0];

    expect(parsed?.headline).toBe("暴雨预警");
    expect(Array.from(parsed?.description ?? "")).toHaveLength(
      QWEATHER_TEXT_LIMITS.description,
    );
    expect(parsed?.description?.endsWith("…")).toBe(true);
    expect(result.warnings.map((entry) => entry.code)).toEqual(
      expect.arrayContaining(["sanitized_text", "truncated_text"]),
    );
  });
});

describe("parseQWeatherGeoLookup", () => {
  it("normalizes the confirmed Guangzhou Tianhe candidate", () => {
    const result = success(parseQWeatherGeoLookup(geoLookupFixture));
    const tianhe = result.data.locations[0];

    expect(result.data.code).toBe("200");
    expect(tianhe).toMatchObject({
      name: "天河",
      id: "101280109",
      latitude: 23.1356,
      longitude: 113.3354,
      adm2: "广州市",
      adm1: "广东省",
      timezone: "Asia/Shanghai",
    });
    expect(result.data.attributions).toEqual([
      "https://developer.qweather.com/attribution.html",
    ]);
  });

  it("drops only malformed GeoAPI candidates", () => {
    const invalidCandidate = {
      ...geoLookupFixture.location[0],
      id: "broken",
      lat: "91",
    };
    const result = success(
      parseQWeatherGeoLookup({
        ...geoLookupFixture,
        location: [...geoLookupFixture.location, invalidCandidate],
      }),
    );

    expect(result.data.locations).toHaveLength(1);
    expect(result.warnings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.location[1]", code: "dropped_item" }),
      ]),
    );
  });

  it("drops candidates with an invalid IANA timezone", () => {
    const result = success(
      parseQWeatherGeoLookup({
        ...geoLookupFixture,
        location: [{ ...geoLookupFixture.location[0], tz: "Not/A_Timezone" }],
      }),
    );
    expect(result.data.locations).toEqual([]);
  });

  it("accepts a non-success GeoAPI body without a location array", () => {
    const result = success(parseQWeatherGeoLookup({ code: "401" }));
    expect(result.data).toMatchObject({ code: "401", locations: [] });
  });

  it("rejects a success body that omits its location array", () => {
    expect(parseQWeatherGeoLookup({ code: "200" }).ok).toBe(false);
  });
});

describe("sanitizeQWeatherText", () => {
  it("removes control and bidirectional override characters", () => {
    expect(sanitizeQWeatherText("  天\u0000\u202E河\n天气  ")).toBe("天河 天气");
  });

  it("truncates by Unicode code point without splitting emoji", () => {
    expect(sanitizeQWeatherText("🙂🙂🙂🙂", { maxLength: 3 })).toBe("🙂🙂…");
    expect(Array.from(sanitizeQWeatherText("🙂🙂🙂🙂", { maxLength: 3 }))).toHaveLength(3);
  });
});
