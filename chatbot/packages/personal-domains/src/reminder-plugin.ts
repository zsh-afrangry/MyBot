import { Type } from 'typebox';
import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import type { AnyAgentTool } from 'openclaw/plugin-sdk/plugin-entry';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { authorizeTools, isTrustedOwnerPrivateQq, trustedReminderContext, forbiddenResult, publicReminderError, planningCommitParameters } from './tool-common.js';
import { callGatewayTool } from 'openclaw/plugin-sdk/agent-harness-runtime';
import { createNativeReminderScheduler } from './native-reminder-scheduler.js';
import { reminderStateDirectory } from './paths.js';
import { buildReminderCronAddParams, buildReminderCronUpdateParams } from './reminder-gateway.js';
import { reconcileReminderState } from './reminder-reconciler.js';
import { createReminderReconcilerService } from './reminder-reconciler-service.js';
import { commitReminderProposal, getReminderState, proposeReminderCancellation, proposeReminderCreate, proposeReminderUpdate, type ReminderCronAddInput, type ReminderCronScheduler } from './reminders.js';
import { ReminderStore } from './reminder-store.js';
import { registerDomainBackend } from './confirmation-backends.js';
import { registerInteractionHooks } from './interaction/index.js';
const configSchema = Type.Object({ reminderBackend: Type.Optional(Type.Literal('native-service')), reminderRunnerRoot: Type.Optional(Type.String()) }, { additionalProperties: false });
const reminderStateParameters = Type.Object({}, { additionalProperties: false });
const reminderCreateParameters = Type.Object({
    schema_version: Type.Literal(1),
    request: Type.Object({
        kind: Type.Literal("reminder.create"),
        content: Type.String({ minLength: 1, maxLength: 200 }),
        schedule: Type.Object({
            local_date_time: Type.String({
                description: "Local date and time in YYYY-MM-DDTHH:mm format, exactly 16 characters, without seconds or UTC offset. timezone is supplied separately.",
                minLength: 16,
                maxLength: 16,
                pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$",
            }),
            timezone: Type.Literal("Asia/Shanghai"),
        }, { additionalProperties: false }),
    }, { additionalProperties: false }),
}, { additionalProperties: false });
const reminderCancelParameters = Type.Object({
    schema_version: Type.Literal(1),
    request: Type.Object({
        kind: Type.Literal("reminder.cancel"),
        reminder_id: Type.String({
            minLength: 36,
            maxLength: 36,
            pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
    }, { additionalProperties: false }),
}, { additionalProperties: false });
const reminderUpdateParameters = Type.Object({
    schema_version: Type.Literal(1),
    request: Type.Object({
        kind: Type.Literal("reminder.update"),
        reminder_id: Type.String({
            minLength: 36,
            maxLength: 36,
            pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
        content: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        schedule: Type.Optional(Type.Object({
            local_date_time: Type.String({
                description: "Local date and time in YYYY-MM-DDTHH:mm format, exactly 16 characters, without seconds or UTC offset. timezone is supplied separately.",
                minLength: 16,
                maxLength: 16,
                pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$",
            }),
            timezone: Type.Literal("Asia/Shanghai"),
        }, { additionalProperties: false })),
    }, { additionalProperties: false, minProperties: 2 }),
}, { additionalProperties: false });
const reminderCommitParameters = planningCommitParameters;
export function createPlugin() {
    let nativeReminderScheduler: ReminderCronScheduler | undefined;
    function createGatewayReminderScheduler(): ReminderCronScheduler {
        if (nativeReminderScheduler)
            return nativeReminderScheduler;
        return {
            async add(input: ReminderCronAddInput): Promise<{
                jobId: string;
            }> {
                const result = await callGatewayTool<unknown>("cron.add", { timeoutMs: 60000 }, buildReminderCronAddParams(input));
                const jobId = extractCronJobId(result);
                if (!jobId)
                    throw new Error("Gateway cron.add did not return a job id");
                return { jobId };
            },
            async remove(input: {
                jobId: string;
            }): Promise<void> {
                await callGatewayTool<unknown>("cron.remove", { timeoutMs: 60000 }, { id: input.jobId });
            },
            async update(input) {
                await callGatewayTool<unknown>("cron.update", { timeoutMs: 60000 }, buildReminderCronUpdateParams(input));
            },
        };
    }
    function extractCronJobId(value: unknown): string | undefined {
        if (!isRecord(value))
            return undefined;
        const direct = value.jobId ?? value.id;
        if (typeof direct === "string" && direct.length >= 1 && direct.length <= 200)
            return direct;
        const nested = value.job;
        if (!isRecord(nested))
            return undefined;
        const nestedId = nested.id ?? nested.jobId;
        return typeof nestedId === "string" && nestedId.length >= 1 && nestedId.length <= 200
            ? nestedId
            : undefined;
    }
    function isRecord(value: unknown): value is Record<string, unknown> {
        return typeof value === "object" && value !== null && !Array.isArray(value);
    }
    const plugin = defineToolPlugin({ id: 'personal-reminders', name: 'Personal Reminders', description: 'Independent owner one-off reminders', activation: { onStartup: true }, configSchema, tools: tool => [tool({
                name: "personal_reminder_state_get",
                label: "Personal reminder state",
                description: "Read the owner's active one-time reminder summaries. Owner QQ private chat only; this tool cannot create, change, cancel, send, or manage Cron jobs.",
                parameters: reminderStateParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_state_get",
                    label: "Personal reminder state",
                    description: "Read active owner-private reminders without changing anything.",
                    parameters: reminderStateParameters,
                    async execute() {
                        if (!isTrustedOwnerPrivateQq(toolContext))
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            if (nativeReminderScheduler?.reconcile)
                                await nativeReminderScheduler.reconcile(store);
                            else
                                reconcileReminderState(store);
                            return jsonResult(getReminderState(store));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_reminder_propose",
                label: "Propose a personal reminder",
                description: "Create a typed preview for one future owner-private reminder. It stores only a pending proposal; it does not create Cron, send QQ messages, or change any existing reminder. Present proposal expiry using expiresAtDisplay; do not calculate it from epoch seconds or confuse it with reminder time.",
                parameters: reminderCreateParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_propose",
                    label: "Propose a personal reminder",
                    description: "Create a pending one-time reminder preview. Use an explicit future Asia/Shanghai local date and time; never supply a recipient or Cron expression. Present proposal expiry using expiresAtDisplay; do not calculate it from epoch seconds or confuse it with reminder time.",
                    parameters: reminderCreateParameters,
                    async execute(_toolCallId, params) {
                        const context = trustedReminderContext(toolContext);
                        if (!context)
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            return jsonResult(proposeReminderCreate(store, params, context));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_reminder_commit",
                label: "Commit a personal reminder proposal",
                description: "After explicit owner confirmation, create exactly one reminder from a frozen pending proposal whose ID and payload hash match. This tool cannot target anyone except the owner private QQ conversation.",
                parameters: reminderCommitParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_commit",
                    label: "Commit a personal reminder proposal",
                    description: "Commit exactly one hash-matched pending reminder proposal after explicit owner confirmation in the same QQ private chat.",
                    parameters: reminderCommitParameters,
                    async execute(_toolCallId, params) {
                        const context = trustedReminderContext(toolContext);
                        if (!context)
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            return jsonResult(await commitReminderProposal(store, params, context, createGatewayReminderScheduler()));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_reminder_change_propose",
                label: "Propose personal reminder change",
                description: "Create a typed preview to change the content and/or time of one existing owner-private reminder in place. It never creates a second Cron job and requires a separate explicit confirmation. Present proposal expiry using expiresAtDisplay; do not calculate it from epoch seconds or confuse it with reminder time.",
                parameters: reminderUpdateParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_change_propose",
                    label: "Propose personal reminder change",
                    description: "Create a pending owner-private reminder change preview. The existing managed Cron job is updated only after confirmation. Present proposal expiry using expiresAtDisplay; do not calculate it from epoch seconds or confuse it with reminder time.",
                    parameters: reminderUpdateParameters,
                    async execute(_toolCallId, params) {
                        const context = trustedReminderContext(toolContext);
                        if (!context)
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            return jsonResult(proposeReminderUpdate(store, params, context));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_reminder_change_commit",
                label: "Commit personal reminder change",
                description: "After explicit owner confirmation, apply exactly one frozen reminder change proposal. It updates the existing managed Cron job in place and never accepts arbitrary Cron parameters.",
                parameters: reminderCommitParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_change_commit",
                    label: "Commit personal reminder change",
                    description: "Commit one hash-matched pending reminder change in the owner's QQ private chat; repeated confirmation is idempotent.",
                    parameters: reminderCommitParameters,
                    async execute(_toolCallId, params) {
                        const context = trustedReminderContext(toolContext);
                        if (!context)
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            return jsonResult(await commitReminderProposal(store, params, context, createGatewayReminderScheduler()));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_reminder_cancel_propose",
                label: "Propose personal reminder cancellation",
                description: "Create a pending preview to cancel one known, unexpired owner-private reminder. It does not cancel anything until a separate explicit confirmation commit. Present proposal expiry using expiresAtDisplay; do not calculate it from epoch seconds or confuse it with reminder time.",
                parameters: reminderCancelParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_cancel_propose",
                    label: "Propose personal reminder cancellation",
                    description: "Create a pending cancellation preview for one active owner-private reminder. Present proposal expiry using expiresAtDisplay; do not calculate it from epoch seconds or confuse it with reminder time.",
                    parameters: reminderCancelParameters,
                    async execute(_toolCallId, params) {
                        const context = trustedReminderContext(toolContext);
                        if (!context)
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            return jsonResult(proposeReminderCancellation(store, params, context));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            }),
            tool({
                name: "personal_reminder_cancel_commit",
                label: "Commit personal reminder cancellation",
                description: "After explicit owner confirmation, cancel exactly one frozen reminder-cancellation proposal whose ID and payload hash match. This only removes the associated managed reminder Cron job.",
                parameters: reminderCommitParameters,
                optional: true,
                factory: ({ toolContext }): AnyAgentTool => ({
                    name: "personal_reminder_cancel_commit",
                    label: "Commit personal reminder cancellation",
                    description: "Commit exactly one hash-matched pending reminder cancellation after owner confirmation.",
                    parameters: reminderCommitParameters,
                    async execute(_toolCallId, params) {
                        const context = trustedReminderContext(toolContext);
                        if (!context)
                            return forbiddenResult();
                        let store: ReminderStore | undefined;
                        try {
                            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
                            return jsonResult(await commitReminderProposal(store, params, context, createGatewayReminderScheduler()));
                        }
                        catch (error) {
                            return jsonResult({
                                ok: false,
                                error: { code: "reminder_unavailable", message: publicReminderError(error) },
                            });
                        }
                        finally {
                            store?.close();
                        }
                    },
                }),
            })] });
    const register = authorizeTools(plugin).register;
    plugin.register = api => {
        register(api);
        if (api.registrationMode !== 'full')
            return;
        registerInteractionHooks(api, { proposalTools: ['personal_reminder_propose', 'personal_reminder_change_propose', 'personal_reminder_cancel_propose'] });
        registerDomainBackend(api, { id: 'personal-reminder', domain: 'personal_reminder', open: () => new ReminderStore({ stateDirectory: reminderStateDirectory() }) });
        if (api.pluginConfig?.reminderBackend === 'native-service') {
            const ownerId = api.config.channels?.['kurumi-qq']?.ownerId;
            if (!ownerId)
                throw Error('Native reminder service requires configured QQ owner');
            nativeReminderScheduler = createNativeReminderScheduler({ stateDirectory: reminderStateDirectory(), ownerId, port: api.config.gateway?.port ?? 18890, pluginRoot: String(api.pluginConfig.reminderRunnerRoot ?? '') });
        }
        api.registerService(createReminderReconcilerService({ scheduler: createGatewayReminderScheduler() }));
    };
    return plugin;
}
export default createPlugin();
