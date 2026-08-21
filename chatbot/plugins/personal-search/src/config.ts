import { resolveWebSearchProviderCredential } from "openclaw/plugin-sdk/provider-web-search";

import { SearchError } from "./errors.js";
import {
  DEEPSEEK_MODEL_ID,
  DEEPSEEK_SEARCH_PROVIDER_ID,
} from "./types.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_CREDENTIAL_PATH =
  "models.providers.deepseek-search.apiKey";

export interface DeepSeekProviderConfig {
  baseUrl: string;
  api: "openai-responses";
  model: typeof DEEPSEEK_MODEL_ID;
  apiKey: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readModels(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) throw new SearchError("CONFIG_INVALID");
  return value.filter(isRecord);
}

export function readDeepSeekRawApiKey(config: unknown): unknown {
  const provider = readDeepSeekProviderRecord(config);
  return provider.apiKey;
}

export function resolveDeepSeekProviderConfig(
  config: unknown,
): DeepSeekProviderConfig {
  const provider = readDeepSeekProviderRecord(config);
  const baseUrl = provider.baseUrl;
  const api = provider.api;
  const models = readModels(provider.models);
  const model = models.find((candidate) => candidate.id === DEEPSEEK_MODEL_ID);

  if (
    typeof baseUrl !== "string" ||
    normalizeBaseUrl(baseUrl) !== DEEPSEEK_BASE_URL ||
    api !== "openai-responses" ||
    !model
  ) {
    throw new SearchError("CONFIG_INVALID");
  }

  return {
    baseUrl: DEEPSEEK_BASE_URL,
    api: "openai-responses",
    model: DEEPSEEK_MODEL_ID,
    apiKey: provider.apiKey,
  };
}

export function resolveDeepSeekApiKey(config: unknown): string {
  const apiKey = resolveWebSearchProviderCredential({
    credentialValue: readDeepSeekRawApiKey(config),
    path: DEEPSEEK_CREDENTIAL_PATH,
    envVars: ["DEEPSEEK_API_KEY"],
  });
  if (!apiKey) throw new SearchError("AUTH_NOT_CONFIGURED");
  return apiKey;
}

function readDeepSeekProviderRecord(config: unknown): Record<string, unknown> {
  if (!isRecord(config) || !isRecord(config.models) || !isRecord(config.models.providers)) {
    throw new SearchError("CONFIG_INVALID");
  }
  const provider = config.models.providers[DEEPSEEK_SEARCH_PROVIDER_ID];
  if (!isRecord(provider)) throw new SearchError("CONFIG_INVALID");
  return provider;
}

function normalizeBaseUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "api.deepseek.com" ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      (url.pathname !== "" && url.pathname !== "/")
    ) {
      return undefined;
    }
    return url.origin;
  } catch {
    return undefined;
  }
}
