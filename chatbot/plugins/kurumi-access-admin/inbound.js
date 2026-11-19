import {scopeFromToolContext} from '@kurumi/confirmation-core';
import {AccessError, assertToolAccess} from '../../packages/access-control/index.js';
import {TOOL} from './policy.js';

export function ownerInvocation(ctx, config, args, signal) {
  const actor = assertToolAccess(ctx, config, TOOL, args);
  const scope = scopeFromToolContext(ctx);
  if (!actor.owner || !scope || ctx.agentId !== 'main' || !ctx.sessionId) {
    throw new AccessError('access_admin_requires_owner_chat');
  }
  const check = () => {
    ctx.assertInvocationCurrent();
    signal?.throwIfAborted();
  };
  check();
  return {actor, scope, check};
}
