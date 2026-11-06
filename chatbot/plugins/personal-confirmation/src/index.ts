import { definePluginEntry, type OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { confirmationBackendIds, MAX_CONFIRMATION_TARGETS, recordRegisteredConfirmation } from '@kurumi/confirmation-core';
import { assertToolAccess } from '@kurumi/access-control';
import { confirmationFromDispatch } from './inbound.js';
import { createConfirmationRuntime, type ConfirmationArguments } from './runtime.js';

// Narrow host-hook compatibility surface; the installed host has these public hooks.
type HookApi = OpenClawPluginApi & {on(name: string, callback: (...args: any[]) => unknown, options?: Record<string, unknown>): void};
const parameters = {
  type: 'object', additionalProperties: false, required: ['action', 'domain'],
  properties: {
    action: {type: 'string', enum: ['list', 'preview', 'confirm']},
    domain: {type: 'string', enum: ['personal_reminder', 'personal_profile', 'planning', 'mail', 'coding'],
      description: 'Required: reminder=personal_reminder, Profile=personal_profile, trip=planning, email=mail, coding=coding (single target only). For targets use the first target domain.'},
    proposalId: {type: 'string', pattern: '^[a-fA-F0-9-]{36}$'},
    payloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
    targets: {type: 'array', minItems: 1, maxItems: MAX_CONFIRMATION_TARGETS,
      description: 'Only for explicit confirmation of a finite set. Supply the complete set in ONE call, then commit every authorized target separately.',
      items: {type: 'object', additionalProperties: false, required: ['domain', 'proposalId', 'payloadHash'], properties: {
        domain: {type: 'string', enum: ['personal_reminder', 'personal_profile', 'planning', 'mail', 'coding']},
        proposalId: {type: 'string', pattern: '^[a-fA-F0-9-]{36}$'}, payloadHash: {type: 'string', pattern: '^[a-f0-9]{64}$'},
      }}},
  },
};
const entry: ReturnType<typeof definePluginEntry> = definePluginEntry({
  id: 'personal-confirmation', name: 'Personal Confirmation',
  description: 'Current owner natural confirmation; business commits remain with their domains.',
  register(api) {
    const hooks = api as HookApi;
    const owner = api.config.channels?.['kurumi-qq']?.ownerId;
    const runtime = createConfirmationRuntime(typeof owner === 'string' ? owner : '');
    hooks.on('reply_dispatch', event => {
      runtime.receive(event);
      const inbound = confirmationFromDispatch(event);
      if (!inbound) return;
      // Existing coded confirmations remain compatible. Natural confirmation is
      // issued only by the narrow tool from its bound current request.
      recordRegisteredConfirmation(inbound, diagnostic => {
        const message = JSON.stringify({component: 'personal-confirmation', ...diagnostic});
        if (diagnostic.outcome === 'storage_error' || diagnostic.outcome === 'no_backends') api.logger.warn(message);
        else api.logger.info(message);
      });
    });
    hooks.on('before_prompt_build', runtime.prompt, {requiresToolAuthority: true});
    hooks.on('before_tool_call', runtime.beforeTool, {matcher: ['personal_confirmation', 'tool_call', 'dispatch_action']});
    hooks.on('after_tool_call', runtime.afterTool);
    hooks.on('reply_payload_sending', runtime.beforeReply);
    hooks.on('agent_end', runtime.end);
    for (const name of ['before_reset', 'session_end']) hooks.on(name, runtime.reset);
    api.registerTool({contextVersion: 2, create: ctx => ({
      name: 'personal_confirmation', label: 'Confirm a pending proposal',
      description: 'REQUIRED domain mapping: reminder=personal_reminder, Profile=personal_profile, trip=planning, email=mail, coding=coding (single target only). '
        + 'Read pending proposals with action=list. To re-display, MUST use action=preview; list is not a presentation receipt. '
        + 'Resolve the current owner confirmation to previously delivered frozen previews. '
        + 'For one use action=confirm with its real proposalId/payloadHash. For explicit multiple use ONE call with complete targets (max 16, outer domain=first target). '
        + 'Then call the matching domain commit, email_send or kurumi_code(action=merge) for EACH authorized target; report partial/unknown outcomes accurately. '
        + 'Do not require a code. Ambiguous/negative/quoted statements or a request to change the proposal need clarification/new preview. '
        + 'New proposals cannot be confirmed in the same message. Owner private chat only.',
      parameters,
      async execute(callId, args, signal) {
        const input = args as ConfirmationArguments;
        assertToolAccess(ctx, ctx.getRuntimeConfig?.() ?? api.config, 'personal_confirmation', input);
        // Preflight every target before issuing any grant. The outer domain
        // cannot lend its permission to another domain in the batch.
        for (const target of input.targets ?? []) assertToolAccess(ctx, ctx.getRuntimeConfig?.() ?? api.config,
          'personal_confirmation', {action: 'confirm', domain: target.domain});
        ctx.assertInvocationCurrent(); signal?.throwIfAborted();
        let result;
        try { result = runtime.execute(callId, input, ctx); }
        catch { result = {ok: false, code: 'confirmation_storage_unavailable'}; }
        if (input.action === 'confirm') api.logger.info(JSON.stringify({component: 'personal-confirmation',
          outcome: result.ok ? 'recorded' : 'rejected', backend: input.domain,
          ...('code' in result ? {code: result.code} : {})}));
        return {content: [{type: 'text', text: JSON.stringify(result)}], details: result};
      },
    })}, {optional: true});
    api.registerService({id: 'personal-confirmation-health', start() {
      api.logger.info(JSON.stringify({component: 'personal-confirmation', event: 'started', backends: confirmationBackendIds()}));
    }});
  },
});
export default entry;
