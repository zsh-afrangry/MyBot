import { Type } from 'typebox';
import { jsonResult } from 'openclaw/plugin-sdk/agent-runtime';
import { defineToolPlugin } from 'openclaw/plugin-sdk/tool-plugin';
import { scopeFromToolContext } from '@kurumi/confirmation-core';
import { assertToolAccess } from '../../access-control/index.js';
import type { TrustedReminderContext } from './reminders.js';
import type { ReminderDelivery } from './reminder-store.js';
export const planningCommitParameters = Type.Object({
    proposal_id: Type.String({
        minLength: 36,
        maxLength: 36,
        pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    payload_hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
}, { additionalProperties: false });
/** Read-only scheduled weather is restricted to the configured owner's native main Cron lane.
 * This grants no Profile, planning, reminder or memory write authority. */
export function isTrustedWeatherRead(ctx: Parameters<typeof isTrustedOwnerPrivateQq>[0], ownerId: unknown): boolean {
    if (isTrustedOwnerPrivateQq(ctx))
        return true;
    return typeof ownerId === "string" && /^[0-9]{5,12}$/u.test(ownerId)
        && /^agent:main:cron:[0-9a-f-]{36}(?::run:[0-9a-f-]{36})?$/u.test(ctx.sessionKey ?? "")
        && ctx.deliveryContext?.channel === "kurumi-qq"
        && ctx.deliveryContext?.to === `user:${ownerId}`
        && (ctx.deliveryContext?.accountId === undefined || ctx.deliveryContext.accountId === "default");
}
/** Internal authorization predicate shared by every owner-only tool factory. */
export function isTrustedOwnerPrivateQq(toolContext: {
    messageChannel?: string;
    deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
    };
    senderIsOwner?: boolean;
    requesterSenderId?: string;
    sessionKey?: string;
}): boolean {
    const channel = toolContext.messageChannel ?? toolContext.deliveryContext?.channel;
    const target = toolContext.deliveryContext?.to;
    if (typeof target !== "string" || target.trim().length === 0)
        return false;
    const isGroupTarget = typeof target === "string" && /(?:^|:)group:/iu.test(target);
    if (channel === "kurumi-qq")
        return scopeFromToolContext(toolContext) !== undefined;
    return toolContext.senderIsOwner === true && channel === "qqbot" && !isGroupTarget;
}
export function trustedReminderContext(toolContext: {
    messageChannel?: string;
    deliveryContext?: {
        channel?: string;
        to?: string;
        accountId?: string;
    };
    senderIsOwner?: boolean;
    requesterSenderId?: string;
    sessionKey?: string;
}): TrustedReminderContext | undefined {
    if (!isTrustedOwnerPrivateQq(toolContext))
        return undefined;
    const to = toolContext.deliveryContext?.to?.trim();
    if (!to || to.length > 500)
        return undefined;
    const accountId = toolContext.deliveryContext?.accountId?.trim();
    const delivery: ReminderDelivery = {
        channel: (toolContext.messageChannel ?? toolContext.deliveryContext?.channel) as ReminderDelivery["channel"],
        to,
        accountId: accountId ? accountId : null,
    };
    const scope = scopeFromToolContext(toolContext);
    return scope === undefined ? { delivery } : { delivery, scope };
}
export function forbiddenResult(): ReturnType<typeof jsonResult> {
    return jsonResult({
        ok: false,
        error: {
            code: "forbidden_context",
            message: "此工具仅支持主人 QQ 私聊。",
        },
    });
}
export function publicReminderError(_error: unknown): string {
    return "提醒服务暂时不可用，未创建、取消或发送任何提醒。";
}
export function authorizeTools(plugin: ReturnType<typeof defineToolPlugin>) { const register = plugin.register; plugin.register = api => register({ ...api, registerTool(definition, options) { if (typeof definition !== 'function')
        throw Error('Expected reviewed personal tool factory'); api.registerTool({ contextVersion: 2, create(ctx) { const tool = definition(ctx); if (!tool || Array.isArray(tool))
            throw Error('Expected one synchronous personal tool'); return { ...tool, async execute(callId, params, signal, onUpdate) { if (!/^agent:main:cron:/.test(ctx.sessionKey ?? ''))
                assertToolAccess(ctx, ctx.getRuntimeConfig?.() ?? api.config, tool.name, params);
            else if (tool.name !== 'personal_weather_get_brief')
                throw Error('forbidden_context'); return tool.execute(callId, params, signal, onUpdate); } }; } }, options); } }); return plugin; }
