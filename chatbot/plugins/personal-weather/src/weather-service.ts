import { WeatherError, asWeatherError } from "./errors.js";
import {
  parseQWeatherAlerts,
  parseQWeatherCurrent,
  parseQWeatherDaily,
  parseQWeatherHourly,
} from "./parsers.js";
import type { QWeatherClient } from "./qweather-client.js";
import type { EffectivePlace, WeatherStore } from "./store.js";
import type {
  ParseIssue,
  QwDailyItem,
  QwHourlyItem,
  QwPrecipitation,
} from "./types.js";
import type {
  ComponentQuality,
  RainWindow,
  WeatherBrief,
  WeatherLocation,
} from "./weather-model.js";

export interface WeatherServiceOptions {
  now?: () => number;
}

const CACHE_TTL_SECONDS = {
  current: 10 * 60,
  daily: 60 * 60,
  hourly: 30 * 60,
  alerts: 5 * 60,
} as const;

interface LoadedComponent {
  payload: unknown;
  quality: ComponentQuality;
}

export class WeatherService {
  readonly #store: WeatherStore;
  readonly #client: QWeatherClient;
  readonly #now: () => number;

  constructor(
    store: WeatherStore,
    client: QWeatherClient,
    options: WeatherServiceOptions = {},
  ) {
    this.#store = store;
    this.#client = client;
    this.#now = options.now ?? Date.now;
  }

  async getBrief(signal?: AbortSignal): Promise<WeatherBrief> {
    const nowMs = this.#now();
    const generatedAt = new Date(nowMs).toISOString();
    const nowUtc = Math.floor(nowMs / 1000);
    const effective = this.#store.getEffectivePlace(Math.floor(nowMs / 1000));
    this.#store.deleteExpiredApiCache(nowUtc);
    const coordinates = {
      latitude: effective.place.latitude,
      longitude: effective.place.longitude,
    };

    const [currentResult, dailyResult, hourlyResult, alertsResult] =
      await Promise.allSettled([
        this.#loadComponent(
          "current",
          `v1:current:${effective.place.id}`,
          effective.place.id,
          CACHE_TTL_SECONDS.current,
          () => this.#client.getCurrent(coordinates, signal),
          (payload) => parseQWeatherCurrent(payload).ok,
          nowUtc,
        ),
        this.#loadComponent(
          "daily",
          `v1:daily:${effective.place.id}:${localDateKey(nowMs, effective.place.timezone)}`,
          effective.place.id,
          CACHE_TTL_SECONDS.daily,
          () => this.#client.getDaily(coordinates, signal),
          (payload) => parseQWeatherDaily(payload).ok,
          nowUtc,
        ),
        this.#loadComponent(
          "hourly",
          `v1:hourly:${effective.place.id}`,
          effective.place.id,
          CACHE_TTL_SECONDS.hourly,
          () => this.#client.getHourly(coordinates, signal),
          (payload) => parseQWeatherHourly(payload).ok,
          nowUtc,
        ),
        this.#loadComponent(
          "alerts",
          `v1:alerts:${effective.place.id}`,
          effective.place.id,
          CACHE_TTL_SECONDS.alerts,
          () => this.#client.getAlerts(coordinates, signal),
          (payload) => parseQWeatherAlerts(payload).ok,
          nowUtc,
        ),
      ]);

    if (currentResult.status === "rejected") {
      throw asWeatherError(currentResult.reason);
    }
    const current = parseQWeatherCurrent(currentResult.value.payload);
    if (!current.ok) {
      throw new WeatherError("INVALID_RESPONSE");
    }

    const warnings = issuesToWarnings("current", current.warnings);
    const quality: WeatherBrief["quality"] = {
      current: currentResult.value.quality,
      daily: unavailableQuality(),
      hourly: unavailableQuality(),
      alerts: unavailableQuality(),
    };
    const attributions = new Set(current.data.metadata.attributions);

    let today: WeatherBrief["today"];
    if (dailyResult.status === "fulfilled") {
      const parsed = parseQWeatherDaily(dailyResult.value.payload);
      if (parsed.ok) {
        quality.daily = dailyResult.value.quality;
        addAttributions(attributions, parsed.data.metadata.attributions);
        warnings.push(...issuesToWarnings("daily", parsed.warnings));
        const selected = selectToday(parsed.data.days, nowMs);
        if (selected) {
          today = {
            forecastStartTime: selected.forecastStartTime,
            forecastEndTime: selected.forecastEndTime,
            temperatureMax: selected.temperatureMax,
            temperatureMin: selected.temperatureMin,
            ...(selected.daytime?.condition
              ? { daytimeCondition: selected.daytime.condition }
              : {}),
            ...(selected.nighttime?.condition
              ? { nighttimeCondition: selected.nighttime.condition }
              : {}),
            ...(selected.uvIndexMax !== undefined
              ? { uvIndexMax: selected.uvIndexMax }
              : {}),
          };
        } else {
          warnings.push("daily:no_period_for_current_time");
        }
      } else {
        warnings.push(...issuesToWarnings("daily", parsed.issues));
        quality.daily = unavailableQuality("INVALID_RESPONSE");
      }
    } else {
      quality.daily = unavailableQuality(asWeatherError(dailyResult.reason).code);
    }

    let next24Hours: WeatherBrief["next24Hours"];
    if (hourlyResult.status === "fulfilled") {
      const parsed = parseQWeatherHourly(hourlyResult.value.payload);
      if (parsed.ok) {
        quality.hourly = hourlyResult.value.quality;
        addAttributions(attributions, parsed.data.metadata.attributions);
        warnings.push(...issuesToWarnings("hourly", parsed.warnings));
        next24Hours = summarizeNext24Hours(parsed.data.hours, nowMs);
      } else {
        warnings.push(...issuesToWarnings("hourly", parsed.issues));
        quality.hourly = unavailableQuality("INVALID_RESPONSE");
      }
    } else {
      quality.hourly = unavailableQuality(asWeatherError(hourlyResult.reason).code);
    }

    let alerts: WeatherBrief["alerts"] = {
      availability: "unavailable",
      state: "unavailable",
      items: [],
    };
    if (alertsResult.status === "fulfilled") {
      const parsed = parseQWeatherAlerts(alertsResult.value.payload);
      if (parsed.ok) {
        quality.alerts = alertsResult.value.quality;
        addAttributions(attributions, parsed.data.metadata.attributions);
        warnings.push(...issuesToWarnings("alerts", parsed.warnings));
        alerts = {
          availability: "available",
          state: parsed.data.state,
          items: parsed.data.alerts,
        };
        if (parsed.data.state === "indeterminate") {
          warnings.push("alerts:indeterminate_response");
        }
      } else {
        warnings.push(...issuesToWarnings("alerts", parsed.issues));
        quality.alerts = unavailableQuality("INVALID_RESPONSE");
      }
    } else {
      quality.alerts = unavailableQuality(asWeatherError(alertsResult.reason).code);
    }

    return {
      schemaVersion: 1,
      location: toWeatherLocation(effective),
      generatedAt,
      current: {
        condition: current.data.condition,
        temperature: current.data.temperature,
        ...(current.data.feelsLike ? { feelsLike: current.data.feelsLike } : {}),
        ...(current.data.humidity !== undefined
          ? { humidity: current.data.humidity }
          : {}),
        ...(current.data.wind ? { wind: current.data.wind } : {}),
        ...(current.data.precipitation
          ? { precipitation: current.data.precipitation }
          : {}),
        ...(current.data.uvIndex !== undefined
          ? { uvIndex: current.data.uvIndex }
          : {}),
      },
      ...(today ? { today } : {}),
      ...(next24Hours ? { next24Hours } : {}),
      alerts,
      attributions: [...attributions],
      quality,
      warnings: [...new Set(warnings)].slice(0, 100),
    };
  }

  async #loadComponent(
    endpointKind: keyof typeof CACHE_TTL_SECONDS,
    cacheKey: string,
    placeId: number,
    ttlSeconds: number,
    fetcher: () => Promise<unknown>,
    validator: (payload: unknown) => boolean,
    nowUtc: number,
  ): Promise<LoadedComponent> {
    const cached = this.#store.getFreshApiCache(cacheKey, nowUtc);
    if (cached && validator(cached.payload)) {
      return {
        payload: cached.payload,
        quality: {
          state: "cached-fresh",
          fetchedAt: new Date(cached.fetchedAtUtc * 1000).toISOString(),
        },
      };
    }
    if (cached) {
      this.#store.deleteApiCache(cacheKey);
    }

    const payload = await fetcher();
    if (!validator(payload)) {
      throw new WeatherError("INVALID_RESPONSE");
    }
    const tag = metadataTag(payload);
    this.#store.putApiCache({
      cacheKey,
      endpointKind,
      placeId,
      ...(tag ? { metadataTag: tag } : {}),
      fetchedAtUtc: nowUtc,
      expiresAtUtc: nowUtc + ttlSeconds,
      payload,
    });
    return {
      payload,
      quality: freshQuality(new Date(nowUtc * 1000).toISOString()),
    };
  }
}

function toWeatherLocation(effective: EffectivePlace): WeatherLocation {
  const { place } = effective;
  return {
    displayName: place.displayName,
    shortName: [place.adm2?.replace(/[市]$/u, ""), place.district?.replace(/[区县]$/u, "")]
      .filter(Boolean)
      .join(""),
    latitude: place.latitude,
    longitude: place.longitude,
    timezone: place.timezone,
    ...(place.qweatherLocationId
      ? { qweatherLocationId: place.qweatherLocationId }
      : {}),
  };
}

function freshQuality(fetchedAt: string): ComponentQuality {
  return { state: "fresh", fetchedAt };
}

function metadataTag(value: unknown): string | undefined {
  if (
    typeof value === "object" &&
    value !== null &&
    "metadata" in value &&
    typeof value.metadata === "object" &&
    value.metadata !== null &&
    "tag" in value.metadata &&
    typeof value.metadata.tag === "string"
  ) {
    return value.metadata.tag.slice(0, 500);
  }
  return undefined;
}

function localDateKey(nowMs: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(nowMs));
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function unavailableQuality(publicErrorCode?: string): ComponentQuality {
  return {
    state: "unavailable",
    ...(publicErrorCode ? { publicErrorCode } : {}),
  };
}

function addAttributions(target: Set<string>, values: string[]): void {
  for (const value of values) {
    target.add(value);
  }
}

function issuesToWarnings(component: string, issues: ParseIssue[]): string[] {
  return issues.slice(0, 30).map((issue) => `${component}:${issue.path}:${issue.code}`);
}

function selectToday(days: QwDailyItem[], nowMs: number): QwDailyItem | undefined {
  return days.find((day) => {
    const start = Date.parse(day.forecastStartTime);
    const end = Date.parse(day.forecastEndTime);
    return start <= nowMs && nowMs < end;
  });
}

function summarizeNext24Hours(
  hours: QwHourlyItem[],
  nowMs: number,
): NonNullable<WeatherBrief["next24Hours"]> {
  const untilMs = nowMs + 24 * 60 * 60 * 1000;
  const relevant = hours
    .filter((hour) => {
      const at = Date.parse(hour.forecastTime);
      return at >= nowMs && at < untilMs;
    })
    .sort((a, b) => Date.parse(a.forecastTime) - Date.parse(b.forecastTime));

  const probabilities = relevant
    .map((hour) => hour.precipitation?.probability)
    .filter((value): value is number => value !== undefined);
  const rainWindows = buildRainWindows(relevant);

  return {
    availableHours: relevant.length,
    ...(probabilities.length > 0
      ? { maxPrecipitationProbability: Math.max(...probabilities) }
      : {}),
    rainWindows,
  };
}

function buildRainWindows(hours: QwHourlyItem[]): RainWindow[] {
  const windows: RainWindow[] = [];
  let active:
    | {
        startMs: number;
        lastMs: number;
        maxProbability?: number;
        precipitationType?: string;
      }
    | undefined;

  const flush = () => {
    if (!active) {
      return;
    }
    windows.push({
      startTime: new Date(active.startMs).toISOString(),
      endTime: new Date(active.lastMs + 60 * 60 * 1000).toISOString(),
      ...(active.maxProbability !== undefined
        ? { maxProbability: active.maxProbability }
        : {}),
      ...(active.precipitationType
        ? { precipitationType: active.precipitationType }
        : {}),
    });
    active = undefined;
  };

  for (const hour of hours) {
    const at = Date.parse(hour.forecastTime);
    const precipitation = hour.precipitation;
    if (!precipitationLooksPossible(precipitation)) {
      flush();
      continue;
    }
    if (!active || at - active.lastMs > 90 * 60 * 1000) {
      flush();
      active = { startMs: at, lastMs: at };
    } else {
      active.lastMs = at;
    }
    if (precipitation?.probability !== undefined) {
      active.maxProbability = Math.max(
        active.maxProbability ?? 0,
        precipitation.probability,
      );
    }
    if (precipitation?.type && precipitation.type.toLowerCase() !== "none") {
      active.precipitationType = precipitation.type;
    }
  }
  flush();
  return windows.slice(0, 12);
}

function precipitationLooksPossible(value?: QwPrecipitation): boolean {
  if (!value) {
    return false;
  }
  if (value.probability !== undefined && value.probability >= 0.3) {
    return true;
  }
  if (value.amount?.value !== undefined && value.amount.value > 0) {
    return true;
  }
  return Boolean(value.type && !["none", "unknown"].includes(value.type.toLowerCase()));
}
