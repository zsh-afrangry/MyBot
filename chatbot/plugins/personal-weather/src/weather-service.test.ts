import { describe, expect, it, vi } from "vitest";

import type { QWeatherClient } from "./qweather-client.js";
import type { WeatherStore } from "./store.js";
import {
  alertFixture,
  currentFixture,
  dailyFixture,
  hourlyFixture,
} from "./test-fixtures.js";
import { WeatherService } from "./weather-service.js";

const NOW = Date.parse("2026-08-06T02:30:00.000Z");

function store(): WeatherStore {
  return {
    deleteExpiredApiCache: () => 0,
    deleteApiCache: () => false,
    getFreshApiCache: () => undefined,
    putApiCache: () => undefined,
    getEffectivePlace: () => ({
      source: "default",
      locationPeriodId: null,
      effectiveFromUtc: null,
      effectiveUntilUtc: null,
      place: {
        id: 1,
        placeKey: "cn:guangdong:guangzhou:tianhe:district-centre",
        displayName: "广东省广州市天河区",
        countryCode: "CN",
        adm1: "广东省",
        adm2: "广州市",
        district: "天河区",
        localityName: "天河区",
        latitude: 23.1356,
        longitude: 113.3354,
        timezone: "Asia/Shanghai",
        precision: "district",
        qweatherLocationId: "101280109",
        source: "qweather_location_list",
      },
    }),
  } as unknown as WeatherStore;
}

function client(overrides: Partial<QWeatherClient> = {}): QWeatherClient {
  return {
    getCurrent: vi.fn(async () => currentFixture),
    getDaily: vi.fn(async () => dailyFixture),
    getHourly: vi.fn(async () => hourlyFixture),
    getAlerts: vi.fn(async () => alertFixture),
    ...overrides,
  } as unknown as QWeatherClient;
}

describe("WeatherService", () => {
  it("aggregates the confirmed default location and four QWeather components", async () => {
    const brief = await new WeatherService(store(), client(), {
      now: () => NOW,
    }).getBrief();

    expect(brief.location).toMatchObject({
      displayName: "广东省广州市天河区",
      shortName: "广州天河区",
      latitude: 23.1356,
      longitude: 113.3354,
      qweatherLocationId: "101280109",
    });
    expect(brief.today?.temperatureMax.value).toBe(35.2);
    expect(brief.next24Hours).toMatchObject({
      availableHours: 1,
      maxPrecipitationProbability: 0.64,
    });
    expect(brief.alerts.state).toBe("active");
    expect(brief.quality.current.state).toBe("fresh");
  });

  it("keeps a county-level city leaf name when GeoAPI classifies it as city", async () => {
    const yangzhongStore = store() as unknown as {
      getEffectivePlace: WeatherStore["getEffectivePlace"];
    };
    yangzhongStore.getEffectivePlace = () => ({
      source: "current_location",
      locationPeriodId: null,
      effectiveFromUtc: NOW / 1000,
      effectiveUntilUtc: null,
      place: {
        id: 2,
        placeKey: "qweather:101190303",
        displayName: "江苏省镇江扬中",
        countryCode: "CN",
        adm1: "江苏省",
        adm2: "镇江",
        district: null,
        localityName: "扬中",
        latitude: 32.23727,
        longitude: 119.82806,
        timezone: "Asia/Shanghai",
        precision: "city",
        qweatherLocationId: "101190303",
        source: "owner_confirmed",
      },
    });
    const getCurrent = vi.fn(async () => currentFixture);

    const brief = await new WeatherService(
      yangzhongStore as unknown as WeatherStore,
      client({ getCurrent }),
      { now: () => NOW },
    ).getBrief();

    expect(brief.location).toMatchObject({
      displayName: "江苏省镇江扬中",
      shortName: "镇江扬中",
      qweatherLocationId: "101190303",
    });
    expect(getCurrent).toHaveBeenCalledWith(
      { latitude: 32.23727, longitude: 119.82806 },
      undefined,
    );
  });

  it("degrades optional components without inventing a no-alert result", async () => {
    const degradedClient = client({
      getDaily: vi.fn(async () => {
        throw new Error("offline");
      }),
      getAlerts: vi.fn(async () => {
        throw new Error("offline");
      }),
    });
    const brief = await new WeatherService(store(), degradedClient, {
      now: () => NOW,
    }).getBrief();

    expect(brief.current.temperature.value).toBe(31.71);
    expect(brief.today).toBeUndefined();
    expect(brief.alerts).toEqual({
      availability: "unavailable",
      state: "unavailable",
      items: [],
    });
    expect(brief.quality.alerts).toMatchObject({
      state: "unavailable",
      publicErrorCode: "UPSTREAM_UNAVAILABLE",
    });
  });

  it("reuses fresh component cache without another upstream request", async () => {
    const entries = new Map<string, {
      cacheKey: string;
      endpointKind: string;
      placeId: number;
      metadataTag: string | null;
      fetchedAtUtc: number;
      expiresAtUtc: number;
      payload: unknown;
    }>();
    const cachedStore = store() as unknown as {
      getEffectivePlace: WeatherStore["getEffectivePlace"];
      deleteExpiredApiCache: WeatherStore["deleteExpiredApiCache"];
      deleteApiCache: WeatherStore["deleteApiCache"];
      getFreshApiCache: WeatherStore["getFreshApiCache"];
      putApiCache: WeatherStore["putApiCache"];
    };
    cachedStore.getFreshApiCache = ((key: string, atUtc: number) => {
      const entry = entries.get(key);
      return entry && atUtc < entry.expiresAtUtc ? entry : undefined;
    }) as WeatherStore["getFreshApiCache"];
    cachedStore.putApiCache = ((input: {
      cacheKey: string;
      endpointKind: string;
      placeId?: number;
      metadataTag?: string;
      fetchedAtUtc: number;
      expiresAtUtc: number;
      payload: unknown;
    }) => {
      entries.set(input.cacheKey, {
        cacheKey: input.cacheKey,
        endpointKind: input.endpointKind,
        placeId: input.placeId ?? 1,
        metadataTag: input.metadataTag ?? null,
        fetchedAtUtc: input.fetchedAtUtc,
        expiresAtUtc: input.expiresAtUtc,
        payload: input.payload,
      });
    }) as WeatherStore["putApiCache"];

    const getCurrent = vi.fn(async () => currentFixture);
    const getDaily = vi.fn(async () => dailyFixture);
    const getHourly = vi.fn(async () => hourlyFixture);
    const getAlerts = vi.fn(async () => alertFixture);
    const upstream = client({ getCurrent, getDaily, getHourly, getAlerts });
    const service = new WeatherService(cachedStore as unknown as WeatherStore, upstream, {
      now: () => NOW,
    });

    expect((await service.getBrief()).quality.current.state).toBe("fresh");
    expect((await service.getBrief()).quality.current.state).toBe("cached-fresh");
    expect(getCurrent).toHaveBeenCalledTimes(1);
    expect(getDaily).toHaveBeenCalledTimes(1);
    expect(getHourly).toHaveBeenCalledTimes(1);
    expect(getAlerts).toHaveBeenCalledTimes(1);
  });

  it("reads a temporary resolved location without consulting or changing the effective place", async () => {
    const transientStore = store() as unknown as {
      getEffectivePlace: WeatherStore["getEffectivePlace"];
      putApiCache: WeatherStore["putApiCache"];
    };
    const getEffectivePlace = vi.fn(transientStore.getEffectivePlace);
    const putApiCache = vi.fn();
    transientStore.getEffectivePlace = getEffectivePlace;
    transientStore.putApiCache = putApiCache as WeatherStore["putApiCache"];
    const getCurrent = vi.fn(async () => currentFixture);
    const upstream = client({ getCurrent });

    const brief = await new WeatherService(
      transientStore as unknown as WeatherStore,
      upstream,
      { now: () => NOW },
    ).getBriefForLocation({
      weatherLocation: {
        displayName: "广东省广州市番禺",
        shortName: "广州番禺",
        latitude: 23.04,
        longitude: 113.384,
        timezone: "Asia/Shanghai",
        qweatherLocationId: "101280102",
      },
      cacheIdentity: "geo:test-panyu",
      attributions: ["https://developer.qweather.com/attribution.html"],
    });

    expect(getEffectivePlace).not.toHaveBeenCalled();
    expect(getCurrent).toHaveBeenCalledWith(
      { latitude: 23.04, longitude: 113.384 },
      undefined,
    );
    expect(brief.location).toMatchObject({
      displayName: "广东省广州市番禺",
      qweatherLocationId: "101280102",
    });
    expect(brief.attributions).toContain("https://developer.qweather.com/attribution.html");
    expect(putApiCache).toHaveBeenCalled();
    for (const [input] of putApiCache.mock.calls) {
      expect(input).not.toHaveProperty("placeId");
      expect(input.cacheKey).toContain("geo:test-panyu");
    }
  });
});
