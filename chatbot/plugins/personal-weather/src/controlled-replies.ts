/** Presentation support in the MVP container; no domain or authorization imports. */
type ToolEvent = { toolName: string; runId?: string; error?: string; result?: unknown };
type ToolContext = { runId?: string; sessionKey?: string };
type ReplyEvent = { runId?: string; sessionKey?: string; channel?: string; kind: string; payload: Record<string, unknown> };
type Entry = { createdAt: number; calls: number; text?: string; emitted: boolean };
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === "object" && !Array.isArray(value);

export function createControlledReplies(allowedTools: ReadonlySet<string>, now = Date.now) {
  const entries = new Map<string, Entry>();
  const key = (run?: string, session?: string) => run && session ? JSON.stringify([run, session]) : undefined;
  function prune() {
    for (const [id, entry] of entries) if (now() - entry.createdAt >= 300_000) entries.delete(id);
  }
  function save(id: string, entry: Entry) {
    entries.set(id, entry);
    while (entries.size > 256) entries.delete(entries.keys().next().value!);
  }
  function afterTool(event: ToolEvent, context: ToolContext) {
    prune();
    if (event.runId && context.runId && event.runId !== context.runId) return;
    const id = key(event.runId ?? context.runId, context.sessionKey);
    if (!id) return;
    const entry = entries.get(id) ?? { createdAt: now(), calls: 0, emitted: false };
    entry.calls++;
    // Every observed tool counts, including errors and tools outside the allowlist.
    delete entry.text;
    if (entry.calls === 1 && !event.error && allowedTools.has(event.toolName) && record(event.result) && event.result.isError !== true && Array.isArray(event.result.content)) {
      const texts = event.result.content.filter((part: unknown) => record(part) && part.type === "text");
      try {
        const result: unknown = texts.length === 1 ? JSON.parse(texts[0].text) : undefined;
        if (record(result) && result.ok === true && result.status === "pending" &&
          typeof result.previewText === "string" && result.previewText.length <= 20_000 &&
          typeof result.confirmationInstruction === "string" && result.confirmationInstruction.length > 0 &&
          record(result.expiresAtDisplay) && typeof result.expiresAtDisplay.local === "string" &&
          typeof result.expiresAtDisplay.timezone === "string" &&
          result.expiresAtDisplay.local.length > 0 && result.expiresAtDisplay.timezone.length > 0 &&
          result.previewText.includes(result.confirmationInstruction) &&
          result.previewText.includes(result.expiresAtDisplay.local) && result.previewText.includes(result.expiresAtDisplay.timezone)) entry.text = result.previewText;
      } catch { /* Unrecognized results remain untouched. */ }
    }
    save(id, entry);
  }
  function beforeReply(event: ReplyEvent) {
    prune();
    const id = key(event.runId, event.sessionKey), entry = id ? entries.get(id) : undefined;
    if (!entry) {
      if (id) save(id, { createdAt: now(), calls: 0, emitted: true });
      return;
    }
    const alreadyEmitted = entry.emitted;
    entry.emitted = true;
    if (alreadyEmitted || entry.calls !== 1 || !entry.text || event.kind !== "final" || event.channel !== "qqbot" ||
      typeof event.payload.text !== "string" || event.payload.mediaUrl || event.payload.mediaUrls) return;
    return { payload: { ...event.payload, text: entry.text } };
  }
  return { afterTool, beforeReply };
}

export function registerControlledReplies(api: unknown, allowedTools: ReadonlySet<string>) {
  // The installed runtime supports these public hooks; some base SDK types omit on.
  const replies = createControlledReplies(allowedTools);
  const hooks = api as {
    on(name: "after_tool_call", handler: typeof replies.afterTool): void;
    on(name: "reply_payload_sending", handler: typeof replies.beforeReply): void;
  };
  if (typeof hooks.on !== "function") return;
  hooks.on("after_tool_call", replies.afterTool);
  hooks.on("reply_payload_sending", replies.beforeReply);
}
