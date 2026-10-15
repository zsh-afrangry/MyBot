// Transport trust only; the language policy lives in policy.js.
export function trustedMemoryText(ctx, owner, event = {}) {
  if (event.isTailDispatch || event.sendPolicy === 'deny' || ctx.CommandAuthorized !== true
    || ctx.ChatType !== 'direct' || ctx.SenderId !== owner || ctx.OriginatingChannel !== 'kurumi-qq'
    || ctx.OriginatingTo !== `user:${owner}` || ctx.SessionKey !== `agent:main:kurumi-qq:direct:${owner}`
    || typeof ctx.RawBody !== 'string' || ctx.RawBody.length > 2000 || typeof ctx.Timestamp !== 'number'
    || Math.abs(Date.now() - ctx.Timestamp) > 300000) return;
  return ctx.RawBody;
}
