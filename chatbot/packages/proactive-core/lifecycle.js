// Explicitly composed host metadata only. No chat text, history, timers, default
// production paths or tool grants. See document 25's foreground lifecycle contract.
import {error,time} from './policy.js';

export function createWakeLifecycle({authority,ownerId,activityMaxAgeMs,now=Date.now}) {
  if (typeof ownerId!=='string' || !/^[0-9]{5,12}$/.test(ownerId)
    || !Number.isSafeInteger(activityMaxAgeMs) || activityMaxAgeMs<1
    || typeof authority?.invalidate!=='function') throw error('invalid_wake_lifecycle');
  const scope='qq:user:'+ownerId,sessionKey='agent:main:kurumi-qq:direct:'+ownerId;
  function invalidate(activityAt) {
    try {return authority.invalidate(scope,activityAt===undefined?{}:{activityAt});}
    catch (e) {
      // A later-arriving older message must still preempt without rewinding the
      // newest trusted activity. No other storage failure is silently ignored.
      if (e.code!=='activity_clock_reversed') throw e;
      return authority.invalidate(scope);
    }
  }
  function sessionEnded(event={},ctx={}) {
    const key=ctx.sessionKey??event.sessionKey,agent=ctx.agentId??event.agentId;
    if (key!==sessionKey || (agent!==undefined && agent!=='main')
      || (ctx.sessionKey && event.sessionKey && ctx.sessionKey!==event.sessionKey)) return false;
    invalidate();return true;
  }
  return Object.freeze({
    // Called only after the transport's identity, durable dedupe and route checks.
    acceptInbound(event) {
      if (event?.origin!=='onebot' || event.subjectId!==ownerId || event.agentId!=='main'
        || event.sessionKey!==sessionKey || typeof event.messageId!=='string'
        || !event.messageId || event.messageId.length>1024) return false;
      const at=time(now()),occurred=event.occurredAt;
      const fresh=event.postType==='message' && Number.isSafeInteger(occurred) && occurred>=0
        && occurred<=at && at-occurred<=activityMaxAgeMs;
      invalidate(fresh?occurred:undefined);return true;
    },
    attach(api) {
      if (api.registrationMode!==undefined && api.registrationMode!=='full') return;
      for (const hook of ['before_reset','session_end']) api.on(hook,sessionEnded);
    },
  });
}
