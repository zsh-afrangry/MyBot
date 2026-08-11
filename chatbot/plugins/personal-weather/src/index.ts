import { Type } from "typebox";
import { payloadTextResult, type AnyAgentTool } from "openclaw/plugin-sdk/agent-runtime";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { resolvePersonalWeatherConfig } from "./config.js";
import { asWeatherError } from "./errors.js";
import { formatWeatherBrief } from "./formatter.js";
import { weatherStateDirectory } from "./paths.js";
import { QWeatherClient } from "./qweather-client.js";
import {
  getPlanningState,
  proposePlanningChange,
  TRANSPORT_MODES,
  TIME_PRECISIONS,
} from "./planning.js";
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

const planningStateParameters = Type.Object({}, { additionalProperties: false });
const planningTimeWindowSchema = Type.Object(
  {
    earliest: Type.String({ minLength: 1, maxLength: 80 }),
    latest: Type.String({ minLength: 1, maxLength: 80 }),
    precision: Type.Union(TIME_PRECISIONS.map((value) => Type.Literal(value))),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
  },
  { additionalProperties: false },
);
const planningChangeParameters = Type.Object(
  {
    schema_version: Type.Literal(1),
    request: Type.Object(
      {
        kind: Type.Literal("trip.create"),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        destination: Type.Object(
          {
            text: Type.String({ minLength: 1, maxLength: 200 }),
            administrative_area: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
          },
          { additionalProperties: false },
        ),
        transport_mode: Type.Optional(
          Type.Union(TRANSPORT_MODES.map((value) => Type.Literal(value))),
        ),
        departure: Type.Optional(planningTimeWindowSchema),
        arrival: Type.Optional(planningTimeWindowSchema),
        weather_mode: Type.Optional(
          Type.Union([
            Type.Literal("none"),
            Type.Literal("dual_city"),
            Type.Literal("switch_at_arrival"),
          ]),
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);

export default defineToolPlugin({
  id: "personal-weather",
  name: "Personal Weather",
  description: "Owner-only weather reads and typed travel proposal previews for kurumi.",
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
    tool({
      name: "personal_planning_state_get",
      label: "Personal planning state",
      description:
        "Read a minimized summary of the owner's weather place, daily brief schedule, saved trips, and pending proposals. Owner QQ private chat only; this tool never changes state.",
      parameters: planningStateParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_planning_state_get",
        label: "Personal planning state",
        description:
          "Read the owner's minimized weather and travel planning state. This tool is read-only.",
        parameters: planningStateParameters,
        async execute() {
          if (!isTrustedOwnerPrivateQq(toolContext)) {
            return payloadTextResult({
              ok: false,
              error: {
                code: "forbidden_context",
                message: "此工具仅支持主人 QQ 私聊。",
              },
            });
          }
          let store: WeatherStore | undefined;
          try {
            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
            return payloadTextResult(getPlanningState(store));
          } catch (error) {
            return payloadTextResult(asWeatherError(error).toPublicResult());
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_planning_change_propose",
      label: "Propose a personal planning change",
      description:
        "Create a typed, owner-only preview for a travel plan. It stores only a pending proposal; it does not commit a trip, change the weather location, alter reminders, edit Cron, or send messages.",
      parameters: planningChangeParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_planning_change_propose",
        label: "Propose a personal planning change",
        description:
          "Create a typed pending travel proposal for owner confirmation. No business state is committed.",
        parameters: planningChangeParameters,
        async execute(_toolCallId, params) {
          if (!isTrustedOwnerPrivateQq(toolContext)) {
            return payloadTextResult({
              ok: false,
              error: {
                code: "forbidden_context",
                message: "此工具仅支持主人 QQ 私聊。",
              },
            });
          }
          let store: WeatherStore | undefined;
          try {
            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
            return payloadTextResult(proposePlanningChange(store, params));
          } catch (error) {
            return payloadTextResult(asWeatherError(error).toPublicResult());
          } finally {
            store?.close();
          }
        },
      }),
    }),
  ],
});

function isTrustedOwnerPrivateQq(toolContext: {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string };
  senderIsOwner?: boolean;
}): boolean {
  const channel = toolContext.messageChannel ?? toolContext.deliveryContext?.channel;
  const target = toolContext.deliveryContext?.to;
  const isGroupTarget = typeof target === "string" && /(?:^|:)group:/iu.test(target);
  return toolContext.senderIsOwner === true && channel === "qqbot" && !isGroupTarget;
}
