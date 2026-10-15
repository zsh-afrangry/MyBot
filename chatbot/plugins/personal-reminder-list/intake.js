import {trustedText} from './inbound.js';
import {listIntent, wantsContinuousEntry, isContinuationCandidate, isStandaloneReminder} from './policy.js';

export const SESSION_TTL_MS = 600000;
export const SESSION_MAX_MS = 1800000;

// reply_dispatch precedes session initialization. Bind its trusted text to the
// actual ephemeral UUID at tool execution, never to a UUID guessed from text.
// Only the owner's single direct route is supported; no persistent chat state.
export function createListIntake(owner, now = Date.now) {
  const sessionKey = 'agent:main:kurumi-qq:direct:' + owner;
  let current, continuous;
  const fresh = c => c && now() >= c.startedAt && now() - c.lastAt < SESSION_TTL_MS && now() - c.startedAt < SESSION_MAX_MS;
  function receive(event) {
    if (event.isTailDispatch || event.ctx?.SessionKey !== sessionKey) return;
    const at = now(), raw = trustedText(event.ctx, owner, event, at);
    const explicit = raw && listIntent(event.ctx, owner, event, at);
    const activation = !!raw && !isStandaloneReminder(raw) && wantsContinuousEntry(raw);
    const candidate = !!raw && !/提醒列表/u.test(raw) && fresh(continuous) && isContinuationCandidate(raw);
    if (!activation && !candidate && !explicit?.actions.has('add')) continuous = undefined;
    current = {raw, at, messageId: String(event.ctx.MessageSid), sessionKey,
      explicit, activation, candidate, listTarget: !!raw && !isStandaloneReminder(raw) && (/提醒列表/u.test(raw) || candidate)};
    return current;
  }
  function bind(request, ctx) {
    if (!request || current !== request || ctx.sessionKey !== sessionKey || !request.raw) return;
    if (request.sessionId && request.sessionId !== ctx.sessionId) return;
    const id = ctx.sessionId;
    if (id && !request.sessionId) request.sessionId = id;
    if (continuous && (!fresh(continuous) || !id || continuous.sessionId !== id)) continuous = undefined;
    if (request.activation && id && !request.activated) {
      continuous = {sessionId: id, startedAt: request.at, lastAt: request.at};
      request.activated = true;
    }
    if (request.explicit) return {...request.explicit, sessionId: id};
    if (request.candidate && continuous?.sessionId === id && fresh(continuous)) {
      return {raw: request.raw, at: request.at, messageId: request.messageId, sessionKey,
        sessionId: id, actions: new Set(['add']), continuation: true};
    }
  }
  function added(request, ctx, permit) {
    if (current !== request || !ctx.sessionId || !permit) return;
    const prior = fresh(continuous) && continuous.sessionId === ctx.sessionId ? continuous : undefined;
    continuous = {sessionId: ctx.sessionId, startedAt: prior?.startedAt ?? request.at, lastAt: now()};
  }
  function end(event = {}, ctx = {}) {
    const id = event.sessionId ?? ctx.sessionId, key = event.sessionKey ?? ctx.sessionKey;
    if (id) {
      if (continuous?.sessionId === id) continuous = undefined;
      if (current?.sessionId === id) current = undefined;
    } else if (key === sessionKey) {continuous = undefined; current = undefined;}
  }
  function blocksTool(event, ctx = {}) {
    if (ctx.sessionKey !== sessionKey || !current?.listTarget) return false;
    if (current.sessionId && ctx.sessionId && current.sessionId !== ctx.sessionId) return false;
    // Read-only inspection of either domain remains available.
    if (/^personal_reminder_(?:propose|commit|change_propose|change_commit|cancel_propose|cancel_commit)$/u.test(event.toolName)) return true;
    return event.toolName === 'automations' && !['list', 'get', 'status', 'runs'].includes(event.params?.action);
  }
  return {receive, bind, added, end, blocksTool, current: () => current};
}
