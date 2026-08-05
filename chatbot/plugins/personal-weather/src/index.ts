import { Type } from "typebox";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { resolvePersonalWeatherConfig } from "./config.js";
import { asWeatherError } from "./errors.js";
import { formatWeatherBrief } from "./formatter.js";
import { weatherStateDirectory } from "./paths.js";
import { QWeatherClient } from "./qweather-client.js";
import { WeatherStore } from "./store.js";
import { WeatherService } from "./weather-service.js";
import type { WeatherBriefResult } from "./weather-model.js";

const secretRefSchema = Type.Object(
  {
    source: Type.Literal("env"),
    provider: Type.Literal("default"),
    id: Type.String({ minLength: 1, maxLength: 200 }),
  },
  { additionalProperties: false },
);

const configSchema = Type.Object(
  {
    apiHost: Type.String({
      description: "QWeather dedicated API hostname without scheme or path.",
    }),
    apiKey: Type.Union([Type.String(), secretRefSchema]),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "personal-weather",
  name: "Personal Weather",
  description: "Read-only QWeather brief for kurumi's owner.",
  activation: { onStartup: false },
  configSchema,
  tools: (tool) => [
    tool({
      name: "personal_weather_get_brief",
      label: "Personal weather brief",
      description:
        "Read the owner's effective location and return verified current conditions, today's forecast, the next 24-hour rain trend, and official alert status. This tool cannot change location, files, prompts, memory, Cron, or travel records.",
      parameters: Type.Object({}, { additionalProperties: false }),
      optional: true,
      async execute(_params, rawConfig, context): Promise<WeatherBriefResult> {
        let store: WeatherStore | undefined;
        try {
          const config = resolvePersonalWeatherConfig(rawConfig);
          store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
          const client = new QWeatherClient(config);
          const brief = await new WeatherService(store, client).getBrief(
            context.signal,
          );
          return {
            ok: true,
            brief,
            formattedText: formatWeatherBrief(brief),
          };
        } catch (error) {
          return asWeatherError(error).toPublicResult();
        } finally {
          store?.close();
        }
      },
    }),
  ],
});
