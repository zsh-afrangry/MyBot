#!/usr/bin/env node

import { pathToFileURL } from "node:url";

import { configFromEnvironment } from "./config.js";
import { asWeatherError, WeatherError } from "./errors.js";
import { formatWeatherBrief } from "./formatter.js";
import {
  parseQWeatherGeoLookup,
} from "./parsers.js";
import { weatherStateDirectory } from "./paths.js";
import { QWeatherClient } from "./qweather-client.js";
import { WeatherStore } from "./store.js";
import { WeatherService } from "./weather-service.js";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command, ...args] = argv;
  try {
    switch (command) {
      case "db:init":
        return initializeDatabase();
      case "health":
        return health();
      case "lookup":
        return await lookup(args);
      case "brief":
        return await brief(args.includes("--json"), false);
      case "daily-brief":
        return await brief(false, true);
      default:
        printJson({
          ok: false,
          code: "USAGE",
          commands: [
            "health",
            "db:init",
            "lookup --location <district> --adm <city>",
            "brief [--json]",
            "daily-brief",
          ],
        });
        return 2;
    }
  } catch (error) {
    printJson(asWeatherError(error).toPublicResult());
    return 1;
  }
}

function initializeDatabase(): number {
  const store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
  try {
    const place = store.getDefaultPlace();
    printJson({
      ok: true,
      databaseReady: true,
      defaultLocation: place.displayName,
      qweatherLocationId: place.qweatherLocationId,
    });
    return 0;
  } finally {
    store.close();
  }
}

function health(): number {
  configFromEnvironment();
  const store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
  try {
    const place = store.getEffectivePlace(Math.floor(Date.now() / 1000)).place;
    printJson({
      ok: true,
      configured: true,
      databaseReady: true,
      effectiveLocation: place.displayName,
      networkChecked: false,
    });
    return 0;
  } finally {
    store.close();
  }
}

async function lookup(args: string[]): Promise<number> {
  const location = readFlag(args, "--location");
  const adm = readFlag(args, "--adm");
  if (!location || !adm) {
    throw new WeatherError("CONFIG_INVALID");
  }
  const client = new QWeatherClient(configFromEnvironment());
  const parsed = parseQWeatherGeoLookup(
    await client.lookupPlace({ location, adm }),
  );
  if (!parsed.ok) {
    throw new WeatherError("INVALID_RESPONSE");
  }
  printJson({
    ok: true,
    candidates: parsed.data.locations.slice(0, 5),
    attributions: parsed.data.attributions,
    warnings: parsed.warnings.map((warning) => warning.code),
  });
  return 0;
}

async function brief(json: boolean, greeting: boolean): Promise<number> {
  const store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
  try {
    const client = new QWeatherClient(configFromEnvironment());
    const result = await new WeatherService(store, client).getBrief();
    if (json) {
      printJson({ ok: true, brief: result });
    } else {
      process.stdout.write(`${formatWeatherBrief(result, { greeting })}\n`);
    }
    return 0;
  } finally {
    store.close();
  }
}

function readFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  const value = index >= 0 ? args[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
