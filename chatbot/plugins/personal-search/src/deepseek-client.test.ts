import { afterEach, describe, expect, it, vi } from "vitest";

import {
  buildDeepSeekRequestBody,
  DeepSeekResponsesClient,
} from "./deepseek-client.js";
import { completedDeepSeekResponse } from "./test-fixtures.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("DeepSeek Responses client", () => {
  it("sends only the fixed Web Search request shape", async () => {
    let captured: Record<string, unknown> | undefined;
    const client = new DeepSeekResponsesClient(
      {
        baseUrl: "https://api.deepseek.com",
        model: "deepseek-v4-flash",
        apiKey: "test-key",
      },
      {
        now: (() => {
          let value = 1_000;
          return () => (value += 250);
        })(),
        request: async (options) => {
          captured = options.body;
          expect(options.url).toBe("https://api.deepseek.com/responses");
          expect(options.apiKey).toBe("test-key");
          expect(options.timeoutSeconds).toBe(60);
          expect(options.maxResponseBytes).toBe(1_024 * 1_024);
          return completedDeepSeekResponse();
        },
      },
    );

    const result = await client.search("OpenClaw web search");
    expect(result.citations).toHaveLength(1);
    expect(captured).toMatchObject({
      model: "deepseek-v4-flash",
      input: "OpenClaw web search",
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
      max_output_tokens: 2_000,
    });
    expect(captured?.text).toBeDefined();
    expect((captured?.instructions as string).toLowerCase()).toContain("json");
    expect(captured?.max_output_tokens).toBe(2_000);
    expect(captured?.instructions as string).toContain("没有图片、图表或扫描 PDF 的视觉读取能力");
    expect(captured).not.toHaveProperty("images");
  });

  it("exports the same fixed request body used by the adapter", () => {
    const body = buildDeepSeekRequestBody("public query");
    expect(body).toMatchObject({
      model: "deepseek-v4-flash",
      input: "public query",
      tools: [{ type: "web_search" }],
      tool_choice: { type: "web_search" },
    });
  });

  it.each([
    [401, "AUTH_FAILED"],
    [403, "AUTH_FAILED"],
    [429, "RATE_LIMITED"],
    [500, "UPSTREAM_UNAVAILABLE"],
    [503, "UPSTREAM_UNAVAILABLE"],
    [504, "TIMEOUT"],
  ] as const)("maps HTTP %s without retrying", async (status, code) => {
    const fetchMock = vi.fn(async () => new Response("upstream failure", { status }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekResponsesClient({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "test-key",
    });

    await expect(client.search("public query")).rejects.toMatchObject({ code });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("preserves a bounded Retry-After hint without retrying", async () => {
    const fetchMock = vi.fn(async () => new Response("rate limited", {
      status: 429,
      headers: { "Retry-After": "120" },
    }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekResponsesClient({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "test-key",
    });

    try {
      await client.search("public query");
      throw new Error("expected rate limit");
    } catch (error) {
      expect(error).toMatchObject({
        code: "RATE_LIMITED",
        retryable: true,
        retryAfterMs: 60_000,
      });
      expect((error as { toPublicResult: () => unknown }).toPublicResult()).toMatchObject({
        code: "RATE_LIMITED",
        retryAfterMs: 60_000,
      });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps malformed JSON and oversized responses to INVALID_RESPONSE", async () => {
    const fetchMock = vi.fn(async () => new Response("not json", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekResponsesClient({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "test-key",
    });
    await expect(client.search("public query")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);

    const oversizedFetch = vi.fn(async () => new Response("x".repeat(1_024 * 1_024 + 1), {
      status: 200,
    }));
    vi.stubGlobal("fetch", oversizedFetch);
    await expect(client.search("public query")).rejects.toMatchObject({
      code: "INVALID_RESPONSE",
    });
    expect(oversizedFetch).toHaveBeenCalledTimes(1);
  });

  it("maps an aborted upstream request to TIMEOUT", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("request aborted", "AbortError");
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekResponsesClient({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "test-key",
    });

    await expect(client.search("public query")).rejects.toMatchObject({
      code: "TIMEOUT",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["DNS", "ENOTFOUND", "DNS lookup failed"],
    ["connection", "ECONNRESET", "connection reset"],
    ["TLS", "ERR_TLS_CERT_ALTNAME_INVALID", "certificate mismatch"],
  ] as const)("maps %s failures to stable UPSTREAM_UNAVAILABLE", async (_label, code, message) => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error(message), { code });
    });
    vi.stubGlobal("fetch", fetchMock);
    const client = new DeepSeekResponsesClient({
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-v4-flash",
      apiKey: "test-key",
    });

    await expect(client.search("public query")).rejects.toMatchObject({
      code: "UPSTREAM_UNAVAILABLE",
      retryable: true,
      message: "搜索服务暂时不可用。",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
