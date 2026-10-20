import { Type, type Static } from 'typebox';
import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { authorizeTools, isTrustedWeatherRead, forbiddenResult } from './tool-common.js';
import { resolvePersonalWeatherConfig } from './config.js';
import { QWeatherClient } from './qweather-client.js';
import { KnowledgeMapWeatherClient } from './knowledgemap-client.js';
import { createToolTrace } from '@kurumi/knowledgemap-client/tool-trace.js';
import { asWeatherError } from './errors.js';
import { WeatherStore } from './store.js';
import { weatherStateDirectory } from './paths.js';
import { geoConfigSchema as configSchema } from './geo-config-schema.js';
import { WeatherService } from './weather-service.js';
import { resolveWeatherLocation } from './weather-location.js';
import { formatWeatherBrief } from './formatter.js';
const weatherBriefParameters = Type.Object({
    location: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Temporary weather location text, such as 番禺区. Omit for the owner's effective weather place.",
    })),
    administrative_area: Type.Optional(Type.String({
        minLength: 1,
        maxLength: 80,
        description: "Optional superior administrative area used only to disambiguate location, such as 广州市.",
    })),
}, { additionalProperties: false });
export function createPlugin() {
    const weatherTrace = createToolTrace(['personal_weather_get_brief']);
    const plugin = defineToolPlugin({ id: 'personal-weather', name: 'Personal Weather', description: 'Independent Personal Weather capability', activation: { onStartup: true }, configSchema, tools: tool => [
            tool({
                name: "personal_weather_get_brief",
                label: "Personal weather brief",
                description: "Read verified current conditions, today's forecast, the next 24-hour rain trend, and official alert status for the owner's effective weather place or one explicit temporary location. A temporary location never changes preferences, trips, location periods, files, prompts, memory, Cron, or travel records.",
                parameters: weatherBriefParameters,
                optional: true,
                factory: ({ toolContext, config }): AnyAgentTool => ({
                    name: "personal_weather_get_brief",
                    label: "Personal weather brief",
                    description: "Read verified current conditions, today's forecast, the next 24-hour rain trend, and official alert status for the owner's effective weather place or one explicit temporary location.",
                    parameters: weatherBriefParameters,
                    async execute(_toolCallId, rawParams, signal) {
                        const params = rawParams as Static<typeof weatherBriefParameters>;
                        if (!isTrustedWeatherRead(toolContext, config.scheduledOwnerId))
                            return forbiddenResult();
                        let store: WeatherStore | undefined;
                        try {
                            if (params.location === undefined && params.administrative_area !== undefined) {
                                return jsonResult({
                                    ok: false,
                                    code: "INVALID_INPUT",
                                    retryable: false,
                                    message: "administrative_area 只能与 location 一起使用。",
                                });
                            }
                            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
                            const client = config.weatherBackend === "knowledgemap"
                                ? new KnowledgeMapWeatherClient({ baseUrl: config.bridgeBaseUrl, tokenFile: config.bridgeTokenFile, runId: weatherTrace.resolve(toolContext, _toolCallId, "personal_weather_get_brief") })
                                : new QWeatherClient(resolvePersonalWeatherConfig(config));
                            const service = new WeatherService(store, client);
                            let brief;
                            if (params.location === undefined) {
                                brief = await service.getBrief(signal);
                            }
                            else {
                                const resolution = await resolveWeatherLocation(client, {
                                    location: params.location,
                                    ...(params.administrative_area === undefined
                                        ? {}
                                        : { administrativeArea: params.administrative_area }),
                                }, signal);
                                if (resolution.kind === "not_found") {
                                    return jsonResult({
                                        ok: false,
                                        code: "LOCATION_NOT_FOUND",
                                        retryable: false,
                                        message: "未找到可用于天气查询的地点，请补充城市或上级行政区。",
                                    });
                                }
                                if (resolution.kind === "ambiguous") {
                                    return jsonResult({
                                        ok: false,
                                        code: "LOCATION_AMBIGUOUS",
                                        retryable: false,
                                        message: "地点名称存在多个候选，请补充城市或上级行政区后重试。",
                                        candidates: resolution.candidates,
                                    });
                                }
                                brief = await service.getBriefForLocation(resolution.location, signal);
                            }
                            return jsonResult({
                                ok: true,
                                brief,
                                formattedText: formatWeatherBrief(brief),
                            });
                        }
                        catch (error) {
                            return jsonResult(asWeatherError(error).toPublicResult());
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            })
        ] });
    const register = authorizeTools(plugin).register;
    plugin.register = api => {
        register(api);
        if (api.registrationMode !== 'full')
            return;
        weatherTrace.attach(api);
    };
    return plugin;
}
export default createPlugin();
export { isTrustedOwnerPrivateQq, isTrustedWeatherRead } from './tool-common.js';
