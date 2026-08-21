import { describe, expect, it } from "vitest";

import { canonicalizePublicHttpsUrl, parseDeepSeekSearchResponse } from "./parser.js";
import {
  completedDeepSeekResponse,
  naturalLanguageDeepSeekResponse,
  naturalLanguageWithUrlDeepSeekResponse,
  visualBoundaryDeepSeekResponse,
} from "./test-fixtures.js";

describe("DeepSeek response parser", () => {
  it("extracts the last structured answer and provider-reported citations", () => {
    const result = parseDeepSeekSearchResponse(completedDeepSeekResponse(), {
      query: "OpenClaw web search",
      searchedAt: "2026-08-12T00:00:00.000Z",
      tookMs: 1234,
    });
    expect(result.kind).toBe("answer");
    expect(result.content).toContain("规范化");
    expect(result.citations).toEqual([
      {
        title: "OpenClaw Web Search",
        url: "https://docs.openclaw.ai/tools/web",
      },
    ]);
    expect(result.externalContent).toEqual({
      untrusted: true,
      source: "web_search",
      wrapped: true,
      provider: "deepseek-search",
    });
  });

  it("fails closed when there is no structured source evidence", () => {
    expect(() => parseDeepSeekSearchResponse({
      status: "completed",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "我搜到了，但没有来源。" }],
      }],
    }, {
      query: "query",
      searchedAt: "2026-08-12T00:00:00.000Z",
      tookMs: 1,
    })).toThrowError();
  });

  it("uses completed provider page visits when DeepSeek omits the JSON envelope", () => {
    const result = parseDeepSeekSearchResponse(naturalLanguageDeepSeekResponse(), {
      query: "OpenClaw web search",
      searchedAt: "2026-08-12T00:00:00.000Z",
      tookMs: 1,
    });
    expect(result.content).toContain("Provider 规范化");
    expect(result.citations).toEqual([
      {
        title: "docs.openclaw.ai",
        url: "https://docs.openclaw.ai/tools/web",
      },
    ]);
  });

  it("uses HTTPS links in a natural-language answer as provider-reported citations", () => {
    const result = parseDeepSeekSearchResponse(naturalLanguageWithUrlDeepSeekResponse(), {
      query: "public query",
      searchedAt: "2026-08-12T00:00:00.000Z",
      tookMs: 1,
    });
    expect(result.citations).toEqual([
      {
        title: "docs.openclaw.ai",
        url: "https://docs.openclaw.ai/tools/web",
      },
    ]);
  });

  it("preserves the worker's explicit no-visual-verification boundary", () => {
    const result = parseDeepSeekSearchResponse(visualBoundaryDeepSeekResponse(), {
      query: "请核对图片里的图表",
      searchedAt: "2026-08-12T00:00:00.000Z",
      tookMs: 1,
    });
    expect(result.content).toContain("未完成视觉核验");
    expect(result.externalContent).toMatchObject({
      untrusted: true,
      source: "web_search",
    });
  });

  it("rejects non-HTTPS, userinfo, IP, and local citation URLs", () => {
    expect(canonicalizePublicHttpsUrl("http://example.com")).toBeUndefined();
    expect(canonicalizePublicHttpsUrl("https://user:pass@example.com")).toBeUndefined();
    expect(canonicalizePublicHttpsUrl("https://127.0.0.1/a")).toBeUndefined();
    expect(canonicalizePublicHttpsUrl("https://localhost/a")).toBeUndefined();
    expect(canonicalizePublicHttpsUrl("https://example.com/a#tracking")).toBe("https://example.com/a");
  });
});
