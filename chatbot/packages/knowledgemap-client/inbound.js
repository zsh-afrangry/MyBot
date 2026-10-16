// A current trusted owner message is the authority; no natural-language action parser.
import {trustedText, PERMIT_TTL_MS} from '../../plugins/personal-reminder-list/inbound.js';
import {ownerAuthorized} from '../../plugins/kurumi-qq/src/config.js';

export function createBridgeInbound(owner, now = Date.now) {
  let current;
  return {
    receive(event) {
      const raw = trustedText(event.ctx, owner, event, now());
      if (!event.isTailDispatch && event.ctx?.SessionKey === `agent:main:kurumi-qq:direct:${owner}`) {
        current = raw ? {raw, at: now(), messageId: String(event.ctx.MessageSid), sessionKey: event.ctx.SessionKey} : undefined;
      }
    },
    end(event = {}, ctx = {}) {
      const key = ctx.sessionKey ?? event.sessionKey;
      const id = ctx.sessionId ?? event.sessionId;
      if (id ? id === current?.sessionId : key === current?.sessionKey) current = undefined;
    },
    current: () => current,
    require(request, ctx, config) {
      if (!ownerAuthorized(ctx, config) || !ctx.sessionId || !request || current !== request || now() < request.at || now() - request.at >= PERMIT_TTL_MS) throw Error('需要有效的本人当前请求');
      if (request.sessionId && request.sessionId !== ctx.sessionId) throw Error('请求会话已失效');
      request.sessionId = ctx.sessionId;
      ctx.assertInvocationCurrent();
      return request;
    },
  };
}
