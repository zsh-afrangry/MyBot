import {
  fetchWithSsrFGuard,
  SsrFBlockedError,
} from "openclaw/plugin-sdk/ssrf-runtime";
import { describe, expect, it, vi } from "vitest";

import { resolvePersonalWeatherConfig } from "./config.js";
import { WeatherError } from "./errors.js";
import { QWeatherClient } from "./qweather-client.js";

const TEST_SECRET = "unit-test-secret-never-log";

function config() {
  return resolvePersonalWeatherConfig({
    apiHost: "example123.re.qweatherapi.com",
    apiKey: TEST_SECRET,
  });
}

function guardedResponse(
  response: Response,
  release = vi.fn(async () => undefined),
) {
  return { response, finalUrl: "https://example.invalid", release };
}

describe("QWeatherClient", () => {
  it("uses fixed current path with latitude before longitude and header auth", async () => {
    const guardedFetchMock = vi.fn(
      async (_params: Parameters<typeof fetchWithSsrFGuard>[0]) =>
      guardedResponse(
        new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      ),
    );
    const client = new QWeatherClient(config(), {
      guardedFetch: guardedFetchMock as unknown as typeof fetchWithSsrFGuard,
    });

    await client.getCurrent({ latitude: 23.1356, longitude: 113.3354 });

    const call = guardedFetchMock.mock.calls[0]?.[0];
    expect(call?.url).toContain("/weather/v1/current/23.1356/113.3354");
    expect(call?.url).not.toContain(TEST_SECRET);
    expect(call?.init?.method).toBe("GET");
    expect(call?.maxRedirects).toBe(0);
    expect(call?.capture).toBe(false);
    expect(call?.policy).toBeUndefined();
    expect(new Headers(call?.init?.headers).get("X-QW-Api-Key")).toBe(TEST_SECRET);
  });

  it("rounds alert coordinates to two decimals", async () => {
    const guardedFetchMock = vi.fn(
      async (_params: Parameters<typeof fetchWithSsrFGuard>[0]) =>
        guardedResponse(
          new Response('{"metadata":{"zeroResult":true},"alerts":[]}', {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    const client = new QWeatherClient(config(), {
      guardedFetch: guardedFetchMock as unknown as typeof fetchWithSsrFGuard,
    });

    await client.getAlerts({ latitude: 23.1356, longitude: 113.3354 });

    expect(guardedFetchMock.mock.calls[0]?.[0].url).toContain(
      "/weatheralert/v1/current/23.14/113.34",
    );
  });

  it("rejects redirects and releases the guarded dispatcher", async () => {
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.fn(async () =>
      guardedResponse(
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example" },
        }),
        release,
      ),
    ) as unknown as typeof fetchWithSsrFGuard;
    const client = new QWeatherClient(config(), { guardedFetch });

    await expect(
      client.getCurrent({ latitude: 23, longitude: 113 }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([
    [401, "AUTH_FAILED"],
    [403, "FORBIDDEN"],
  ])("does not retry HTTP %s", async (status, code) => {
    const guardedFetch = vi.fn(async () =>
      guardedResponse(new Response(null, { status })),
    ) as unknown as typeof fetchWithSsrFGuard;
    const client = new QWeatherClient(config(), {
      guardedFetch,
      sleep: vi.fn(async () => undefined),
    });

    await expect(
      client.getCurrent({ latitude: 23, longitude: 113 }),
    ).rejects.toMatchObject({ code });
    expect(guardedFetch).toHaveBeenCalledTimes(1);
  });

  it("retries a rate limit response with a bounded delay", async () => {
    const guardedFetch = vi
      .fn()
      .mockResolvedValueOnce(
        guardedResponse(
          new Response(null, { status: 429, headers: { "retry-after": "1" } }),
        ),
      )
      .mockResolvedValueOnce(
        guardedResponse(
          new Response('{"ok":true}', {
            headers: { "content-type": "application/json" },
          }),
        ),
      ) as unknown as typeof fetchWithSsrFGuard;
    const sleep = vi.fn(async () => undefined);
    const client = new QWeatherClient(config(), { guardedFetch, sleep });

    await expect(
      client.getCurrent({ latitude: 23, longitude: 113 }),
    ).resolves.toEqual({ ok: true });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1000, undefined);
  });

  it("rejects advertised and streamed oversized responses", async () => {
    const advertisedFetch = vi.fn(async () =>
      guardedResponse(
        new Response("{}", {
          headers: {
            "content-type": "application/json",
            "content-length": "999",
          },
        }),
      ),
    ) as unknown as typeof fetchWithSsrFGuard;
    const streamedFetch = vi.fn(async () =>
      guardedResponse(
        new Response('{"too":"large"}', {
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetchWithSsrFGuard;

    await expect(
      new QWeatherClient(config(), {
        guardedFetch: advertisedFetch,
        maxResponseBytes: 8,
      }).getCurrent({ latitude: 23, longitude: 113 }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    await expect(
      new QWeatherClient(config(), {
        guardedFetch: streamedFetch,
        maxResponseBytes: 8,
      }).getCurrent({ latitude: 23, longitude: 113 }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
  });

  it("returns only stable public errors", () => {
    const error = new WeatherError("AUTH_FAILED", { cause: TEST_SECRET });
    expect(JSON.stringify(error.toPublicResult())).not.toContain(TEST_SECRET);
  });

  it("derives its base URL from the validated host and ignores extra URL fields", async () => {
    const guardedFetchMock = vi.fn(
      async (_params: Parameters<typeof fetchWithSsrFGuard>[0]) =>
        guardedResponse(
          new Response('{"ok":true}', {
            headers: { "content-type": "application/json" },
          }),
        ),
    );
    const forged = {
      ...config(),
      baseUrl: "https://evil.example",
    };
    const client = new QWeatherClient(forged, {
      guardedFetch: guardedFetchMock,
    });

    await client.getCurrent({ latitude: 23, longitude: 113 });

    expect(guardedFetchMock.mock.calls[0]?.[0].url).toMatch(
      /^https:\/\/example123\.re\.qweatherapi\.com\//u,
    );
  });

  it("classifies OpenClaw's ordinary TimeoutError correctly", async () => {
    const timeout = new Error("internal timeout detail");
    timeout.name = "TimeoutError";
    const guardedFetch = vi.fn(async () => {
      throw timeout;
    }) as unknown as typeof fetchWithSsrFGuard;
    const client = new QWeatherClient(config(), {
      guardedFetch,
      sleep: vi.fn(async () => undefined),
      maxAttempts: 2,
    });

    await expect(
      client.getCurrent({ latitude: 23, longitude: 113 }),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
    expect(guardedFetch).toHaveBeenCalledTimes(2);
  });

  it("normalizes cancellation before a request and during retry wait", async () => {
    const preAborted = new AbortController();
    preAborted.abort("private cancellation reason");
    const neverCalled = vi.fn() as unknown as typeof fetchWithSsrFGuard;
    await expect(
      new QWeatherClient(config(), { guardedFetch: neverCalled }).getCurrent(
        { latitude: 23, longitude: 113 },
        preAborted.signal,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
    expect(neverCalled).not.toHaveBeenCalled();

    const duringRetry = new AbortController();
    const guardedFetch = vi.fn(async () =>
      guardedResponse(new Response(null, { status: 500 })),
    ) as unknown as typeof fetchWithSsrFGuard;
    const client = new QWeatherClient(config(), {
      guardedFetch,
      sleep: vi.fn(async () => {
        duringRetry.abort("private cancellation reason");
        throw duringRetry.signal.reason;
      }),
    });
    await expect(
      client.getCurrent(
        { latitude: 23, longitude: 113 },
        duringRetry.signal,
      ),
    ).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
  });

  it("maps GeoAPI business authentication errors without exposing payloads", async () => {
    const guardedFetch = vi.fn(async () =>
      guardedResponse(
        new Response('{"code":"401","private":"do-not-return"}', {
          headers: { "content-type": "application/json" },
        }),
      ),
    ) as unknown as typeof fetchWithSsrFGuard;
    const client = new QWeatherClient(config(), { guardedFetch });

    await expect(
      client.lookupPlace({ location: "天河区", adm: "广州市" }),
    ).rejects.toMatchObject({ code: "AUTH_FAILED" });
  });

  it("releases guarded resources when JSON parsing fails", async () => {
    const release = vi.fn(async () => undefined);
    const guardedFetch = vi.fn(async () =>
      guardedResponse(
        new Response("{bad json", {
          headers: { "content-type": "application/json" },
        }),
        release,
      ),
    ) as unknown as typeof fetchWithSsrFGuard;
    const client = new QWeatherClient(config(), { guardedFetch });

    await expect(
      client.getCurrent({ latitude: 23, longitude: 113 }),
    ).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it("uses OpenClaw's default SSRF guard to reject private DNS answers", async () => {
    const lookupFn = vi.fn(async () => [
      { address: "10.0.0.1", family: 4 as const },
    ]);

    await expect(
      fetchWithSsrFGuard({
        url: "https://weather-test.example.com/data",
        init: { method: "GET" },
        requireHttps: true,
        maxRedirects: 0,
        capture: false,
        lookupFn: lookupFn as unknown as NonNullable<
          Parameters<typeof fetchWithSsrFGuard>[0]["lookupFn"]
        >,
      }),
    ).rejects.toBeInstanceOf(SsrFBlockedError);
  });
});
