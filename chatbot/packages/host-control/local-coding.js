import {LOCAL_CODING_AGENT, localCodingPermission} from '../access-control/local-coding.js';

const key = Symbol.for('kurumi.local-coding.turns.v1');
const turns = globalThis[key] ??= new Map();

export function bindLocalCodingTurn(runId, turn) {
  if (turns.has(runId)) throw Error('local_coding_duplicate_run');
  turns.set(runId, turn);
  return () => turns.delete(runId);
}

export function localCodingDecision(event, ctx) {
  if (ctx.agentId !== LOCAL_CODING_AGENT && !ctx.sessionKey?.startsWith(`agent:${LOCAL_CODING_AGENT}:`)) return undefined;
  const turn = turns.get(ctx.runId);
  if (ctx.agentId !== LOCAL_CODING_AGENT || !turn || ctx.sessionKey !== turn.sessionKey
    || (ctx.sessionId != null && ctx.sessionId !== turn.sessionId) || !turn.current()) {
    return {block: true, blockReason: 'local_coding_turn_required'};
  }
  if (!localCodingPermission(event.toolName, event.params)) return {block: true, blockReason: 'local_coding_action_denied'};
  return {scope: 'local-coding-acceptance'};
}
