import { describe, expect, it } from "vitest";
import { createControlledReplies } from "./controlled-replies.js";

const instruction = "确认 proposalId=test payloadHash=test";
const local = "2026-09-11T05:00:00+08:00";
const preview = `待确认\n确认截止：${local}（Asia/Shanghai）\n${instruction}`;
const result = { content: [{ type: "text", text: JSON.stringify({ ok: true, status: "pending", previewText: preview,
  confirmationInstruction: instruction, expiresAtDisplay: { local, timezone: "Asia/Shanghai" } }) }] };
const event = (runId = "run") => ({ toolName: "proposal", runId, result });
const context = (runId = "run", sessionKey = "session") => ({ runId, sessionKey });
const reply = (runId = "run", sessionKey = "session") => ({ runId, sessionKey, channel: "qqbot", kind: "final", payload: { text: "模型遗漏截止", replyToId: "message" } });
const create = () => createControlledReplies(new Set(["proposal"]));

describe("controlled proposal presentation", () => {
  it("preserves the canonical text and payload metadata without mutating the input", () => {
    const handler = create(), original = reply(); handler.afterTool(event(), context());
    expect(handler.beforeReply(original)?.payload).toEqual({ text: preview, replyToId: "message" });
    expect(original.payload.text).toBe("模型遗漏截止");
    expect(handler.beforeReply(original)).toBeUndefined();
  });
  it("isolates runs and sessions", () => {
    const handler = create(); handler.afterTool(event(), context());
    expect(handler.beforeReply(reply("other"))).toBeUndefined();
    expect(handler.beforeReply(reply("run", "other"))).toBeUndefined();
    expect(handler.beforeReply(reply())?.payload.text).toBe(preview);
  });
  it("rejects missing or mismatched correlation", () => {
    const handler = create(); handler.afterTool(event(), context("different"));
    handler.afterTool(event(), { runId: "run" });
    expect(handler.beforeReply(reply())).toBeUndefined();
  });
  it("does not rewrite mixed calls, failures, unknown tools or malformed results", () => {
    for (const second of [{ ...event(), toolName: "other" }, { ...event(), error: "failure" }, event()]) {
      const handler = create(); handler.afterTool(event(), context()); handler.afterTool(second, context());
      expect(handler.beforeReply(reply())).toBeUndefined();
    }
    for (const first of [{ ...event(), toolName: "other" }, { ...event(), error: "failure" },
      { ...event(), result: { ...result, isError: true } }, { ...event(), result: { content: [{ type: "text", text: "not JSON" }] } }]) {
      const handler = create(); handler.afterTool(first, context()); expect(handler.beforeReply(reply())).toBeUndefined();
    }
  });
  it("does not overwrite blocks, prior output, other channels or media", () => {
    for (const first of [{ ...reply(), kind: "block" }, { ...reply(), channel: "other" }, { ...reply(), payload: { text: "caption", mediaUrl: "test" } }]) {
      const handler = create(); handler.afterTool(event(), context());
      expect(handler.beforeReply(first)).toBeUndefined(); expect(handler.beforeReply(reply())).toBeUndefined();
    }
    const handler = create(); handler.beforeReply({ ...reply(), kind: "block" }); handler.afterTool(event(), context());
    expect(handler.beforeReply(reply())).toBeUndefined();
  });
  it("expires and bounds retained state", () => {
    let now = 0; const handler = createControlledReplies(new Set(["proposal"]), () => now);
    handler.afterTool(event(), context()); now = 300_000;
    expect(handler.beforeReply(reply())).toBeUndefined();
    for (let i = 0; i < 257; i++) handler.afterTool(event(String(i)), context(String(i)));
    expect(handler.beforeReply(reply("0"))).toBeUndefined();
    expect(handler.beforeReply(reply("256"))?.payload.text).toBe(preview);
  });
});
