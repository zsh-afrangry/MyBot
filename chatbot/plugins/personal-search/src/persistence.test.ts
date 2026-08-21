import { describe, expect, it } from "vitest";

import {
  redactSearchToolCallForPersistence,
  redactSearchToolResultForPersistence,
} from "./persistence.js";

describe("search persistence redaction", () => {
  it("redacts only the persisted personal search tool arguments", () => {
    const query = ["Kurumi", "Persistence", "Test", "-", "20260813"].join("");
    const message = {
      role: "assistant",
      content: [{
        type: "toolCall",
        id: "call-search",
        name: "personal_web_search",
        arguments: { query, count: 5 },
      }],
    };

    const redacted = redactSearchToolCallForPersistence(message) as typeof message;
    expect(message.content[0].arguments.query).toBe(query);
    expect(redacted.content[0].arguments).toEqual({
      query: "[redacted search query]",
      count: 5,
    });
    expect(JSON.stringify(redacted)).not.toContain(query);
  });

  it("redacts query fields in persisted result content and details", () => {
    const query = ["Kurumi", "Result", "Test", "-", "20260813"].join("");
    const payload = {
      ok: true,
      result: {
        kind: "answer",
        query,
        content: "answer text",
        citations: [{ title: "Example", url: "https://example.com" }],
      },
    };
    const message = {
      role: "toolResult",
      toolName: "personal_web_search",
      content: [{ type: "text", text: JSON.stringify(payload) }],
      details: payload,
    };

    const redacted = redactSearchToolResultForPersistence(message) as typeof message;
    expect(JSON.stringify(redacted)).not.toContain(query);
    expect(redacted.content[0].text).toContain("answer text");
    expect(redacted.details.result.query).toBe("[redacted search query]");
  });

  it("leaves unrelated messages unchanged", () => {
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "ordinary answer" }],
    };
    expect(redactSearchToolCallForPersistence(message)).toBe(message);
    expect(redactSearchToolResultForPersistence(message, "other_tool")).toBe(message);
  });
});
