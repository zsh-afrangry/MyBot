import { describe, expect, it } from "vitest";

import { normalizeSearchQuery, readSearchQuery } from "./query.js";
import { sensitiveOpenIdQuery, sensitiveTicketQuery } from "./test-fixtures.js";

describe("search query guards", () => {
  it("normalizes bounded public queries", () => {
    expect(normalizeSearchQuery("  OpenClaw web search  ")).toBe("OpenClaw web search");
    expect(normalizeSearchQuery("中文\u0301")).toBe("中\u6587\u0301".normalize("NFC"));
  });

  it("rejects controls, oversized values, and obvious credentials", () => {
    expect(() => normalizeSearchQuery("\ncurrent news")).toThrowError();
    expect(() => normalizeSearchQuery("x".repeat(201))).toThrowError();
    expect(() => normalizeSearchQuery("Bearer abcdefghijklmnop")).toThrowError();
    expect(() => normalizeSearchQuery("api_key=secret-value")).toThrowError();
  });

  it("rejects labelled OpenID, ticket, and identity-number formats", () => {
    expect(() => normalizeSearchQuery(sensitiveOpenIdQuery())).toThrowError();
    expect(() => normalizeSearchQuery(sensitiveTicketQuery())).toThrowError();
    expect(() => normalizeSearchQuery(
      "身份证号：11010519491231002X",
    )).toThrowError();
    expect(() => normalizeSearchQuery(
      "OpenClaw ticket documentation",
    )).not.toThrowError();
  });

  it("rejects a bare QQ/OpenID-shaped hexadecimal identifier", () => {
    expect(() => normalizeSearchQuery(
      sensitiveOpenIdQuery().replace("OpenID: ", ""),
    )).toThrowError();
  });

  it("rejects unknown tool fields before any provider call", () => {
    expect(() => readSearchQuery({ query: "weather", ownerId: "owner" })).toThrowError();
    expect(() => readSearchQuery(["weather"])).toThrowError();
  });
});
