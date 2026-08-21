import { describe, expect, it, vi } from "vitest";

import {
  createPersonalWebSearchTool,
  isTrustedOwnerPrivateQq,
} from "./index.js";
import { sensitiveTicketQuery } from "./test-fixtures.js";

describe("personal search tool boundary", () => {
  const ownerPrivateContext = {
    messageChannel: "qqbot",
    deliveryContext: {
      channel: "qqbot",
      to: "qqbot:c2c:owner",
      accountId: "default",
    },
    senderIsOwner: true,
  };

  it("allows only the owner in a private QQ delivery context", () => {
    expect(isTrustedOwnerPrivateQq(ownerPrivateContext)).toBe(true);
    expect(isTrustedOwnerPrivateQq({ ...ownerPrivateContext, senderIsOwner: false })).toBe(false);
    expect(isTrustedOwnerPrivateQq({
      ...ownerPrivateContext,
      deliveryContext: { ...ownerPrivateContext.deliveryContext, to: "qqbot:group:123" },
    })).toBe(false);
    expect(isTrustedOwnerPrivateQq({ ...ownerPrivateContext, messageChannel: "telegram" })).toBe(false);
  });

  it("makes the main-agent delegation call only the controlled provider", async () => {
    const search = vi.fn(async () => ({
      provider: "deepseek-search",
      result: {
        schema_version: 1,
        kind: "answer",
        query: "current OpenClaw docs",
        content: "grounded answer",
        citations: [{ title: "OpenClaw", url: "https://docs.openclaw.ai/tools/web" }],
      },
    }));
    const api = {
      config: {},
      runtime: { webSearch: { search } },
    } as never;
    const tool = createPersonalWebSearchTool(api, ownerPrivateContext as never);
    const result = await tool.execute("tool-call", { query: "  current OpenClaw docs  " });
    expect(search).toHaveBeenCalledWith(expect.objectContaining({
      providerId: "deepseek-search",
      args: { query: "current OpenClaw docs", count: 5 },
      preferInputConfig: true,
    }));
    expect(result).toMatchObject({
      content: [{ type: "text" }],
    });
  });

  it("rejects unauthorized context before runtime search", async () => {
    const search = vi.fn();
    const api = { config: {}, runtime: { webSearch: { search } } } as never;
    const tool = createPersonalWebSearchTool(api, {
      ...ownerPrivateContext,
      senderIsOwner: false,
    } as never);
    const result = await tool.execute("tool-call", { query: "public query" });
    expect(search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: [{ type: "text" }] });
  });

  it("rejects a high-risk identifier before runtime search", async () => {
    const search = vi.fn();
    const api = { config: {}, runtime: { webSearch: { search } } } as never;
    const tool = createPersonalWebSearchTool(api, ownerPrivateContext as never);
    const result = await tool.execute("tool-call", {
      query: sensitiveTicketQuery(),
    });

    expect(search).not.toHaveBeenCalled();
    expect(result).toMatchObject({ content: [{ type: "text" }] });
  });
});
