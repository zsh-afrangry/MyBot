import { describe, expect, it } from "vitest";
import { confirmationFromDispatch } from "./inbound.js";

const now = 1_780_000_000_000;
const ctx = { ChatType: "direct", OriginatingChannel: "qqbot", OriginatingTo: "qqbot:c2c:owner",
  SenderId: "owner", AccountId: "default", SessionKey: "session-one", MessageSid: "message-one",
  Timestamp: now, RawBody: "确认 original", Body: "rewritten", BodyForCommands: "history" };

describe("QQ reply-dispatch adapter", () => {
  it("uses original message evidence and preserves account/session/peer", () => {
    expect(confirmationFromDispatch({ ctx }, now)).toMatchObject({ content: "确认 original", messageId: "message-one",
      senderId: "owner", conversationId: "qqbot:c2c:owner", accountId: "default", sessionKey: "session-one", timestamp: now });
  });
  it.each([
    { ChatType: "group" }, { ChatType: undefined }, { ReplyToIsQuote: true }, { OriginatingChannel: "telegram" },
    { OriginatingTo: "qqbot:group:room" }, { SenderId: undefined }, { RawBody: undefined },
    { MessageSid: undefined, MessageSidFirst: "history-id" }, { Timestamp: undefined },
    { Timestamp: now - 300_001 }, { Timestamp: now + 30_001 },
  ])("rejects missing or ineligible original evidence: %j", change => {
    expect(confirmationFromDispatch({ ctx: { ...ctx, ...change } }, now)).toBeUndefined();
  });
  it("ignores tail dispatch and denied delivery", () => {
    expect(confirmationFromDispatch({ ctx, isTailDispatch: true }, now)).toBeUndefined();
    expect(confirmationFromDispatch({ ctx, sendPolicy: "deny" }, now)).toBeUndefined();
  });
});
