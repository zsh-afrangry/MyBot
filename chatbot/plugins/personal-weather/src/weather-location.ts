import { createHash } from "node:crypto";

import { asWeatherError, WeatherError } from "./errors.js";
import { parseQWeatherGeoLookup } from "./parsers.js";
import type { QWeatherClient } from "./qweather-client.js";
import type { QwGeoLocation } from "./types.js";
import type {
  WeatherLocation,
  WeatherLocationCandidate,
} from "./weather-model.js";

export interface WeatherLocationQuery {
  location: string;
  administrativeArea?: string;
}

/**
 * A QWeather location resolved only for this weather read. It deliberately has
 * no local Place id and must not be persisted as a preference, trip, or period.
 */
export interface ResolvedWeatherLocation {
  weatherLocation: WeatherLocation;
  cacheIdentity: string;
  attributions: string[];
}

/**
 * Canonical place data suitable for the owner's confirmed Profile. This is an
 * internal persistence shape, never a model-provided identifier contract.
 */
export interface ProfileLocationRecord {
  placeKey: string;
  displayName: string;
  countryCode: string;
  adm1: string | null;
  adm2: string | null;
  district: string | null;
  /** Raw GeoAPI leaf name; do not infer this from the provider type. */
  localityName: string;
  latitude: number;
  longitude: number;
  timezone: string;
  precision: "city" | "district" | "point";
  qweatherLocationId: string;
}

export interface ResolvedProfileLocation {
  location: ProfileLocationRecord;
  attributions: string[];
}

export type WeatherLocationResolution =
  | { kind: "resolved"; location: ResolvedWeatherLocation }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: WeatherLocationCandidate[] };

export type ProfileLocationResolution =
  | { kind: "resolved"; location: ResolvedProfileLocation }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: WeatherLocationCandidate[] };

type ResolvedCandidate = {
  candidate: QwGeoLocation;
  attributions: string[];
};

type CandidateResolution =
  | { kind: "resolved"; location: ResolvedCandidate }
  | { kind: "not_found" }
  | { kind: "ambiguous"; candidates: WeatherLocationCandidate[] };

const MAX_LOCATION_TEXT_LENGTH = 80;

export async function resolveWeatherLocation(
  client: QWeatherClient,
  input: WeatherLocationQuery,
  signal?: AbortSignal,
): Promise<WeatherLocationResolution> {
  const resolved = await resolveLocationCandidate(client, input, signal);
  if (resolved.kind !== "resolved") return resolved;

  return {
    kind: "resolved",
    location: {
      weatherLocation: toWeatherLocation(resolved.location.candidate),
      cacheIdentity: "geo:" + createHash("sha256")
        .update(resolved.location.candidate.id)
        .digest("hex"),
      attributions: resolved.location.attributions,
    },
  };
}

/** Resolve one trusted GeoAPI candidate for a durable Profile location update. */
export async function resolveProfileLocation(
  client: QWeatherClient,
  input: WeatherLocationQuery,
  signal?: AbortSignal,
): Promise<ProfileLocationResolution> {
  const resolved = await resolveLocationCandidate(client, input, signal);
  if (resolved.kind !== "resolved") return resolved;

  return {
    kind: "resolved",
    location: {
      location: toProfileLocation(resolved.location.candidate),
      attributions: resolved.location.attributions,
    },
  };
}

async function resolveLocationCandidate(
  client: QWeatherClient,
  input: WeatherLocationQuery,
  signal?: AbortSignal,
): Promise<CandidateResolution> {
  const location = validateQueryText(input.location);
  const administrativeArea = input.administrativeArea === undefined
    ? undefined
    : validateQueryText(input.administrativeArea);

  let payload: unknown;
  try {
    payload = await client.lookupPlace(
      administrativeArea === undefined
        ? { location }
        : { location, adm: administrativeArea },
      signal,
    );
  } catch (error) {
    const weatherError = asWeatherError(error);
    if (weatherError.code === "NO_DATA") {
      return { kind: "not_found" };
    }
    throw weatherError;
  }

  const parsed = parseQWeatherGeoLookup(payload);
  if (!parsed.ok) {
    throw new WeatherError("INVALID_RESPONSE");
  }
  if (parsed.data.code !== "200") {
    return { kind: "not_found" };
  }
  if (parsed.data.locations.length === 0) {
    const invalidCandidates = parsed.warnings.some(
      (warning) =>
        warning.code === "dropped_item" && warning.path.startsWith("$.location["),
    );
    if (invalidCandidates) {
      throw new WeatherError("INVALID_RESPONSE");
    }
    return { kind: "not_found" };
  }

  const selected = selectCandidate(
    parsed.data.locations,
    location,
    administrativeArea,
  );
  if (!selected) {
    return {
      kind: "ambiguous",
      candidates: parsed.data.locations.slice(0, 5).map(toCandidate),
    };
  }

  return {
    kind: "resolved",
    location: {
      candidate: selected,
      attributions: [...new Set(parsed.data.attributions)].slice(0, 32),
    },
  };
}

function selectCandidate(
  candidates: QwGeoLocation[],
  location: string,
  administrativeArea: string | undefined,
): QwGeoLocation | undefined {
  if (candidates.length === 1) {
    return candidates[0];
  }

  const exactName = candidates.filter((candidate) =>
    comparableText(candidate.name) === comparableText(location)
  );
  const narrowed = administrativeArea === undefined
    ? exactName
    : exactName.filter((candidate) =>
      candidateMatchesAdministrativeArea(candidate, administrativeArea)
    );
  return narrowed.length === 1 ? narrowed[0] : undefined;
}

function toWeatherLocation(candidate: QwGeoLocation): WeatherLocation {
  const displayParts = uniqueTexts([candidate.adm1, candidate.adm2, candidate.name]);
  const shortParts = uniqueTexts([
    withoutAdministrativeSuffix(candidate.adm2),
    withoutAdministrativeSuffix(candidate.name),
  ]);
  return {
    displayName: displayParts.join(""),
    shortName: shortParts.join(""),
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    timezone: candidate.timezone,
    qweatherLocationId: candidate.id,
  };
}

function toProfileLocation(candidate: QwGeoLocation): ProfileLocationRecord {
  return {
    placeKey: `qweather:${candidate.id}`,
    displayName: uniqueTexts([candidate.adm1, candidate.adm2, candidate.name]).join(""),
    countryCode: countryCodeFor(candidate.country),
    adm1: candidate.adm1 || null,
    adm2: candidate.adm2 || null,
    district: precisionFor(candidate) === "district" ? candidate.name : null,
    localityName: candidate.name,
    latitude: candidate.latitude,
    longitude: candidate.longitude,
    timezone: candidate.timezone,
    precision: precisionFor(candidate),
    qweatherLocationId: candidate.id,
  };
}

function countryCodeFor(country: string): string {
  const normalized = country.trim().toLocaleLowerCase("zh-CN");
  return normalized === "中国" || normalized === "china" || normalized === "cn"
    ? "CN"
    : "ZZ";
}

function precisionFor(candidate: QwGeoLocation): ProfileLocationRecord["precision"] {
  const type = candidate.type?.trim().toLocaleLowerCase("en-US") ?? "";
  if (type.includes("district")) return "district";
  if (type.includes("city")) return "city";
  return "point";
}

function toCandidate(candidate: QwGeoLocation): WeatherLocationCandidate {
  return {
    displayName: uniqueTexts([candidate.adm1, candidate.adm2, candidate.name]).join(""),
    administrativeArea: uniqueTexts([candidate.adm1, candidate.adm2]).join("、"),
    country: candidate.country,
    timezone: candidate.timezone,
  };
}

function candidateMatchesAdministrativeArea(
  candidate: QwGeoLocation,
  administrativeArea: string,
): boolean {
  const expected = comparableText(administrativeArea);
  return [
    candidate.adm1,
    candidate.adm2,
    candidate.country,
    candidate.adm1 + candidate.adm2,
    candidate.adm2 + candidate.adm1,
  ].some((value) => comparableText(value) === expected);
}

function validateQueryText(value: string): string {
  const normalized = value.trim();
  if (
    normalized.length < 1 ||
    normalized.length > MAX_LOCATION_TEXT_LENGTH ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new WeatherError("CONFIG_INVALID");
  }
  return normalized;
}

function comparableText(value: string): string {
  return withoutAdministrativeSuffix(
    value
      .trim()
      .toLocaleLowerCase("zh-CN")
      .replace(/[\s　·・,，、/\\-]+/gu, ""),
  );
}

function withoutAdministrativeSuffix(value: string): string {
  return value.replace(/(?:特别行政区|自治区|自治州|省|市|区|县|旗)$/u, "");
}

function uniqueTexts(values: string[]): string[] {
  const result: string[] = [];
  for (const value of values) {
    const normalized = value.trim();
    if (normalized && !result.includes(normalized)) {
      result.push(normalized);
    }
  }
  return result;
}
