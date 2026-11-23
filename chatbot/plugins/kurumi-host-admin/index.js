import {createRuntimeConfigReader} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import {registerConfirmationBackend} from '@kurumi/confirmation-core';
import {AccessError} from '../../packages/access-control/index.js';
import {createRuntimeTraceSink} from '../../packages/observability/index.js';
import {createToolTrace} from '../../packages/observability/tool-trace.js';
import {ownerInvocation} from './inbound.js';
import {HostAdminError, TOOL, validateHostAdminConfig} from './policy.js';
import {createHostAdminService} from './service.js';
import {HostAdminStore} from './store.js';
import {createProcessRunner, validateTemplateTarget} from './templates.js';

const parameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {type: 'string', enum: ['list', 'propose', 'commit', 'status']},
    actionId: {type: 'string', pattern: '^[a-z][a-z0-9_.-]{0,63}$'},
    proposalId: {type: 'string', pattern: '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$'},
  },
};

const json = result => ({content: [{type: 'text', text: JSON.stringify(result)}], details: result});

export function createHostAdminPlugin(dependencies = {}) {
  return {
    id: 'kurumi-host-admin',
    name: 'Kurumi host administration',
    register(api) {
      const full = api.registrationMode === undefined || api.registrationMode === 'full';
      const currentConfig = createRuntimeConfigReader(api.config);
      const toolTrace = createToolTrace([TOOL]);
      if (typeof api.on === 'function') toolTrace.attach(api);

      let store, execute, unregister;
      if (full) {
        api.registerService({
          id: 'kurumi-host-admin',
          start() {
            const readPluginCfg = () => currentConfig().plugins?.entries?.['kurumi-host-admin']?.config ?? api.pluginConfig;
            const cfg = validateHostAdminConfig(readPluginCfg(), validateTemplateTarget, {
              verifyExecutables: dependencies.verifyExecutables !== false,
            });
            const stateRoot = api.runtime.state.resolveStateDir();
            const trace = dependencies.trace ?? createRuntimeTraceSink('trace-events.jsonl', {stateRoot}).emit;
            const runner = dependencies.runner ?? createProcessRunner({timeoutMs: cfg.timeoutMs});
            store = new HostAdminStore(stateRoot);
            try {
              const natural = store.natural;
              unregister = registerConfirmationBackend({
                id: 'kurumi-host-admin',
                open: () => ({
                  natural,
                  listInboundConfirmationCandidates: () => [],
                  recordInboundConfirmation: () => false,
                  close() {},
                }),
              });
              execute = createHostAdminService(readPluginCfg, store, {
                runner,
                trace,
                verifyExecutables: dependencies.verifyExecutables !== false,
              });
            } catch (error) {
              unregister?.();
              unregister = undefined;
              store.close();
              store = undefined;
              throw error;
            }
          },
          stop() {
            execute = undefined;
            const release = unregister;
            unregister = undefined;
            release?.();
            const activeStore = store;
            store = undefined;
            activeStore?.close();
          },
        });
      }

      api.registerTool({
        contextVersion: 2,
        create: ctx => ({
          name: TOOL,
          label: 'Execute owner-confirmed declarative host operations',
          description: [
            'Owner private chat only. Declarative allowlisted host operations; arbitrary commands or arguments are never accepted.',
            'list returns configured action IDs, targets, leaseEligible flags and recent operation history.',
            'propose requires one registered actionId, inspects current state, freezes the proposal and returns short human-readable presentationFacts.',
            'Show the preview and wait for a later owner confirmation through personal_confirmation with domain=host_sudo.',
            'commit requires the authorized proposalId, consumes the one-time approval BEFORE execution, runs the fixed template and verifies post-state.',
            'status checks a proposalId read-only, including beforeState, afterState and current live inspect state.',
          ].join(' '),
          parameters,
          async execute(callId, args, signal) {
            try {
              const config = ctx.getRuntimeConfig?.() ?? currentConfig();
              const request = ownerInvocation(ctx, config, args, signal);
              if (!execute) throw new HostAdminError('host_admin_unavailable');
              const runId = toolTrace.resolve(ctx, callId, TOOL);
              request.correlation = {
                sessionId: ctx.sessionId,
                sessionKey: ctx.sessionKey,
                toolCallId: callId,
                ...(runId ? {runId} : {}),
              };
              return json(await execute(args, config, request));
            } catch (error) {
              signal?.throwIfAborted();
              if (error instanceof HostAdminError || error instanceof AccessError) return json({ok: false, code: error.code});
              api.logger?.warn?.('Host administration operation failed');
              return json({ok: false, code: 'host_admin_unavailable'});
            }
          },
        }),
      }, {name: TOOL, optional: true});
    },
  };
}

export default createHostAdminPlugin();
