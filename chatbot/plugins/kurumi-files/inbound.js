import {scopeFromToolContext} from '../../packages/confirmation-core/dist/index.js';
import {assertToolAccess} from '../../packages/access-control/index.js';
import {assertInteractiveLeaseContext} from '../../packages/scoped-lease/index.js';
import {fail} from './policy.js';

export function ownerFilesInvocation(ctx, config, toolName, args, signal) {
  const actor = assertToolAccess(ctx, config, toolName, args);
  const scope = scopeFromToolContext(ctx);
  if (!actor.owner || !scope) fail('files_requires_owner_chat');
  assertInteractiveLeaseContext(ctx);
  const check = () => {
    ctx.assertInvocationCurrent();
    signal?.throwIfAborted();
  };
  check();
  return {actor, scope, check, isInteractiveOwner: true};
}
