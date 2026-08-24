import { describe, expect, it, vi } from "vitest";

import { WeatherError } from "./errors.js";
import type { QWeatherClient } from "./qweather-client.js";
import { resolveProfileLocation, resolveWeatherLocation } from "./weather-location.js";

function client(payload: unknown): QWeatherClient {
  return {
    lookupPlace: vi.fn(async () => payload),
  } as unknown as QWeatherClient;
}

const panyu = {
  code: "200",
  location: [
    {
      name: "番禺",
      id: "101280102",
      lat: "23.0400",
      lon: "113.3840",
      adm2: "广州市",
      adm1: "广东省",
      country: "中国",
      tz: "Asia/Shanghai",
    },
  ],
  refer: {
    sources: ["https://developer.qweather.com/attribution.html"],
    license: ["QWeather Developers License"],
  },
};

describe("temporary weather location resolution", () => {
  it("resolves a single district without creating a persistent place", async () => {
    const upstream = client(panyu);
    const resolution = await resolveWeatherLocation(upstream, {
      location: "番禺区",
      administrativeArea: "广州市",
    });

    expect(resolution).toMatchObject({
      kind: "resolved",
      location: {
        weatherLocation: {
          displayName: "广东省广州市番禺",
          shortName: "广州番禺",
          timezone: "Asia/Shanghai",
          qweatherLocationId: "101280102",
        },
      },
    });
    if (resolution.kind !== "resolved") return;
    expect(resolution.location.cacheIdentity).toMatch(/^geo:[a-f0-9]{64}$/u);
    expect((upstream.lookupPlace as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]).toEqual({
      location: "番禺区",
      adm: "广州市",
    });
  });

  it("returns minimal candidates when multiple exact place names remain", async () => {
    const upstream = client({
      ...panyu,
      location: [
        {
          ...panyu.location[0],
          name: "朝阳",
          id: "101010300",
          adm2: "北京市",
          adm1: "北京市",
        },
        {
          ...panyu.location[0],
          name: "朝阳",
          id: "101070601",
          adm2: "朝阳市",
          adm1: "辽宁省",
        },
      ],
    });

    const resolution = await resolveWeatherLocation(upstream, { location: "朝阳区" });

    expect(resolution).toEqual({
      kind: "ambiguous",
      candidates: [
        {
          displayName: "北京市朝阳",
          administrativeArea: "北京市",
          country: "中国",
          timezone: "Asia/Shanghai",
        },
        {
          displayName: "辽宁省朝阳市朝阳",
          administrativeArea: "辽宁省、朝阳市",
          country: "中国",
          timezone: "Asia/Shanghai",
        },
      ],
    });
  });

  it("uses the administrative area only to narrow an exact-name ambiguity", async () => {
    const upstream = client({
      ...panyu,
      location: [
        {
          ...panyu.location[0],
          name: "朝阳",
          id: "101010300",
          adm2: "北京市",
          adm1: "北京市",
        },
        {
          ...panyu.location[0],
          name: "朝阳",
          id: "101070601",
          adm2: "朝阳市",
          adm1: "辽宁省",
        },
      ],
    });

    const resolution = await resolveWeatherLocation(upstream, {
      location: "朝阳区",
      administrativeArea: "北京市",
    });

    expect(resolution).toMatchObject({
      kind: "resolved",
      location: { weatherLocation: { displayName: "北京市朝阳" } },
    });
  });

  it("maps an upstream no-data location lookup to an explicit not-found result", async () => {
    const upstream = {
      lookupPlace: vi.fn(async () => {
        throw new WeatherError("NO_DATA");
      }),
    } as unknown as QWeatherClient;

    await expect(resolveWeatherLocation(upstream, { location: "不存在地点" }))
      .resolves.toEqual({ kind: "not_found" });
  });

  it("rejects malformed GeoAPI responses instead of selecting a location", async () => {
    await expect(resolveWeatherLocation(client({ code: "200", location: [{}] }), {
      location: "番禺区",
    })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });
});

describe("Profile location resolution", () => {
  it("persists the raw leaf name even when GeoAPI calls a county-level city city", async () => {
    const upstream = client({
      ...panyu,
      location: [{
        ...panyu.location[0],
        name: "扬中",
        id: "101190303",
        lat: "32.23727",
        lon: "119.82806",
        adm1: "江苏省",
        adm2: "镇江",
        type: "city",
      }],
    });

    const resolution = await resolveProfileLocation(upstream, { location: "扬中市" });

    expect(resolution).toMatchObject({
      kind: "resolved",
      location: {
        location: {
          displayName: "江苏省镇江扬中",
          localityName: "扬中",
          district: null,
          precision: "city",
        },
      },
    });
  });
});
