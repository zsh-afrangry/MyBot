import {createRuntimeConfigReader} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import {registerConfirmationBackend} from '@kurumi/confirmation-core';
import {AccessError, SHARED_PERMISSIONS} from '../../packages/access-control/index.js';
import {ownerInvocation} from './inbound.js';
import {TOOL} from './policy.js';
import {createAccessAdminService} from './service.js';
import {openPolicySource} from './source.js';
import {AccessChangeStore} from './store.js';

const qq = {type: 'string', pattern: '^[0-9]{5,12}$'};
const permissions = {type: 'array', uniqueItems: true, items: {type: 'string', enum: [...SHARED_PERMISSIONS]}};
const parameters = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: {type: 'string', enum: ['list', 'get', 'propose', 'commit', 'status']},
    qq,
    proposalId: {type: 'string'},
    change: {
      type: 'object', additionalProperties: false, required: ['op', 'qq'],
      properties: {
        op: {type: 'string', enum: ['add', 'update', 'remove']},
        qq,
        grant: {...permissions, description: 'Explicit permission set for add (required), or permissions to enable for update.'},
        revoke: {...permissions, description: 'Permissions to remove for update.'},
        enabled: {type: 'boolean'},
        note: {type: ['string', 'null'], maxLength: 500},
        expiresAt: {type: ['string', 'null'], description: 'RFC 3339 with timezone. Null removes the expiry; omit to keep it.'},
      },
    },
  },
};

const json = result => ({content: [{type: 'text', text: JSON.stringify(result)}], details: result});

export default {
  id: 'kurumi-access-admin',
  name: 'Kurumi QQ member administration',
  register(api) {
    const currentConfig = createRuntimeConfigReader(api.config);
    let store, execute, unregister;
    if (api.registrationMode === 'full' || api.registrationMode === undefined) {
      api.registerService({
        id: 'kurumi-access-admin',
        start() {
          const source = openPolicySource(api.pluginConfig?.sourceRoot);
          source.read();
          store = new AccessChangeStore(api.runtime.state.resolveStateDir());
          try {
            const natural = store.natural;
            unregister = registerConfirmationBackend({
              id: 'kurumi-access-admin',
              open: () => ({natural, listInboundConfirmationCandidates: () => [],
                recordInboundConfirmation: () => false, close() {}}),
            });
            execute = createAccessAdminService(source, store);
          } catch (error) {
            store.close();
            store = undefined;
            throw error;
          }
        },
        stop() {
          execute = undefined;
          unregister?.();
          unregister = undefined;
          store?.close();
          store = undefined;
        },
      });
    }
    api.registerTool({contextVersion: 2, create: ctx => ({
      name: TOOL,
      label: 'Manage QQ member access',
      description: [
        'Owner private chat. list and get inspect QQ members and distinguish repository policy from active policy.',
        'propose freezes a single member add, update or remove. Use the precise QQ string.',
        'For add, get the owner’s selection of shared permissions and supply grant explicitly.',
        'For update, grant enables permissions and revoke removes permissions. Null clears note or expiresAt.',
        'Remove deletes the membership record, retaining its data.',
        'Show the preview and wait for a later owner confirmation through personal_confirmation with domain=access.',
        'Then call commit using the approved proposalId. That writes the repository policy only.',
        'Use status to inspect a proposal after an interrupted response. A written change takes effect after operator deployment.',
      ].join(' '),
      parameters,
      async execute(_callId, args, signal) {
        try {
          const config = ctx.getRuntimeConfig?.() ?? currentConfig();
          const request = ownerInvocation(ctx, config, args, signal);
          if (!execute) throw new AccessError('access_admin_unavailable');
          return json(execute(args, config, request));
        } catch (error) {
          signal?.throwIfAborted();
          if (error instanceof AccessError) return json({ok: false, code: error.code});
          api.logger.warn('Access administration operation failed');
          return json({ok: false, code: 'access_admin_unavailable'});
        }
      },
    })}, {name: TOOL, optional: true});
  },
};
