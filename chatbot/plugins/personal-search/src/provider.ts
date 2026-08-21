import { Type } from "typebox";
import {
  resolveWebSearchProviderCredential,
  type WebSearchProviderPlugin,
} from "openclaw/plugin-sdk/provider-web-search";

import {
  resolveDeepSeekApiKey,
  resolveDeepSeekProviderConfig,
  readDeepSeekRawApiKey,
  DEEPSEEK_CREDENTIAL_PATH,
} from "./config.js";
import { DeepSeekResponsesClient, type DeepSeekJsonRequester } from "./deepseek-client.js";
import { asSearchError, SearchError } from "./errors.js";
import { createSearchAuditEvent, type SearchAuditEvent } from "./audit.js";
import { readProviderSearchQuery } from "./query.js";
import { SearchQuota, type SearchQuotaOptions } from "./quota.js";

const providerSearchParameters = Type.Object(
  {
    query: Type.String({ minLength: 1, maxLength: 200 }),
    count: Type.Optional(Type.Integer({ minimum: 1, maximum: 10 })),
  },
  { additionalProperties: false },
);

export interface DeepSeekProviderOptions extends SearchQuotaOptions {
  request?: DeepSeekJsonRequester;
  onAudit?: (event: SearchAuditEvent) => void;
}

export function createDeepSeekWebSearchProvider(
  options: DeepSeekProviderOptions = {},
): WebSearchProviderPlugin {
  const quota = new SearchQuota(options);

  return {
    id: "deepseek-search",
    label: "DeepSeek Responses Web Search",
    hint: "AI-synthesized public search answer with provider-reported sources",
    credentialLabel: "DeepSeek API key",
    envVars: ["DEEPSEEK_API_KEY"],
    placeholder: "sk-...",
    signupUrl: "https://platform.deepseek.com/api_keys",
    docsUrl: "https://api-docs.deepseek.com/zh-cn/guides/responses_api/",
    credentialPath: DEEPSEEK_CREDENTIAL_PATH,
    getCredentialValue: (searchConfig) => searchConfig?.apiKey,
    setCredentialValue: (searchConfigTarget, value) => {
      searchConfigTarget.apiKey = value;
    },
    getConfiguredCredentialValue: (config) => readDeepSeekRawApiKey(config),
    createTool: (context) => ({
      description:
        "Search public web pages through DeepSeek Responses Web Search. Returns an untrusted synthesized answer and provider-reported source URLs; it does not fetch arbitrary URLs.",
      parameters: providerSearchParameters,
      execute: async (args, executionContext) => {
        const query = readProviderSearchQuery(args);
        const config = context.config;
        const providerConfig = resolveDeepSeekProviderConfig(config);
        const apiKey = resolveWebSearchProviderCredential({
          credentialValue: providerConfig.apiKey,
          path: DEEPSEEK_CREDENTIAL_PATH,
          envVars: ["DEEPSEEK_API_KEY"],
        });
        if (!apiKey) {
          // Keep the provider surface deterministic even when invoked outside the
          // personal tool, where the model-provider SecretRef may be absent.
          throw new SearchError("AUTH_NOT_CONFIGURED");
        }
        const clientOptions = {
          ...(options.request ? { request: options.request } : {}),
          ...(options.now ? { now: options.now } : {}),
        };
        const client = new DeepSeekResponsesClient(
          {
            baseUrl: providerConfig.baseUrl,
            model: providerConfig.model,
            apiKey,
          },
          clientOptions,
        );
        const startedAt = (options.now ?? Date.now)();
        try {
          const result = await quota.run(() =>
            client.search(query, executionContext?.signal),
          );
          emitAudit(options.onAudit, createSearchAuditEvent({
            query,
            elapsedMs: (options.now ?? Date.now)() - startedAt,
            resultCount: result.citations.length,
            status: "OK",
            quota: quota.snapshot(),
          }));
          return { ...result };
        } catch (error) {
          const normalizedError = asSearchError(error);
          emitAudit(options.onAudit, createSearchAuditEvent({
            query,
            elapsedMs: (options.now ?? Date.now)() - startedAt,
            resultCount: 0,
            status: normalizedError.code,
            quota: quota.snapshot(),
          }));
          throw error;
        }
      },
    }),
  };
}

function emitAudit(
  callback: ((event: SearchAuditEvent) => void) | undefined,
  event: SearchAuditEvent,
): void {
  if (!callback) return;
  try {
    callback(event);
  } catch {
    // Audit is non-critical telemetry; a logger failure must not change the
    // search result or turn a successful search into a retryable failure.
  }
}

export { providerSearchParameters };

// Keep this helper available for tests and future setup diagnostics without
// exposing the resolved value in logs or tool output.
export function resolveConfiguredDeepSeekApiKey(config: unknown): string {
  return resolveDeepSeekApiKey(config);
}
