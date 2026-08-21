import { afterEach, describe, expect, it, vi } from "vitest";

import { createDeepSeekWebSearchProvider } from "./provider.js";
import { SearchError } from "./errors.js";
import {
  deepSeekModelConfig,
  completedDeepSeekResponse,
  sensitiveTicketQuery,
} from "./test-fixtures.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("DeepSeek web-search provider", () => {
  it("executes through the fixed model config and preserves answer provenance", async () => {
    const provider = createDeepSeekWebSearchProvider({
      request: async () => completedDeepSeekResponse(),
    });
    const tool = provider.createTool({ config: deepSeekModelConfig("test-key") } as never);
    expect(tool).not.toBeNull();
    const result = await tool!.execute({ query: "OpenClaw web search", count: 10 });
    expect(result).toMatchObject({
      kind: "answer",
      provider: "deepseek-search",
      source_verification: "provider_reported",
      citations: [{ url: "https://docs.openclaw.ai/tools/web" }],
    });
  });

  it("does not use an arbitrary provider endpoint", async () => {
    const provider = createDeepSeekWebSearchProvider({
      request: async () => completedDeepSeekResponse(),
    });
    const tool = provider.createTool({
      config: {
        ...deepSeekModelConfig(),
        models: {
          providers: {
            "deepseek-search": {
              baseUrl: "https://attacker.example/responses",
              api: "openai-responses",
              apiKey: "test-key",
              models: [{ id: "deepseek-v4-flash" }],
            },
          },
        },
      },
    } as never);
    await expect(tool!.execute({ query: "public query" })).rejects.toMatchObject({
      code: "CONFIG_INVALID",
    });
  });

  it("fails before the request when no API key is available", async () => {
    vi.stubEnv("DEEPSEEK_API_KEY", "");
    const request = vi.fn(async () => completedDeepSeekResponse());
    const provider = createDeepSeekWebSearchProvider({ request });
    const tool = provider.createTool({
      config: deepSeekModelConfig(undefined),
    } as never);

    await expect(tool!.execute({ query: "public query" })).rejects.toMatchObject({
      code: "AUTH_NOT_CONFIGURED",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("rejects a high-risk identifier before the Provider request", async () => {
    const request = vi.fn(async () => completedDeepSeekResponse());
    const provider = createDeepSeekWebSearchProvider({ request });
    const tool = provider.createTool({
      config: deepSeekModelConfig("test-key"),
    } as never);

    await expect(tool!.execute({
      query: sensitiveTicketQuery(),
    })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(request).not.toHaveBeenCalled();
  });

  it("emits redacted structured audit data for a successful search", async () => {
    const audits: unknown[] = [];
    const provider = createDeepSeekWebSearchProvider({
      request: async () => completedDeepSeekResponse(),
      now: (() => {
        let value = 10_000;
        return () => (value += 250);
      })(),
      onAudit: (event) => audits.push(event),
    });
    const tool = provider.createTool({ config: deepSeekModelConfig("test-key") } as never);

    await tool!.execute({ query: "OpenClaw web search", count: 5 });

    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      event: "personal-search.audit",
      provider: "deepseek-search",
      queryLength: "OpenClaw web search".length,
      resultCount: 1,
      status: "OK",
      quota: { minuteCount: 1, dayCount: 1, inFlight: 0 },
    });
    expect(audits[0]).toMatchObject({
      queryHash: expect.stringMatching(/^[0-9a-f]{64}$/u),
      requestId: expect.stringMatching(/^[0-9a-f-]{36}$/u),
    });
    expect(JSON.stringify(audits[0])).not.toContain("OpenClaw web search");
  });

  it("records a stable error audit without allowing the audit sink to fail the search", async () => {
    const audits: unknown[] = [];
    const provider = createDeepSeekWebSearchProvider({
      request: async () => {
        throw new SearchError("UPSTREAM_UNAVAILABLE");
      },
      onAudit: (event) => {
        audits.push(event);
        throw new Error("logger unavailable");
      },
    });
    const tool = provider.createTool({ config: deepSeekModelConfig("test-key") } as never);

    await expect(tool!.execute({ query: "public query" })).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: "UPSTREAM_UNAVAILABLE",
      resultCount: 0,
    });
  });
});
