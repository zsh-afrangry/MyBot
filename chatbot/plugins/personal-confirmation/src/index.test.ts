import { describe, expect, it, vi } from "vitest";
import { registerConfirmationBackend, type ConfirmationProposalRow } from "@kurumi/confirmation-core";
import entry from "./index.js";

describe("confirmation plugin registration", () => {
  it("registers awaited reply_dispatch, records before model continuation, and does not claim the turn", async () => {
    let handler: ((event: { ctx: Record<string, unknown> }) => void) | undefined;
    const names: string[] = [], trace: string[] = [];
    const api = { on(name: string, callback: typeof handler) { names.push(name); handler = callback; },
      logger: { info: vi.fn(), warn: vi.fn() }, registerService: vi.fn() };
    entry.register(api as unknown as Parameters<typeof entry.register>[0]);
    expect(names).toEqual(["reply_dispatch"]);
    expect(handler).toBeTypeOf("function");
    const proposalId = "12345678-1234-4234-8234-123456789abc", payloadHash = "a".repeat(64);
    const unregister = registerConfirmationBackend({ id: "standalone-notes", open: () => ({
      listInboundConfirmationCandidates: () => [{ proposalId } as ConfirmationProposalRow],
      recordInboundConfirmation() { trace.push("grant"); return true; }, close() { trace.push("close"); },
    }) });
    try {
      const result = await handler!({ ctx: { ChatType: "direct", OriginatingChannel: "qqbot",
        OriginatingTo: "qqbot:c2c:owner", SenderId: "owner", AccountId: "default", SessionKey: "session",
        MessageSid: "message", Timestamp: Date.now(), RawBody: `确认 proposalId=${proposalId} payloadHash=${payloadHash}` } });
      trace.push("model continuation");
      expect(result).toBeUndefined();
      expect(trace).toEqual(["grant", "close", "model continuation"]);
      expect(api.logger.info).toHaveBeenCalledWith(expect.stringContaining('"outcome":"recorded"'));
    } finally { unregister(); }
  });
});
