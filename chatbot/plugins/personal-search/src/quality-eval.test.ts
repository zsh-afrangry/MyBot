import { describe, expect, it } from "vitest";

import { SearchError } from "./errors.js";
import { parseDeepSeekSearchResponse } from "./parser.js";
import {
  currentEventDeepSeekResponse,
  smallNicheDeepSeekResponse,
  zeroResultDeepSeekResponse,
} from "./test-fixtures.js";

const EVAL_OPTIONS = {
  searchedAt: "2026-08-12T00:00:00.000Z",
  tookMs: 1_234,
};

describe("search quality contract baseline", () => {
  it.each([
    ["current-event", "当前事件 query", currentEventDeepSeekResponse()],
    ["small-niche", "小众公开 query", smallNicheDeepSeekResponse()],
  ])("accepts a %s answer only with bounded evidence", (_label, query, payload) => {
    const result = parseDeepSeekSearchResponse(payload, {
      ...EVAL_OPTIONS,
      query,
    });

    expect(result.kind).toBe("answer");
    expect(result.citations.length).toBeGreaterThanOrEqual(1);
    expect(result.citations.length).toBeLessThanOrEqual(5);
    expect(result.source_verification).toBe("provider_reported");
    expect(result.searched_at).toBe(EVAL_OPTIONS.searchedAt);
    expect(result.took_ms).toBe(EVAL_OPTIONS.tookMs);
    expect(result.externalContent).toMatchObject({
      untrusted: true,
      source: "web_search",
      wrapped: true,
    });
  });

  it("keeps a zero-result answer fail-closed when no source is available", () => {
    try {
      parseDeepSeekSearchResponse(zeroResultDeepSeekResponse(), {
        ...EVAL_OPTIONS,
        query: "query with no public matches",
      });
      throw new Error("expected parser to reject source-free zero-result answer");
    } catch (error) {
      expect(error).toBeInstanceOf(SearchError);
      expect(error).toMatchObject({ code: "INVALID_RESPONSE" });
    }
  });

  it("does not promote unrelated provider page visits after structured sources are empty", () => {
    expect(() => parseDeepSeekSearchResponse({
      status: "completed",
      output: [
        {
          type: "web_search_call",
          status: "completed",
          action: {
            type: "open_page",
            url: "https://example.com/unrelated-near-match",
          },
        },
        {
          type: "message",
          content: [{
            type: "output_text",
            text: JSON.stringify({
              answer: "未找到完整标识符的可靠公开来源。",
              sources: [],
            }),
          }],
        },
      ],
    }, {
      ...EVAL_OPTIONS,
      query: "query with no public matches",
    })).toThrowError();
  });
});
