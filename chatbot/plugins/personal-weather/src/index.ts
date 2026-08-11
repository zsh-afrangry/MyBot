import { Type } from "typebox";
import {
  payloadTextResult,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-runtime";
import { callGatewayTool } from "openclaw/plugin-sdk/agent-harness-runtime";
import { defineToolPlugin } from "openclaw/plugin-sdk/tool-plugin";

import { resolvePersonalWeatherConfig } from "./config.js";
import { asWeatherError } from "./errors.js";
import { formatWeatherBrief } from "./formatter.js";
import { reminderStateDirectory, weatherStateDirectory } from "./paths.js";
import { buildReminderCronAddParams, buildReminderCronUpdateParams } from "./reminder-gateway.js";
import { reconcileReminderState } from "./reminder-reconciler.js";
import { createReminderReconcilerService } from "./reminder-reconciler-service.js";
import { QWeatherClient } from "./qweather-client.js";
import {
  commitPlanningProposal,
  getPlanningState,
  proposePlanningChange,
  TRANSPORT_MODES,
  TIME_PRECISIONS,
} from "./planning.js";
import {
  commitReminderProposal,
  getReminderState,
  proposeReminderCancellation,
  proposeReminderCreate,
  proposeReminderUpdate,
  type ReminderCronAddInput,
  type ReminderCronScheduler,
  type TrustedReminderContext,
} from "./reminders.js";
import { ReminderStore, type ReminderDelivery } from "./reminder-store.js";
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
const planningCommitParameters = Type.Object(
  {
    proposal_id: Type.String({
      minLength: 36,
      maxLength: 36,
      pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
    }),
    payload_hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
  },
  { additionalProperties: false },
);

const reminderStateParameters = Type.Object({}, { additionalProperties: false });
const reminderCreateParameters = Type.Object(
  {
    schema_version: Type.Literal(1),
    request: Type.Object(
      {
        kind: Type.Literal("reminder.create"),
        content: Type.String({ minLength: 1, maxLength: 200 }),
        schedule: Type.Object(
          {
            local_date_time: Type.String({
              minLength: 16,
              maxLength: 16,
              pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$",
            }),
            timezone: Type.Literal("Asia/Shanghai"),
          },
          { additionalProperties: false },
        ),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const reminderCancelParameters = Type.Object(
  {
    schema_version: Type.Literal(1),
    request: Type.Object(
      {
        kind: Type.Literal("reminder.cancel"),
        reminder_id: Type.String({
          minLength: 36,
          maxLength: 36,
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
      },
      { additionalProperties: false },
    ),
  },
  { additionalProperties: false },
);
const reminderUpdateParameters = Type.Object(
  {
    schema_version: Type.Literal(1),
    request: Type.Object(
      {
        kind: Type.Literal("reminder.update"),
        reminder_id: Type.String({
          minLength: 36,
          maxLength: 36,
          pattern: "^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$",
        }),
        content: Type.Optional(Type.String({ minLength: 1, maxLength: 200 })),
        schedule: Type.Optional(Type.Object(
          {
            local_date_time: Type.String({
              minLength: 16,
              maxLength: 16,
              pattern: "^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}$",
            }),
            timezone: Type.Literal("Asia/Shanghai"),
          },
          { additionalProperties: false },
        )),
      },
      { additionalProperties: false, minProperties: 2 },
    ),
  },
  { additionalProperties: false },
);
const reminderCommitParameters = planningCommitParameters;

const personalWeatherPlugin = defineToolPlugin({
  id: "personal-weather",
  name: "Personal Weather",
  description: "Owner-only weather reads and typed travel proposal previews for kurumi.",
  activation: { onStartup: true },
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
    tool({
      name: "personal_planning_change_commit",
      label: "Commit a personal planning proposal",
      description:
        "Commit exactly one previously previewed owner travel proposal after explicit owner confirmation. The proposal ID and payload hash must match the frozen pending proposal. This writes only a planned trip record; it never changes the weather location, reminders, Cron, files, or host.",
      parameters: planningCommitParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_planning_change_commit",
        label: "Commit a personal planning proposal",
        description:
          "Commit a hash-matched pending trip proposal in the owner's QQ private chat. This cannot change weather location or schedules.",
        parameters: planningCommitParameters,
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
            return payloadTextResult(commitPlanningProposal(store, params));
          } catch (error) {
            return payloadTextResult(asWeatherError(error).toPublicResult());
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_state_get",
      label: "Personal reminder state",
      description:
        "Read the owner's active one-time reminder summaries. Owner QQ private chat only; this tool cannot create, change, cancel, send, or manage Cron jobs.",
      parameters: reminderStateParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_state_get",
        label: "Personal reminder state",
        description: "Read active owner-private reminders without changing anything.",
        parameters: reminderStateParameters,
        async execute() {
          if (!isTrustedOwnerPrivateQq(toolContext)) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            reconcileReminderState(store);
            return payloadTextResult(getReminderState(store));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_propose",
      label: "Propose a personal reminder",
      description:
        "Create a typed preview for one future owner-private reminder. It stores only a pending proposal; it does not create Cron, send QQ messages, or change any existing reminder.",
      parameters: reminderCreateParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_propose",
        label: "Propose a personal reminder",
        description:
          "Create a pending one-time reminder preview. Use an explicit future Asia/Shanghai local date and time; never supply a recipient or Cron expression.",
        parameters: reminderCreateParameters,
        async execute(_toolCallId, params) {
          const context = trustedReminderContext(toolContext);
          if (!context) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            return payloadTextResult(proposeReminderCreate(store, params, context));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_commit",
      label: "Commit a personal reminder proposal",
      description:
        "After explicit owner confirmation, create exactly one reminder from a frozen pending proposal whose ID and payload hash match. This tool cannot target anyone except the owner private QQ conversation.",
      parameters: reminderCommitParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_commit",
        label: "Commit a personal reminder proposal",
        description:
          "Commit exactly one hash-matched pending reminder proposal after explicit owner confirmation in the same QQ private chat.",
        parameters: reminderCommitParameters,
        async execute(_toolCallId, params) {
          const context = trustedReminderContext(toolContext);
          if (!context) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            return payloadTextResult(await commitReminderProposal(
              store,
              params,
              context,
              createGatewayReminderScheduler(),
            ));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_change_propose",
      label: "Propose personal reminder change",
      description:
        "Create a typed preview to change the content and/or time of one existing owner-private reminder in place. It never creates a second Cron job and requires a separate explicit confirmation.",
      parameters: reminderUpdateParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_change_propose",
        label: "Propose personal reminder change",
        description:
          "Create a pending owner-private reminder change preview. The existing managed Cron job is updated only after confirmation.",
        parameters: reminderUpdateParameters,
        async execute(_toolCallId, params) {
          const context = trustedReminderContext(toolContext);
          if (!context) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            return payloadTextResult(proposeReminderUpdate(store, params, context));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_change_commit",
      label: "Commit personal reminder change",
      description:
        "After explicit owner confirmation, apply exactly one frozen reminder change proposal. It updates the existing managed Cron job in place and never accepts arbitrary Cron parameters.",
      parameters: reminderCommitParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_change_commit",
        label: "Commit personal reminder change",
        description:
          "Commit one hash-matched pending reminder change in the owner's QQ private chat; repeated confirmation is idempotent.",
        parameters: reminderCommitParameters,
        async execute(_toolCallId, params) {
          const context = trustedReminderContext(toolContext);
          if (!context) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            return payloadTextResult(await commitReminderProposal(
              store,
              params,
              context,
              createGatewayReminderScheduler(),
            ));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_cancel_propose",
      label: "Propose personal reminder cancellation",
      description:
        "Create a pending preview to cancel one known, unexpired owner-private reminder. It does not cancel anything until a separate explicit confirmation commit.",
      parameters: reminderCancelParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_cancel_propose",
        label: "Propose personal reminder cancellation",
        description: "Create a pending cancellation preview for one active owner-private reminder.",
        parameters: reminderCancelParameters,
        async execute(_toolCallId, params) {
          const context = trustedReminderContext(toolContext);
          if (!context) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            return payloadTextResult(proposeReminderCancellation(store, params, context));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
    tool({
      name: "personal_reminder_cancel_commit",
      label: "Commit personal reminder cancellation",
      description:
        "After explicit owner confirmation, cancel exactly one frozen reminder-cancellation proposal whose ID and payload hash match. This only removes the associated managed reminder Cron job.",
      parameters: reminderCommitParameters,
      optional: true,
      factory: ({ toolContext }): AnyAgentTool => ({
        name: "personal_reminder_cancel_commit",
        label: "Commit personal reminder cancellation",
        description: "Commit exactly one hash-matched pending reminder cancellation after owner confirmation.",
        parameters: reminderCommitParameters,
        async execute(_toolCallId, params) {
          const context = trustedReminderContext(toolContext);
          if (!context) return forbiddenResult();
          let store: ReminderStore | undefined;
          try {
            store = new ReminderStore({ stateDirectory: reminderStateDirectory() });
            return payloadTextResult(await commitReminderProposal(
              store,
              params,
              context,
              createGatewayReminderScheduler(),
            ));
          } catch (error) {
            return payloadTextResult({
              ok: false,
              error: { code: "reminder_unavailable", message: publicReminderError(error) },
            });
          } finally {
            store?.close();
          }
        },
      }),
    }),
  ],
});

const registerPersonalWeatherTools = personalWeatherPlugin.register;
personalWeatherPlugin.register = (api) => {
  registerPersonalWeatherTools(api);
  if (api.registrationMode !== "full") return;
  api.registerService(createReminderReconcilerService({ scheduler: createGatewayReminderScheduler() }));
};

export default personalWeatherPlugin;

/** Internal authorization predicate shared by every owner-only tool factory. */
export function isTrustedOwnerPrivateQq(toolContext: {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string; accountId?: string };
  senderIsOwner?: boolean;
}): boolean {
  const channel = toolContext.messageChannel ?? toolContext.deliveryContext?.channel;
  const target = toolContext.deliveryContext?.to;
  const isGroupTarget = typeof target === "string" && /(?:^|:)group:/iu.test(target);
  return toolContext.senderIsOwner === true && channel === "qqbot" && !isGroupTarget;
}

function trustedReminderContext(toolContext: {
  messageChannel?: string;
  deliveryContext?: { channel?: string; to?: string; accountId?: string };
  senderIsOwner?: boolean;
}): TrustedReminderContext | undefined {
  if (!isTrustedOwnerPrivateQq(toolContext)) return undefined;
  const to = toolContext.deliveryContext?.to?.trim();
  if (!to || to.length > 500) return undefined;
  const accountId = toolContext.deliveryContext?.accountId?.trim();
  const delivery: ReminderDelivery = {
    channel: "qqbot",
    to,
    accountId: accountId ? accountId : null,
  };
  return { delivery };
}

function forbiddenResult() {
  return payloadTextResult({
    ok: false,
    error: {
      code: "forbidden_context",
      message: "此工具仅支持主人 QQ 私聊。",
    },
  });
}

function publicReminderError(_error: unknown): string {
  return "提醒服务暂时不可用，未创建、取消或发送任何提醒。";
}

function createGatewayReminderScheduler(): ReminderCronScheduler {
  return {
    async add(input: ReminderCronAddInput): Promise<{ jobId: string }> {
      const result = await callGatewayTool<unknown>(
        "cron.add",
        { timeoutMs: 60_000 },
        buildReminderCronAddParams(input),
      );
      const jobId = extractCronJobId(result);
      if (!jobId) throw new Error("Gateway cron.add did not return a job id");
      return { jobId };
    },
    async remove(input: { jobId: string }): Promise<void> {
      await callGatewayTool<unknown>(
        "cron.remove",
        { timeoutMs: 60_000 },
        { id: input.jobId },
      );
    },
    async update(input) {
      await callGatewayTool<unknown>(
        "cron.update",
        { timeoutMs: 60_000 },
        buildReminderCronUpdateParams(input),
      );
    },
  };
}

function extractCronJobId(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value.jobId ?? value.id;
  if (typeof direct === "string" && direct.length >= 1 && direct.length <= 200) return direct;
  const nested = value.job;
  if (!isRecord(nested)) return undefined;
  const nestedId = nested.id ?? nested.jobId;
  return typeof nestedId === "string" && nestedId.length >= 1 && nestedId.length <= 200
    ? nestedId
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
