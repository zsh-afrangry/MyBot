import { describe, expect, it } from "vitest";

import { formatWeatherBrief } from "./formatter.js";
import type { WeatherBrief } from "./weather-model.js";

function baseBrief(): WeatherBrief {
  return {
    schemaVersion: 1,
    location: {
      displayName: "广东省广州市天河区",
      shortName: "广州天河",
      latitude: 23.1356,
      longitude: 113.3354,
      timezone: "Asia/Shanghai",
      qweatherLocationId: "101280109",
    },
    generatedAt: "2026-08-06T02:30:00.000Z",
    current: {
      condition: { text: "多云", code: "unknown-new-code" },
      temperature: { value: 32, unit: "celsius" },
      feelsLike: { value: 34, unit: "celsius" },
      humidity: 0.69,
      wind: { direction: { compass: "SW" }, scale: 3 },
    },
    today: {
      forecastStartTime: "2026-08-05T16:00:00.000Z",
      forecastEndTime: "2026-08-06T16:00:00.000Z",
      temperatureMin: { value: 27, unit: "celsius" },
      temperatureMax: { value: 35, unit: "celsius" },
      uvIndexMax: 6,
    },
    next24Hours: {
      availableHours: 24,
      maxPrecipitationProbability: 0.64,
      rainWindows: [
        {
          startTime: "2026-08-06T03:00:00.000Z",
          endTime: "2026-08-06T06:00:00.000Z",
          maxProbability: 0.64,
          precipitationType: "rain",
        },
      ],
    },
    alerts: { availability: "available", state: "none", items: [] },
    attributions: ["QWeather"],
    quality: {
      current: { state: "fresh", fetchedAt: "2026-08-06T02:30:00.000Z" },
      daily: { state: "fresh", fetchedAt: "2026-08-06T02:30:00.000Z" },
      hourly: { state: "fresh", fetchedAt: "2026-08-06T02:30:00.000Z" },
      alerts: { state: "fresh", fetchedAt: "2026-08-06T02:30:00.000Z" },
    },
    warnings: [],
  };
}

describe("formatWeatherBrief", () => {
  it("formats a deterministic Chinese daily brief", () => {
    const text = formatWeatherBrief(baseBrief(), { greeting: true });
    expect(text).toContain("早上好，主人～");
    expect(text).toContain("广州天河：现在多云，32°C，体感34°C，湿度69%，西南风3级。");
    expect(text).toContain("最高降雨概率64%");
    expect(text).toContain("出门建议带伞");
    expect(text).toContain("当前无官方气象预警");
    expect(text).not.toMatch(/undefined|null|NaN/u);
  });

  it("never claims no alerts when alert data is unavailable", () => {
    const brief = baseBrief();
    brief.alerts = { availability: "unavailable", state: "unavailable", items: [] };
    brief.quality.alerts = { state: "unavailable", publicErrorCode: "TIMEOUT" };
    const text = formatWeatherBrief(brief);
    expect(text).toContain("官方预警数据暂不可用");
    expect(text).not.toContain("当前无官方气象预警");
  });

  it("bounds the final QQ text", () => {
    const brief = baseBrief();
    brief.alerts = {
      availability: "available",
      state: "active",
      items: [{ id: "1", headline: "很长".repeat(1000) }],
    };
    expect([...formatWeatherBrief(brief, { maxLength: 200 })]).toHaveLength(200);
  });
});
