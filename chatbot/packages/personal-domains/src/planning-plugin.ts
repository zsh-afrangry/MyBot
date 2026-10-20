import { Type } from 'typebox';
import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { scopeFromToolContext } from '@kurumi/confirmation-core';
import { authorizeTools, isTrustedOwnerPrivateQq, forbiddenResult, planningCommitParameters } from './tool-common.js';
import { asWeatherError } from './errors.js';
import { WeatherStore } from './store.js';
import { weatherStateDirectory } from './paths.js';
import { commitPlanningProposal, getPlanningState, proposePlanningChange, TRANSPORT_MODES, TIME_PRECISIONS } from './planning.js';
import { registerDomainBackend } from './confirmation-backends.js';
import { registerInteractionHooks } from './interaction/index.js';
const configSchema = Type.Object({}, { additionalProperties: false });
const planningStateParameters = Type.Object({}, { additionalProperties: false });
const planningTimeWindowSchema = Type.Object({
    earliest: Type.String({ minLength: 1, maxLength: 80, description: "User-supported earliest instant in ISO-8601 with Z or numeric UTC offset, including when precision is date. Never invent an instant for an unknown date." }),
    latest: Type.String({ minLength: 1, maxLength: 80, description: "User-supported latest instant in ISO-8601 with Z or numeric UTC offset; not before earliest and at most 31 days after it." }),
    precision: Type.Union(TIME_PRECISIONS.map((value) => Type.Literal(value))),
    timezone: Type.String({ minLength: 1, maxLength: 100 }),
}, { additionalProperties: false });
const planningChangeParameters = Type.Object({
    schema_version: Type.Literal(1),
    request: Type.Object({
        kind: Type.Literal("trip.create"),
        title: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        destination: Type.Object({
            text: Type.String({ minLength: 1, maxLength: 200 }),
            administrative_area: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        }, { additionalProperties: false }),
        transport_mode: Type.Optional(Type.Union(TRANSPORT_MODES.map((value) => Type.Literal(value)))),
        departure: Type.Optional({ ...planningTimeWindowSchema, description: "Optional departure window. Omit this entire object when the user has not provided a date/time or says it is undecided. A draft can be created without it; do not use empty strings or an invented broad range." }),
        arrival: Type.Optional({ ...planningTimeWindowSchema, description: "Optional arrival window. Omit this entire object when the user has not provided a date/time or says it is undecided. A draft can be created without it; do not use empty strings or an invented broad range." }),
        weather_mode: Type.Optional(Type.Union([
            Type.Literal("none"),
            Type.Literal("dual_city"),
            Type.Literal("switch_at_arrival"),
        ])),
    }, { additionalProperties: false }),
}, { additionalProperties: false });
export function createPlugin() {
    const plugin = defineToolPlugin({ id: 'personal-planning', name: 'Personal Planning', description: 'Independent Personal Planning capability', activation: { onStartup: true }, configSchema, tools: tool => [
            tool({
                name: "personal_planning_state_get",
                label: "Personal planning state",
                description: "Read a minimized summary of the owner's weather place, daily brief schedule, saved trips, and pending proposals. Present trip dates from displayTimes and confirmation deadlines from expiresAtDisplay with their timezones; do not calculate dates from epoch seconds. Preserve time precision. Owner QQ private chat only; this tool never changes state.",
                parameters: planningStateParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_planning_state_get",
                    label: "Personal planning state",
                    description: "Read the owner's minimized weather and travel planning state. Present trip dates from displayTimes and confirmation deadlines from expiresAtDisplay with their timezones, preserving precision; do not calculate dates from epoch seconds. This tool is read-only.",
                    parameters: planningStateParameters,
                    async execute() {
                        if (!isTrustedOwnerPrivateQq(toolContext)) {
                            return jsonResult({
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
                            return jsonResult(getPlanningState(store));
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
                name: "personal_planning_change_propose",
                label: "Propose a personal planning change",
                description: "Create a typed, owner-only preview for a travel plan. Present confirmation deadlines from expiresAtDisplay with its timezone, separately from trip dates; do not calculate epoch dates. It stores only a pending proposal; it does not commit a trip, change the weather location, alter reminders, edit Cron, or send messages. Only trip.create is supported: do not offer to update, complete or delete an already committed trip.",
                parameters: planningChangeParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_planning_change_propose",
                    label: "Propose a personal planning change",
                    description: "Create a typed pending travel proposal for owner confirmation. Present confirmation deadlines from expiresAtDisplay with its timezone, separately from trip dates; do not calculate epoch dates. No business state is committed. Only trip.create is supported: do not offer to update, complete or delete an already committed trip.",
                    parameters: planningChangeParameters,
                    async execute(_toolCallId, params) {
                        if (!isTrustedOwnerPrivateQq(toolContext)) {
                            return jsonResult({
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
                            return jsonResult(proposePlanningChange(store, params, scopeFromToolContext(toolContext)));
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
                name: "personal_planning_change_commit",
                label: "Commit a personal planning proposal",
                description: "Commit exactly one previously previewed owner travel proposal after explicit owner confirmation. The proposal ID and payload hash must match the frozen pending proposal. This writes only a planned trip record; it never changes the weather location, reminders, Cron, files, or host. Only trip.create is supported: do not offer to update, complete or delete an already committed trip.",
                parameters: planningCommitParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_planning_change_commit",
                    label: "Commit a personal planning proposal",
                    description: "Commit a hash-matched pending trip proposal in the owner's QQ private chat. This cannot change weather location or schedules. Only trip.create is supported: do not offer to update, complete or delete an already committed trip.",
                    parameters: planningCommitParameters,
                    async execute(_toolCallId, params) {
                        if (!isTrustedOwnerPrivateQq(toolContext)) {
                            return jsonResult({
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
                            return jsonResult(commitPlanningProposal(store, params, scopeFromToolContext(toolContext)));
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
        registerInteractionHooks(api, { proposalTools: ['personal_planning_change_propose'] });
        registerDomainBackend(api, { id: 'personal-planning', domain: 'planning', open: () => new WeatherStore({ stateDirectory: weatherStateDirectory() }) });
    };
    return plugin;
}
export default createPlugin();
