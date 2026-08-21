import { Type } from "typebox";
import {
  payloadTextResult,
  type AnyAgentTool,
} from "openclaw/plugin-sdk/agent-runtime";
import {
  definePluginEntry,
  type OpenClawPluginApi,
  type OpenClawPluginToolContext,
} from "openclaw/plugin-sdk/plugin-entry";
import type {
  PluginHookBeforeMessageWriteEvent,
  PluginHookBeforeMessageWriteResult,
  PluginHookToolResultPersistEvent,
  PluginHookToolResultPersistResult,
} from "openclaw/plugin-sdk/plugin-runtime";

import { asSearchError, SearchError } from "./errors.js";
import { createDeepSeekWebSearchProvider } from "./provider.js";
import {
  redactSearchToolCallForPersistence,
  redactSearchToolResultForPersistence,
} from "./persistence.js";
import { readSearchQuery } from "./query.js";
import { DEEPSEEK_SEARCH_PROVIDER_ID } from "./types.js";

const personalWebSearchParameters = Type.Object(
  {
    query: Type.String({
      minLength: 1,
      maxLength: 200,
      description: "A short public-web query. Do not include secrets or private identifiers.",
    }),
  },
  { additionalProperties: false },
);

const TOOL_DESCRIPTION =
  "Search public web pages for the owner in a private QQ chat. The query is sent to DeepSeek; " +
  "returned content and source URLs are untrusted provider-reported material. This tool returns " +
  "a bounded synthesized answer with at most five sources and does not fetch arbitrary URLs, use a browser, " +
  "read private memory, inspect images/charts/scanned PDFs, or send messages. Visual verification is not " +
  "performed by the search worker.";

const personalSearchPlugin: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: "personal-search",
  name: "Personal Search",
  description:
    "Owner-only controlled public web search through DeepSeek Responses Web Search.",
  register(api) {
    api.registerWebSearchProvider(createDeepSeekWebSearchProvider({
      onAudit: (event) => api.logger.info(JSON.stringify(event)),
    }));
    const hookApi = api as PersistenceHookApi;
    if (typeof hookApi.on === "function") {
      hookApi.on("before_message_write", (event) => {
        const message = redactSearchToolCallForPersistence(event.message);
        return message === event.message
          ? undefined
          : { message: message as typeof event.message };
      });
      hookApi.on("tool_result_persist", (event) => {
        const message = redactSearchToolResultForPersistence(event.message, event.toolName);
        return message === event.message
          ? undefined
          : { message: message as typeof event.message };
      });
    }
    api.registerTool(
      (toolContext) => createPersonalWebSearchTool(api, toolContext),
      { name: "personal_web_search", optional: true },
    );
  },
});

/**
 * `api.on` is the typed plugin-hook surface in the running OpenClaw host.  The
 * installed 2026.7.1 SDK still omits it from OpenClawPluginApi's declaration,
 * while the runtime exposes it; keep the compatibility cast local and narrow.
 */
type PersistenceHookApi = OpenClawPluginApi & {
  on(
    name: "before_message_write",
    handler: (
      event: PluginHookBeforeMessageWriteEvent,
    ) => PluginHookBeforeMessageWriteResult | void,
  ): void;
  on(
    name: "tool_result_persist",
    handler: (
      event: PluginHookToolResultPersistEvent,
    ) => PluginHookToolResultPersistResult | void,
  ): void;
};

export default personalSearchPlugin;

export function createPersonalWebSearchTool(
  api: OpenClawPluginApi,
  toolContext: OpenClawPluginToolContext,
): AnyAgentTool {
  return {
    name: "personal_web_search",
    label: "Personal web search",
    description: TOOL_DESCRIPTION,
    parameters: personalWebSearchParameters,
    async execute(_toolCallId, rawParams, signal) {
      try {
        if (!isTrustedOwnerPrivateQq(toolContext)) {
          throw new SearchError("FORBIDDEN_CONTEXT");
        }
        const query = readSearchQuery(rawParams);
        const config =
          toolContext.getRuntimeConfig?.() ??
          toolContext.runtimeConfig ??
          toolContext.config ??
          api.config;
        const searchOptions = {
          config,
          preferInputConfig: true,
          providerId: DEEPSEEK_SEARCH_PROVIDER_ID,
          args: { query, count: 5 },
          ...(signal ? { signal } : {}),
        };
        const response = await api.runtime.webSearch.search(searchOptions);
        return payloadTextResult({
          ok: true,
          provider: response.provider,
          result: response.result,
        });
      } catch (error) {
        return payloadTextResult(asSearchError(error).toPublicResult());
      }
    },
  };
}

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
