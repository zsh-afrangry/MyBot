// Transport trust only; the language policy lives in policy.js.
export function trustedMemoryText(ctx, owner, event = {}) {
  if (event.isTailDispatch || event.sendPolicy === 'deny' || ctx.CommandAuthorized !== true
    || ctx.ChatType !== 'direct' || ctx.SenderId !== owner || ctx.OriginatingChannel !== 'kurumi-qq'
    || ctx.OriginatingTo !== `user:${owner}` || ctx.SessionKey !== `agent:main:kurumi-qq:direct:${owner}`
    || typeof ctx.RawBody !== 'string' || ctx.RawBody.length > 2000 || !ctx.MessageSid || !Number.isFinite(ctx.Timestamp)
    || Math.abs(Date.now() - ctx.Timestamp) > 300000) return;
  return ctx.RawBody;
}

// Freshness and one-write execution stay mandatory for every policy adapter.
export function assertMemoryRequest(request, now = Date.now()) {
  if (!request || request.used || !Number.isFinite(request.at) || now < request.at || now - request.at > 300000) throw Error('需要有效的本人当前记忆请求');
}
