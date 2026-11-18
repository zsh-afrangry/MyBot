import type { Static } from "typebox";

import { resolvePersonalWeatherConfig, type RawPersonalWeatherConfig } from "./config.js";
import type { geoConfigSchema } from "./geo-config-schema.js";
import { KnowledgeMapWeatherClient } from "./knowledgemap-client.js";
import { personalStateDirectory } from "./paths.js";
import { getPlanningState, type PlanningState } from "./planning.js";
import { QWeatherClient } from "./qweather-client.js";
import { ReminderStore } from "./reminder-store.js";
import { getReminderState, type ReminderStateResult } from "./reminders.js";
import { WeatherStore } from "./store.js";
import type { WeatherBrief } from "./weather-model.js";
import { WeatherService, type WeatherBriefStore } from "./weather-service.js";

type WeatherReadConfig = RawPersonalWeatherConfig & Pick<
  Static<typeof geoConfigSchema>,
  "weatherBackend" | "bridgeBaseUrl" | "bridgeTokenFile"
>;

interface WeatherReadOptions {
  stateRoot: string;
  config: WeatherReadConfig;
  runId?: string | undefined;
  signal?: AbortSignal | undefined;
}

function openReadOnlyWeatherStore(stateRoot: string): WeatherStore {
  return new WeatherStore({
    stateDirectory: personalStateDirectory(stateRoot, "personal-weather"),
    readOnly: true,
  });
}

export function readPlanning(
  stateRoot: string,
): Pick<PlanningState, "asOfUtc" | "profile" | "weather" | "trips"> {
  const store = openReadOnlyWeatherStore(stateRoot);
  try {
    const { asOfUtc, profile, weather, trips } = getPlanningState(store);
    return { asOfUtc, profile, weather, trips };
  } finally {
    store.close();
  }
}

export function readActiveReminders(
  stateRoot: string,
): Pick<ReminderStateResult, "asOfUtc" | "activeReminders"> {
  const store = new ReminderStore({
    stateDirectory: personalStateDirectory(stateRoot, "personal-reminders"),
    readOnly: true,
  });
  try {
    const { asOfUtc, activeReminders } = getReminderState(store);
    return { asOfUtc, activeReminders };
  } finally {
    store.close();
  }
}

export async function readWeatherBrief({
  stateRoot,
  config,
  runId,
  signal,
}: WeatherReadOptions): Promise<WeatherBrief> {
  const store = openReadOnlyWeatherStore(stateRoot);
  try {
    // Fresh cache entries can be reused without performing cache maintenance.
    const readOnlyStore: WeatherBriefStore = {
      getEffectivePlace: store.getEffectivePlace.bind(store),
      getFreshApiCache: store.getFreshApiCache.bind(store),
      deleteExpiredApiCache: () => 0,
      deleteApiCache: () => false,
      putApiCache() {},
    };
    const client = config.weatherBackend === "knowledgemap"
      ? new KnowledgeMapWeatherClient({
        baseUrl: config.bridgeBaseUrl,
        tokenFile: config.bridgeTokenFile,
        runId,
      })
      : new QWeatherClient(resolvePersonalWeatherConfig(config));
    return await new WeatherService(readOnlyStore, client).getBrief(signal);
  } finally {
    store.close();
  }
}
