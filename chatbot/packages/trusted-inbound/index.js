// Trusted transport context only; no natural-language action rules.
export const PERMIT_TTL_MS = 300000;

export function trustedText(ctx, owner, event = {}, now = Date.now()) {
  if (event.isTailDispatch || event.sendPolicy === 'deny' || ctx?.CommandAuthorized !== true
    || ctx.ChatType !== 'direct' || ctx.SenderId !== owner || ctx.OriginatingChannel !== 'kurumi-qq'
    || ctx.OriginatingTo !== 'user:' + owner || ctx.SessionKey !== 'agent:main:kurumi-qq:direct:' + owner
    || typeof ctx.RawBody !== 'string' || ctx.RawBody.length > 6000 || !ctx.MessageSid
    || !Number.isFinite(ctx.Timestamp) || Math.abs(now - ctx.Timestamp) >= PERMIT_TTL_MS) return;
  return ctx.RawBody.trim() || undefined;
}
