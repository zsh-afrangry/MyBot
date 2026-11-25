import {accessPolicy, toolPermission, toolPolicyDecision} from '../../packages/access-control/index.js';
import {attachHostControl} from '../../packages/host-control/index.js';
import {localCodingDecision} from '../../packages/host-control/local-coding.js';
import {confineOwnerExec} from '../../packages/host-exec/index.js';
import {createRuntimeTraceSink} from '../../packages/observability/index.js';
import {isWakeSession} from '../../packages/proactive-core/policy.js';
import {createProactiveComponent} from './proactive/index.js';

export default {id: 'kurumi-host-control', name: 'Kurumi host controls', register(api) {
  const proactive = createProactiveComponent().register(api);
  if (api.registrationMode !== undefined && api.registrationMode !== 'full') return;

  const cfg = api.config;
  const audit = createRuntimeTraceSink('access-events.jsonl', {stateRoot: api.runtime?.state?.resolveStateDir?.()});
  const control = {
    evaluate(event, ctx) {
      let result = isWakeSession(ctx)
        ? (proactive ? proactive.toolDecision(event, ctx) : {block: true, blockReason: 'wake_registration_unavailable'})
        : localCodingDecision(event, ctx) ?? toolPolicyDecision(event, ctx, cfg);
      if (!result?.block && event.toolName === 'exec') result = confineOwnerExec(event.params, api.pluginConfig?.exec);
      try {
        audit.emit({source: 'access-control', kind: 'access.tool',
          correlation: {sessionKey: ctx.sessionKey, runId: ctx.runId, toolCallId: ctx.toolCallId},
          data: {subjectId: ctx.requester?.senderId ?? 'system', requesterChannel: ctx.requester?.channel,
            requesterAccount: ctx.requester?.accountId, requesterIsOwner: ctx.requester?.senderIsOwner,
            tool: event.toolName, permission: toolPermission(event.toolName, event.params) ?? null,
            revision: accessPolicy(cfg).revision, decision: result?.block ? 'deny' : 'allow', code: result?.blockReason ?? 'allowed',
            ...(result?.scope ? {execution: result.scope} : {})}});
      } catch { /* Telemetry does not change the authorization result. */ }
      return result?.params ? {params: result.params} : result;
    },
    acceptInbound: proactive?.acceptInbound,
  };
  let detach;
  api.registerService({id: 'kurumi-host-control',
    start() { detach = attachHostControl(cfg, control); },
    stop() { detach?.(); detach = undefined; },
  });
  api.registerGatewayMethod('kurumi-host-control.status', ({respond}) => respond(true, {ready: Boolean(detach)}), {scope: 'operator.admin'});
}};
