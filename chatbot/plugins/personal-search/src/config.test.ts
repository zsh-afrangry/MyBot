import { describe, expect, it } from "vitest";

import {
  resolveDeepSeekApiKey,
  resolveDeepSeekProviderConfig,
} from "./config.js";
import { deepSeekModelConfig } from "./test-fixtures.js";

describe("DeepSeek configuration", () => {
  it("accepts the fixed official Responses transport", () => {
    expect(resolveDeepSeekProviderConfig(deepSeekModelConfig())).toMatchObject({
      baseUrl: "https://api.deepseek.com",
      api: "openai-responses",
      model: "deepseek-v4-flash",
    });
  });

  it("rejects a model-controlled or non-official endpoint", () => {
    expect(() => resolveDeepSeekProviderConfig({
      ...deepSeekModelConfig(),
      models: {
        providers: {
          "deepseek-search": {
            ...((deepSeekModelConfig().models as Record<string, unknown>).providers as Record<string, unknown>)["deepseek-search"] as Record<string, unknown>,
            baseUrl: "https://example.com/responses",
          },
        },
      },
    })).toThrowError();
  });

  it("resolves only the configured environment SecretRef", () => {
    const original = process.env.DEEPSEEK_API_KEY;
    process.env.DEEPSEEK_API_KEY = "test-deepseek-key";
    try {
      expect(resolveDeepSeekApiKey(deepSeekModelConfig())).toBe("test-deepseek-key");
    } finally {
      if (original === undefined) delete process.env.DEEPSEEK_API_KEY;
      else process.env.DEEPSEEK_API_KEY = original;
    }
  });
});
