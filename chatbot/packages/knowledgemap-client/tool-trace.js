// Correlation only: trusted host hooks supply runId; factories do not expose it.
// Never grants authority or reads model-provided runId. Bounded and session-scoped.
export function createToolTrace(names, now = Date.now) {
  const allowed = new Set(names), calls = new Map();
  const nameOf = value => String(value ?? '').split(':').at(-1);
  const key = (ctx, id) => ctx.sessionKey && ctx.sessionId && id ? JSON.stringify([ctx.sessionKey, ctx.sessionId, id]) : undefined;
  const target = (event, ctx) => nameOf(event.toolName ?? ctx.toolName) === 'tool_call'
    ? nameOf(event.params?.id) : nameOf(event.toolName ?? ctx.toolName);
  return {
    attach(api) {
      if (api.registrationMode !== 'full' && api.registrationMode !== undefined) return;
      api.on('before_tool_call', (event, ctx) => {
        const name = target(event, ctx), id = event.toolCallId ?? ctx.toolCallId;
        const identity = key(ctx, id), runId = ctx.runId ?? event.runId;
        if (!allowed.has(name) || !identity || typeof runId !== 'string' || !runId || runId.length > 96) return;
        for (const [k, value] of calls) if (now() - value.at >= 300000) calls.delete(k);
        while (calls.size >= 1024) calls.delete(calls.keys().next().value);
        calls.set(identity, {runId, name, at: now()});
      }, {matcher: [...names, 'tool_call']});
      api.on('after_tool_call', (event, ctx) => {
        const identity = key(ctx, event.toolCallId ?? ctx.toolCallId);
        if (identity && allowed.has(target(event, ctx))) calls.delete(identity);
      }, {matcher: [...names, 'tool_call']});
      for (const hook of ['session_end', 'before_reset']) api.on(hook, (event, ctx = {}) => {
        const sessionId = ctx.sessionId ?? event.sessionId, sessionKey = ctx.sessionKey ?? event.sessionKey;
        for (const k of calls.keys()) {
          const [sk, sid] = JSON.parse(k);
          if (sessionId ? sid === sessionId : sessionKey && sk === sessionKey) calls.delete(k);
        }
      });
    },
    resolve(ctx, callId, name) {
      const identity = key(ctx, callId), value = identity && calls.get(identity);
      return value && value.name === name && now() - value.at < 300000 ? value.runId : undefined;
    },
  };
}
