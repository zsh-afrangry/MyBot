import { isIP } from "node:net";

import { WeatherError } from "./errors.js";

export interface PersonalWeatherConfig {
  apiHost: string;
  apiKey: string;
}

interface UnresolvedSecretRef {
  source: "env";
  provider: "default";
  id: string;
}

export interface RawPersonalWeatherConfig {
  apiHost?: unknown;
  apiKey?: unknown | UnresolvedSecretRef;
}

const QWEATHER_DEDICATED_HOST =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+re\.qweatherapi\.com$/u;

export function validateApiHost(value: unknown): string {
  if (typeof value !== "string") {
    throw new WeatherError("CONFIG_INVALID");
  }

  const host = value.trim().toLowerCase();
  if (
    host.length === 0 ||
    host !== value.trim() ||
    host.includes(":") ||
    host.includes("/") ||
    host.includes("@") ||
    host.includes("?") ||
    host.includes("#") ||
    isIP(host) !== 0 ||
    !QWEATHER_DEDICATED_HOST.test(host)
  ) {
    throw new WeatherError("CONFIG_INVALID");
  }

  return host;
}

export function resolvePersonalWeatherConfig(
  raw: RawPersonalWeatherConfig,
): PersonalWeatherConfig {
  const apiHost = validateApiHost(raw.apiHost);
  if (typeof raw.apiKey !== "string") {
    // OpenClaw must resolve SecretRef before plugin execution. Failing closed
    // here avoids accidentally stringifying an unresolved credential object.
    throw new WeatherError("CONFIG_INVALID");
  }

  const apiKey = raw.apiKey.trim();
  if (
    apiKey.length < 8 ||
    apiKey.length > 4096 ||
    /[\u0000-\u001f\u007f]/u.test(apiKey)
  ) {
    throw new WeatherError("CONFIG_INVALID");
  }

  return {
    apiHost,
    apiKey,
  };
}

export function configFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): PersonalWeatherConfig {
  return resolvePersonalWeatherConfig({
    apiHost: env.QWEATHER_API_HOST,
    apiKey: env.QWEATHER_API_KEY,
  });
}

export function buildAuthHeaders(
  config: PersonalWeatherConfig,
): Readonly<Record<string, string>> {
  return { "X-QW-Api-Key": config.apiKey };
}
