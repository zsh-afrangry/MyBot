/** Interaction control only: domain results declare when another user turn is needed. */
export function createClarificationGate(allowed: ReadonlySet<string>, now = Date.now) {
  const waiting = new Map<string, number>();
  type Event = { toolName: string; runId?: string; result?: unknown };
  type Context = { runId?: string; sessionKey?: string };
  function key(event: Event, context: Context) {
    for (const [id, at] of waiting) if (now() - at >= 300_000) waiting.delete(id);
    if (!allowed.has(event.toolName) || (event.runId && context.runId && event.runId !== context.runId)) return;
    const run = event.runId ?? context.runId;
    return run && context.sessionKey ? JSON.stringify([run, context.sessionKey, event.toolName]) : undefined;
  }
  function afterTool(event: Event, context: Context) {
    const id = key(event, context);
    if (!id) return;
    try {
      const result = event.result as { content?: Array<{ type: string; text?: string }> } | undefined;
      const texts = result?.content?.filter(part => part.type === 'text');
      const value = texts?.length === 1 ? JSON.parse(texts[0]!.text ?? '') : undefined;
      if (value?.ok === false && value.requiresUserInput === true) {
        waiting.set(id, now());
        while (waiting.size > 256) waiting.delete(waiting.keys().next().value!);
      }
    } catch { /* Unrecognized results cannot establish a clarification requirement. */ }
  }
  function beforeTool(event: Event, context: Context) {
    const id = key(event, context);
    if (id && waiting.has(id)) return { block: true,
      blockReason: 'USER_CLARIFICATION_REQUIRED：本轮该工具已要求用户澄清。请向用户提问并等待下一条消息，不要自行替用户作答或继续调用来创建替代提案。' };
  }
  return { afterTool, beforeTool };
}

export function registerClarificationGate(api: unknown, allowed: ReadonlySet<string>) {
  const gate = createClarificationGate(allowed);
  const hooks = api as { on(name: string, handler: (event: any, context: any) => unknown): void };
  if (typeof hooks.on !== 'function') return;
  hooks.on('after_tool_call', gate.afterTool);
  hooks.on('before_tool_call', gate.beforeTool);
}
