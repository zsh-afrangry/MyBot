// Trusted host context only. Model parameters cannot select an owner, recipient, path or runId.
import {assertToolAccess, activeSubject, sessionFor} from '../../packages/access-control/index.js';
import {scopeFromToolContext} from '@kurumi/confirmation-core';
import {digest, fail} from './policy.js';
export function codingRequest(ctx, cfg, args, callId) {
  const actor = assertToolAccess(ctx, cfg, 'kurumi_code', args);
  if (!actor.owner || typeof callId !== 'string' || !callId || !ctx.sessionId) throw fail('coding_requires_trusted_owner');
  ctx.assertInvocationCurrent();
  return {requester: {subjectId: actor.id, sessionKey: actor.sessionKey, to: `user:${actor.id}`},
    key: digest(JSON.stringify([actor.sessionKey, ctx.sessionId, callId]))};
}
export function authorizeRequester(cfg, requester, permission) {
  const row = activeSubject(cfg, requester.subjectId, permission);
  if (row.role !== 'owner' || requester.sessionKey !== sessionFor(row) || requester.to !== `user:${row.qq}`) throw fail('coding_requires_trusted_owner');
  activeSubject(cfg, row.qq, 'chat.use');
}
export function confirmationScope(ctx) {
  const scope = scopeFromToolContext(ctx);
  if (!scope) throw fail('coding_confirmation_scope_required');
  return scope;
}
