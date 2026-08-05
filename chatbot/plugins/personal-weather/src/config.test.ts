import { describe, expect, it } from "vitest";

import {
  buildAuthHeaders,
  resolvePersonalWeatherConfig,
  validateApiHost,
} from "./config.js";
import { WeatherError } from "./errors.js";

describe("personal weather config", () => {
  it("accepts a dedicated QWeather hostname", () => {
    expect(validateApiHost("abc123.re.qweatherapi.com")).toBe(
      "abc123.re.qweatherapi.com",
    );
  });

  it.each([
    "https://abc123.re.qweatherapi.com",
    "abc123.re.qweatherapi.com/path",
    "abc123.re.qweatherapi.com:443",
    "localhost",
    "127.0.0.1",
    "api.qweather.com",
    "devapi.qweather.com",
    "abc123.evil.example",
  ])("rejects unsafe API host %s", (host) => {
    expect(() => validateApiHost(host)).toThrow(WeatherError);
  });

  it("fails closed when SecretRef is unresolved", () => {
    expect(() =>
      resolvePersonalWeatherConfig({
        apiHost: "abc123.re.qweatherapi.com",
        apiKey: { source: "env", provider: "default", id: "QWEATHER_API_KEY" },
      }),
    ).toThrow(WeatherError);
  });

  it("builds API key headers", () => {
    const apiKeyConfig = resolvePersonalWeatherConfig({
      apiHost: "abc123.re.qweatherapi.com",
      apiKey: "test-secret-value",
    });

    expect(buildAuthHeaders(apiKeyConfig)).toEqual({
      "X-QW-Api-Key": "test-secret-value",
    });
  });

  it("rejects control characters in credentials", () => {
    expect(() =>
      resolvePersonalWeatherConfig({
        apiHost: "abc123.re.qweatherapi.com",
        apiKey: "test-secret\nvalue",
      }),
    ).toThrow(WeatherError);
  });
});
