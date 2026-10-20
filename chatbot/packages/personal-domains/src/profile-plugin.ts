import { Type } from 'typebox';
import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { scopeFromToolContext } from '@kurumi/confirmation-core';
import { authorizeTools, isTrustedOwnerPrivateQq, forbiddenResult, planningCommitParameters } from './tool-common.js';
import { resolvePersonalWeatherConfig } from './config.js';
import { QWeatherClient } from './qweather-client.js';
import { KnowledgeMapWeatherClient } from './knowledgemap-client.js';
import { createToolTrace } from '../../knowledgemap-client/tool-trace.js';
import { asWeatherError } from './errors.js';
import { WeatherStore } from './store.js';
import { weatherStateDirectory } from './paths.js';
import { geoConfigSchema as configSchema } from './geo-config-schema.js';
import { commitProfileChange, getProfileState, proposeProfileChange, profileProposalError } from './profile.js';
import { registerDomainBackend } from './confirmation-backends.js';
import { registerInteractionHooks } from './interaction/index.js';
const profileStateParameters = Type.Object({}, { additionalProperties: false });
const profileChangeParameters = Type.Object({
    schema_version: Type.Literal(1),
    request: Type.Object({
        kind: Type.Literal("current_location.set"),
        location: Type.Object({
            text: Type.String({ minLength: 1, maxLength: 80, description: "The owner's stated place. City lookup does not guarantee campus/building precision; do not silently replace the place with a broader city." }),
            administrative_area: Type.Optional(Type.String({ minLength: 1, maxLength: 80, description: "Optional user-supported superior administrative division, such as 重庆 for 沙坪坝. Omit when unknown; never invent a district or concatenate a full address as an administrative filter." })),
        }, { additionalProperties: false }),
    }, { additionalProperties: false }),
}, { additionalProperties: false });
export function createPlugin() {
    const weatherTrace = createToolTrace(['personal_profile_change_propose']);
    const plugin = defineToolPlugin({ id: 'personal-profile', name: 'Personal Profile', description: 'Independent Personal Profile capability', activation: { onStartup: true }, configSchema, tools: tool => [
            tool({
                name: "personal_profile_state_get",
                label: "Personal Profile state",
                description: "Read the owner's minimized Profile state, currently limited to the confirmed current location and pending Profile proposals. Present confirmation deadlines from expiresAtDisplay with its timezone, not epoch numbers. Owner QQ private chat only; this tool never changes state.",
                parameters: profileStateParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_profile_state_get",
                    label: "Personal Profile state",
                    description: "Read the owner's current Profile location without changing any state. Present pending proposal confirmation deadlines from expiresAtDisplay with its timezone, not epoch numbers.",
                    parameters: profileStateParameters,
                    async execute() {
                        if (!isTrustedOwnerPrivateQq(toolContext))
                            return forbiddenResult();
                        let store: WeatherStore | undefined;
                        try {
                            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
                            return jsonResult(getProfileState(store));
                        }
                        catch (error) {
                            return jsonResult(asWeatherError(error).toPublicResult());
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_profile_change_propose",
                label: "Propose a Profile change",
                description: "Create a typed pending preview to set the owner's current Profile location after trusted GeoAPI disambiguation. Present confirmation deadlines from expiresAtDisplay with its timezone, not epoch numbers. It never commits a profile change, alters trips, reminders, Cron, memory, or files.",
                parameters: profileChangeParameters,
                optional: true,
                factory: ({ toolContext, config }): AnyAgentTool => ({
                    name: "personal_profile_change_propose",
                    label: "Propose a Profile change",
                    description: "Create a pending current_location.set preview for explicit owner statements such as 已经到了某地. A unique place is required before confirmation. Present confirmation deadlines from expiresAtDisplay with its timezone, not epoch numbers.",
                    parameters: profileChangeParameters,
                    async execute(_toolCallId, params, signal) {
                        if (!isTrustedOwnerPrivateQq(toolContext))
                            return forbiddenResult();
                        let store: WeatherStore | undefined;
                        try {
                            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
                            return jsonResult(await proposeProfileChange(store, config.weatherBackend === "knowledgemap"
                                ? new KnowledgeMapWeatherClient({ baseUrl: config.bridgeBaseUrl, tokenFile: config.bridgeTokenFile, runId: weatherTrace.resolve(toolContext, _toolCallId, "personal_profile_change_propose") })
                                : new QWeatherClient(resolvePersonalWeatherConfig(config)), params, signal, scopeFromToolContext(toolContext)));
                        }
                        catch (error) {
                            return jsonResult(profileProposalError(error));
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_profile_change_commit",
                label: "Commit a Profile change",
                description: "Commit exactly one frozen current-location Profile proposal after explicit owner confirmation. The proposal ID and payload hash must match; it changes no trip, reminder, Cron, memory, or file.",
                parameters: planningCommitParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_profile_change_commit",
                    label: "Commit a Profile change",
                    description: "Commit one hash-matched pending current location change in the owner's QQ private chat. Repeated confirmation is idempotent.",
                    parameters: planningCommitParameters,
                    async execute(_toolCallId, params) {
                        if (!isTrustedOwnerPrivateQq(toolContext))
                            return forbiddenResult();
                        let store: WeatherStore | undefined;
                        try {
                            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
                            return jsonResult(commitProfileChange(store, params, scopeFromToolContext(toolContext)));
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
        registerInteractionHooks(api, { clarificationTools: ['personal_profile_change_propose'], proposalTools: ['personal_profile_change_propose'] });
        registerDomainBackend(api, { id: 'personal-profile', domain: 'personal_profile', open: () => new WeatherStore({ stateDirectory: weatherStateDirectory() }) });
    };
    return plugin;
}
export default createPlugin();
