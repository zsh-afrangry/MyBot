// Trusted transport context only; no natural-language action rules.
import {authorizedOwner} from '../access-control/index.js';

export const PERMIT_TTL_MS = 300000;

export function trustedText(ctx, owner, event = {}, now = Date.now()) {
  if (event.isTailDispatch || event.sendPolicy === 'deny' || ctx?.CommandAuthorized !== true
    || ctx.ChatType !== 'direct' || ctx.SenderId !== owner || ctx.OriginatingChannel !== 'kurumi-qq'
    || ctx.OriginatingTo !== 'user:' + owner || ctx.SessionKey !== 'agent:main:kurumi-qq:direct:' + owner
    || typeof ctx.RawBody !== 'string' || ctx.RawBody.length > 6000 || !ctx.MessageSid
    || !Number.isFinite(ctx.Timestamp) || Math.abs(now - ctx.Timestamp) >= PERMIT_TTL_MS) return;
  return ctx.RawBody.trim() || undefined;
}

export function createTrustedOwnerRequest(owner, now = Date.now) {
  let current;
  return {
    receive(event) {
      const at = now();
      const raw = trustedText(event.ctx, owner, event, at);
      if (!event.isTailDispatch && event.ctx?.SessionKey === `agent:main:kurumi-qq:direct:${owner}`) {
        current = raw ? {raw, at, messageId: String(event.ctx.MessageSid), sessionKey: event.ctx.SessionKey} : undefined;
      }
    },
    end(event = {}, ctx = {}) {
      const key = ctx.sessionKey ?? event.sessionKey;
      const id = ctx.sessionId ?? event.sessionId;
      if (id ? id === current?.sessionId : key === current?.sessionKey) current = undefined;
    },
    current: () => current,
    require(request, ctx, config) {
      const age = request ? now() - request.at : Infinity;
      if (!authorizedOwner(ctx, config) || !ctx.sessionId || !request || current !== request || age < 0 || age >= PERMIT_TTL_MS) {
        throw Error('需要有效的本人当前请求');
      }
      if (request.sessionId && request.sessionId !== ctx.sessionId) throw Error('请求会话已失效');
      request.sessionId = ctx.sessionId;
      ctx.assertInvocationCurrent();
      return request;
    },
  };
}
