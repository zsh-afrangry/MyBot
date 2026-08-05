import { fetchWithSsrFGuard } from "openclaw/plugin-sdk/ssrf-runtime";

import {
  buildAuthHeaders,
  resolvePersonalWeatherConfig,
  type PersonalWeatherConfig,
} from "./config.js";
import { asWeatherError, WeatherError } from "./errors.js";

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface GeoLookupInput {
  location: string;
  adm: string;
}

type GuardedFetch = typeof fetchWithSsrFGuard;
type Sleep = (milliseconds: number, signal?: AbortSignal) => Promise<void>;

export interface QWeatherClientOptions {
  guardedFetch?: GuardedFetch;
  sleep?: Sleep;
  now?: () => number;
  requestTimeoutMs?: number;
  totalBudgetMs?: number;
  maxAttempts?: number;
  maxResponseBytes?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 8_000;
const DEFAULT_TOTAL_BUDGET_MS = 20_000;
const DEFAULT_MAX_RESPONSE_BYTES = 1024 * 1024;
const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const GLOBAL_MAX_IN_FLIGHT = 4;

let globalInFlight = 0;
const globalWaiters: Array<{
  resolve: (release: () => void) => void;
  reject: (error: WeatherError) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
}> = [];

class RetryableWeatherError extends WeatherError {
  readonly retryAfterMs: number | undefined;

  constructor(
    code: "RATE_LIMITED" | "UPSTREAM_UNAVAILABLE",
    retryAfterMs?: number,
  ) {
    super(code, { retryable: true });
    this.retryAfterMs = retryAfterMs;
  }
}

export class QWeatherClient {
  readonly #config: PersonalWeatherConfig;
  readonly #baseUrl: string;
  readonly #guardedFetch: GuardedFetch;
  readonly #sleep: Sleep;
  readonly #now: () => number;
  readonly #requestTimeoutMs: number;
  readonly #totalBudgetMs: number;
  readonly #maxAttempts: number;
  readonly #maxResponseBytes: number;

  constructor(config: PersonalWeatherConfig, options: QWeatherClientOptions = {}) {
    // Re-validate even typed callers, then derive the URL internally. This
    // prevents a future caller from smuggling a second, inconsistent base URL.
    this.#config = resolvePersonalWeatherConfig(config);
    this.#baseUrl = `https://${this.#config.apiHost}`;
    this.#guardedFetch = options.guardedFetch ?? fetchWithSsrFGuard;
    this.#sleep = options.sleep ?? abortableSleep;
    this.#now = options.now ?? Date.now;
    this.#requestTimeoutMs = positiveInteger(
      options.requestTimeoutMs,
      DEFAULT_REQUEST_TIMEOUT_MS,
    );
    this.#totalBudgetMs = positiveInteger(
      options.totalBudgetMs,
      DEFAULT_TOTAL_BUDGET_MS,
    );
    this.#maxAttempts = positiveInteger(options.maxAttempts, 3);
    this.#maxResponseBytes = positiveInteger(
      options.maxResponseBytes,
      DEFAULT_MAX_RESPONSE_BYTES,
    );
  }

  getCurrent(coordinates: Coordinates, signal?: AbortSignal): Promise<unknown> {
    const { latitude, longitude } = validateCoordinates(coordinates);
    return this.#requestJson(
      `/weather/v1/current/${formatCoordinate(latitude, 4)}/${formatCoordinate(longitude, 4)}`,
      { localTime: "true", lang: "zh" },
      signal,
    );
  }

  getDaily(coordinates: Coordinates, signal?: AbortSignal): Promise<unknown> {
    const { latitude, longitude } = validateCoordinates(coordinates);
    return this.#requestJson(
      `/weather/v1/daily/${formatCoordinate(latitude, 4)}/${formatCoordinate(longitude, 4)}`,
      { days: "3", localTime: "true", lang: "zh" },
      signal,
    );
  }

  getHourly(coordinates: Coordinates, signal?: AbortSignal): Promise<unknown> {
    const { latitude, longitude } = validateCoordinates(coordinates);
    return this.#requestJson(
      `/weather/v1/hourly/${formatCoordinate(latitude, 4)}/${formatCoordinate(longitude, 4)}`,
      { hours: "24", localTime: "true", lang: "zh" },
      signal,
    );
  }

  getAlerts(coordinates: Coordinates, signal?: AbortSignal): Promise<unknown> {
    const { latitude, longitude } = validateCoordinates(coordinates);
    return this.#requestJson(
      `/weatheralert/v1/current/${formatCoordinate(latitude, 2)}/${formatCoordinate(longitude, 2)}`,
      { localTime: "true", lang: "zh" },
      signal,
    );
  }

  async lookupPlace(input: GeoLookupInput, signal?: AbortSignal): Promise<unknown> {
    const location = validateLookupText(input.location);
    const adm = validateLookupText(input.adm);
    const payload = await this.#requestJson(
      "/geo/v2/city/lookup",
      { location, adm, range: "cn", number: "5", lang: "zh" },
      signal,
    );
    assertGeoApiBusinessStatus(payload);
    return payload;
  }

  async #requestJson(
    path: string,
    query: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const startedAt = this.#now();
    let lastError: WeatherError | undefined;

    for (let attempt = 1; attempt <= this.#maxAttempts; attempt += 1) {
      if (signal?.aborted) {
        throw new WeatherError("REQUEST_CANCELLED", { cause: signal.reason });
      }
      const remaining = this.#totalBudgetMs - (this.#now() - startedAt);
      if (remaining <= 0) {
        throw new WeatherError("TIMEOUT", { retryable: true, cause: lastError });
      }

      try {
        return await this.#requestOnce(
          path,
          query,
          Math.min(this.#requestTimeoutMs, remaining),
          signal,
        );
      } catch (error) {
        const weatherError = asWeatherError(error);
        lastError = weatherError;
        if (!weatherError.retryable || attempt >= this.#maxAttempts) {
          throw weatherError;
        }

        const retryDelay =
          error instanceof RetryableWeatherError && error.retryAfterMs !== undefined
            ? error.retryAfterMs
            : 250 * 2 ** (attempt - 1);
        const budgetAfterDelay =
          this.#totalBudgetMs - (this.#now() - startedAt) - retryDelay;
        if (budgetAfterDelay <= 0) {
          throw new WeatherError("TIMEOUT", {
            retryable: true,
            cause: weatherError,
          });
        }
        try {
          await this.#sleep(retryDelay, signal);
        } catch (error) {
          if (signal?.aborted) {
            throw new WeatherError("REQUEST_CANCELLED", { cause: error });
          }
          throw asWeatherError(error);
        }
      }
    }

    throw lastError ?? new WeatherError("UPSTREAM_UNAVAILABLE", { retryable: true });
  }

  async #requestOnce(
    path: string,
    query: Readonly<Record<string, string>>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    return withGlobalRequestPermit(signal, async () =>
      this.#requestOnceWithPermit(path, query, timeoutMs, signal),
    );
  }

  async #requestOnceWithPermit(
    path: string,
    query: Readonly<Record<string, string>>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<unknown> {
    const url = new URL(path, this.#baseUrl);
    for (const [key, value] of Object.entries(query)) {
      url.searchParams.set(key, value);
    }

    let guarded:
      | Awaited<ReturnType<typeof fetchWithSsrFGuard>>
      | undefined;
    try {
      guarded = await this.#guardedFetch({
        url: url.toString(),
        init: {
          method: "GET",
          redirect: "manual",
          headers: {
            Accept: "application/json",
            ...buildAuthHeaders(this.#config),
          },
        },
        requireHttps: true,
        maxRedirects: 0,
        timeoutMs,
        ...(signal ? { signal } : {}),
        capture: false,
        auditContext: "personal-weather:qweather",
      });

      const response = guarded.response;
      if (response.status >= 300 && response.status < 400) {
        throw new WeatherError("INVALID_RESPONSE");
      }
      if (response.status === 204) {
        throw new WeatherError("NO_DATA");
      }
      if (!response.ok) {
        throw mapHttpStatus(response);
      }

      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json") && !contentType.includes("+json")) {
        throw new WeatherError("INVALID_RESPONSE");
      }

      const text = await readBoundedText(response, this.#maxResponseBytes);
      if (text.trim().length === 0) {
        throw new WeatherError("NO_DATA");
      }
      try {
        return JSON.parse(text) as unknown;
      } catch (error) {
        throw new WeatherError("INVALID_RESPONSE", { cause: error });
      }
    } catch (error) {
      if (signal?.aborted) {
        throw new WeatherError("REQUEST_CANCELLED", { cause: error });
      }
      if (error instanceof Error && error.name === "TimeoutError") {
        throw new WeatherError("TIMEOUT", { retryable: true, cause: error });
      }
      if (error instanceof Error && error.name === "AbortError") {
        throw new WeatherError("TIMEOUT", { retryable: true, cause: error });
      }
      throw asWeatherError(error);
    } finally {
      await guarded?.release();
    }
  }
}

function mapHttpStatus(response: Response): WeatherError {
  switch (response.status) {
    case 401:
      return new WeatherError("AUTH_FAILED");
    case 403:
      return new WeatherError("FORBIDDEN");
    case 429:
      return new RetryableWeatherError(
        "RATE_LIMITED",
        parseRetryAfter(response.headers.get("retry-after")),
      );
    default:
      if (RETRYABLE_STATUS.has(response.status)) {
        return new RetryableWeatherError("UPSTREAM_UNAVAILABLE");
      }
      return new WeatherError("UPSTREAM_UNAVAILABLE");
  }
}

async function readBoundedText(
  response: Response,
  maxBytes: number,
): Promise<string> {
  const advertisedLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(advertisedLength) && advertisedLength > maxBytes) {
    throw new WeatherError("INVALID_RESPONSE");
  }

  if (!response.body) {
    return "";
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let total = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WeatherError("INVALID_RESPONSE");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } catch (error) {
    if (error instanceof WeatherError) {
      throw error;
    }
    throw new WeatherError("INVALID_RESPONSE", { cause: error });
  } finally {
    reader.releaseLock();
  }
}

function validateCoordinates(coordinates: Coordinates): Coordinates {
  const { latitude, longitude } = coordinates;
  if (
    !Number.isFinite(latitude) ||
    !Number.isFinite(longitude) ||
    latitude < -90 ||
    latitude > 90 ||
    longitude < -180 ||
    longitude > 180
  ) {
    throw new WeatherError("CONFIG_INVALID");
  }
  return coordinates;
}

function formatCoordinate(value: number, fractionDigits: number): string {
  const rounded = value.toFixed(fractionDigits);
  return rounded === "-0.0000" || rounded === "-0.00" ? rounded.slice(1) : rounded;
}

function validateLookupText(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > 80 ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new WeatherError("CONFIG_INVALID");
  }
  return normalized;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function parseRetryAfter(value: string | null): number | undefined {
  if (!value) {
    return undefined;
  }
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return Math.min(seconds * 1000, 10_000);
  }
  const at = Date.parse(value);
  if (!Number.isFinite(at)) {
    return undefined;
  }
  return Math.min(Math.max(at - Date.now(), 0), 10_000);
}

function assertGeoApiBusinessStatus(value: unknown): void {
  if (!isRecord(value) || typeof value.code !== "string") {
    throw new WeatherError("INVALID_RESPONSE");
  }
  switch (value.code) {
    case "200":
      return;
    case "204":
    case "404":
      throw new WeatherError("NO_DATA");
    case "401":
      throw new WeatherError("AUTH_FAILED");
    case "403":
      throw new WeatherError("FORBIDDEN");
    case "429":
      throw new WeatherError("RATE_LIMITED", { retryable: true });
    default:
      throw new WeatherError("UPSTREAM_UNAVAILABLE", {
        retryable: /^5\d\d$/u.test(value.code),
      });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function withGlobalRequestPermit<T>(
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  const release = await acquireGlobalRequestPermit(signal);
  try {
    return await operation();
  } finally {
    release();
  }
}

function acquireGlobalRequestPermit(
  signal?: AbortSignal,
): Promise<() => void> {
  if (signal?.aborted) {
    return Promise.reject(
      new WeatherError("REQUEST_CANCELLED", { cause: signal.reason }),
    );
  }
  if (globalInFlight < GLOBAL_MAX_IN_FLIGHT) {
    globalInFlight += 1;
    return Promise.resolve(createGlobalRelease());
  }

  return new Promise((resolve, reject) => {
    const waiter: (typeof globalWaiters)[number] = {
      resolve,
      reject,
      ...(signal ? { signal } : {}),
    };
    waiter.onAbort = () => {
      const index = globalWaiters.indexOf(waiter);
      if (index >= 0) {
        globalWaiters.splice(index, 1);
      }
      reject(new WeatherError("REQUEST_CANCELLED", { cause: signal?.reason }));
    };
    signal?.addEventListener("abort", waiter.onAbort, { once: true });
    globalWaiters.push(waiter);
  });
}

function createGlobalRelease(): () => void {
  let released = false;
  return () => {
    if (released) {
      return;
    }
    released = true;
    globalInFlight -= 1;

    while (globalWaiters.length > 0) {
      const waiter = globalWaiters.shift();
      if (!waiter) {
        break;
      }
      waiter.signal?.removeEventListener("abort", waiter.onAbort ?? (() => undefined));
      if (waiter.signal?.aborted) {
        waiter.reject(
          new WeatherError("REQUEST_CANCELLED", { cause: waiter.signal.reason }),
        );
        continue;
      }
      globalInFlight += 1;
      waiter.resolve(createGlobalRelease());
      break;
    }
  };
}

function abortableSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason);
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      cleanup();
      reject(signal?.reason);
    };
    const cleanup = () => signal?.removeEventListener("abort", onAbort);
    const timer = setTimeout(() => {
      cleanup();
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}
