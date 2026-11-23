import { Type, type Static } from 'typebox';
import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { scopeFromToolContext } from '@kurumi/confirmation-core';
import { authorizeTools, isTrustedOwnerPrivateQq, forbiddenResult, changeStateParameters, planningCommitParameters } from './tool-common.js';
import { resolvePersonalWeatherConfig } from './config.js';
import { QWeatherClient } from './qweather-client.js';
import { KnowledgeMapWeatherClient } from './knowledgemap-client.js';
import { createToolTrace } from '@kurumi/knowledgemap-client/tool-trace.js';
import { asWeatherError } from './errors.js';
import { WeatherStore } from './store.js';
import { weatherStateDirectory } from './paths.js';
import { profileGeoConfigSchema as configSchema } from './geo-config-schema.js';
import { createProfileCatalog } from './profile-catalog.js';
import { commitProfileChange, getProfileState, proposeProfileChange, profileProposalError } from './profile.js';
import { registerDomainBackend } from './confirmation-backends.js';
import { registerInteractionHooks } from './interaction/index.js';
import { readChangeFeedback } from './change-feedback.js';
import { registerSharedLocationRoute } from './shared-location.js';
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
                description: "Read the owner's current location and pending Profile proposals. Pass proposal_id to verify the location saved by that proposal separately from the current location. Use expiresAtDisplay and its timezone for confirmation deadlines.",
                parameters: changeStateParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_profile_state_get",
                    label: "Personal Profile state",
                    description: "Read current Profile state or verify the saved location for proposal_id.",
                    parameters: changeStateParameters,
                    async execute(_callId, rawParams) {
                        if (!isTrustedOwnerPrivateQq(toolContext))
                            return forbiddenResult();
                        const proposalId = (rawParams as Static<typeof changeStateParameters> | undefined)?.proposal_id;
                        if (proposalId !== undefined)
                            return jsonResult(readChangeFeedback('location_set', proposalId, scopeFromToolContext(toolContext)));
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
                description: "Create a typed pending preview to set the owner's current Profile location after trusted GeoAPI disambiguation. If requiresUserInput=true (e.g. location_ambiguous), ask the user and END this turn; do not choose a candidate, rewrite the location or retry until a NEW user message. Confirmation domain=personal_profile. Present confirmation deadlines from expiresAtDisplay with its timezone, not epoch numbers. It never commits a profile change, alters trips, reminders, Cron, memory, or files.",
                parameters: profileChangeParameters,
                optional: true,
                factory: ({ toolContext, config }): AnyAgentTool => ({
                    name: "personal_profile_change_propose",
                    label: "Propose a Profile change",
                    description: "Create a pending current_location.set preview for explicit owner statements such as 已经到了某地. A unique place is required before confirmation. If requiresUserInput=true, ask the user and END this turn; never self-select or retry with rewritten location until a NEW user message. Confirmation domain=personal_profile. Present confirmation deadlines from expiresAtDisplay with its timezone, not epoch numbers.",
                    parameters: profileChangeParameters,
                    async execute(_toolCallId, params, signal) {
                        if (!isTrustedOwnerPrivateQq(toolContext))
                            return forbiddenResult();
                        let store: WeatherStore | undefined;
                        try {
                            store = new WeatherStore({ stateDirectory: weatherStateDirectory() });
                            return jsonResult(await proposeProfileChange(store, config.locationCatalog !== undefined
                                ? createProfileCatalog(config.locationCatalog)
                                : config.weatherBackend === "knowledgemap"
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
                description: "Commit one frozen current-location proposal after explicit owner confirmation. The ID and hash must match. Report the saved place from feedback.evidence.savedLocation.",
                parameters: planningCommitParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_profile_change_commit",
                    label: "Commit a Profile change",
                    description: "Commit a hash-matched current location change in the owner's QQ private chat. Report the saved place from feedback.evidence.savedLocation. Repeated confirmation is idempotent.",
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
        const profileConfig = api.pluginConfig as {shareDefaultCity?: boolean; bridgeTokenFile?: string} | undefined;
        if (profileConfig?.shareDefaultCity === true) {
            registerSharedLocationRoute(api, {stateDirectory: weatherStateDirectory(), tokenFile: profileConfig.bridgeTokenFile});
        }
        weatherTrace.attach(api);
        registerInteractionHooks(api, { clarificationTools: ['personal_profile_change_propose'], proposalTools: ['personal_profile_change_propose'] });
        registerDomainBackend(api, { id: 'personal-profile', domain: 'personal_profile', open: () => new WeatherStore({ stateDirectory: weatherStateDirectory() }) });
    };
    return plugin;
}
export default createPlugin();
