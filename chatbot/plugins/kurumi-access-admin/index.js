import {createRuntimeConfigReader} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import {registerConfirmationBackend} from '@kurumi/confirmation-core';
import {AccessError, SHARED_PERMISSIONS} from '../../packages/access-control/index.js';
import {CATEGORY_NAMES} from './categories.js';
import {ownerInvocation} from './inbound.js';
import {TOOL} from './policy.js';
import {createAccessAdminService} from './service.js';
import {openPolicySource, openRuntimeSource} from '../../packages/access-control/config-source.js';
import {AccessChangeStore} from './store.js';

const qq = {type: 'string', pattern: '^[0-9]{5,12}$'};
const permissions = {type: 'array', uniqueItems: true, items: {type: 'string', enum: [...SHARED_PERMISSIONS]}};
const parameters = {
  type: 'object', additionalProperties: false, required: ['action'],
  properties: {
    action: {type: 'string', enum: ['list', 'get', 'propose', 'commit', 'status']},
    category: {type: 'string', enum: CATEGORY_NAMES, description: 'Omit for the existing member operations.'},
    qq,
    key: {type: 'string', description: 'Exact entry for get on a non-member category.'},
    proposalId: {type: 'string'},
    change: {
      type: 'object', additionalProperties: false, required: ['op'],
      properties: {
        op: {type: 'string', enum: ['add', 'update', 'remove', 'replace']},
        key: {type: 'string', description: 'Exact entry to add, remove or replace in a non-member list.'},
        replacement: {type: 'string', description: 'New entry for replace.'},
        root: {type: 'string', description: 'Absolute local root for a coding_project.'},
        kind: {type: 'string', enum: ['git', 'directory'], description: 'Project kind for a coding_project.'},
        branch: {type: 'string', description: 'Existing target branch for a Git coding_project.'},
        checkProfile: {type: 'string', description: 'Operator-approved check profile ID for a coding_project.'},
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
  name: 'Kurumi allowlist administration',
  register(api) {
    const currentConfig = createRuntimeConfigReader(api.config);
    let store, execute, unregister;
    if (api.registrationMode === 'full' || api.registrationMode === undefined) {
      api.registerService({
        id: 'kurumi-access-admin',
        start() {
          const sourceRoot = api.pluginConfig?.sourceRoot;
          const stateRoot = api.runtime.state.resolveStateDir();
          const source = openPolicySource(sourceRoot);
          source.read();
          store = new AccessChangeStore(stateRoot);
          try {
            const natural = store.natural;
            unregister = registerConfirmationBackend({
              id: 'kurumi-access-admin',
              open: () => ({natural, listInboundConfirmationCandidates: () => [],
                recordInboundConfirmation: () => false, close() {}}),
            });
            execute = createAccessAdminService(source, store, {runtimeSource: openRuntimeSource(sourceRoot), sourceRoot, stateRoot});
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
      label: 'Manage owner-approved allowlists',
      description: [
        'Owner private chat. list and get distinguish repository policy from active policy.',
        'With category omitted or member, propose a single member add, update or remove. Use the precise QQ string.',
        'For add, get the owner’s selection of shared permissions and supply grant explicitly.',
        'For update, grant enables permissions and revoke removes permissions. Null clears note or expiresAt.',
        'Remove deletes the membership record, retaining its data.',
        'For enabled category mail_recipient, use key for one exact address, with replacement for replace. This does not send mail.',
        'For enabled category owner_tool, use key for one registered tool name. Business permissions and denials still apply.',
        'For enabled category exec_root, use key for one absolute directory path inside an operator-approved base. This only changes additional executable write directories.',
        'For enabled category coding_project, use the stable project ID as key. Add requires root, kind, branch for Git, and an approved checkProfile from list. Update fields of that same ID or remove it; this never runs a coding task.',
        'Show the preview and wait for a later owner confirmation through personal_confirmation with domain=access.',
        'Then call commit using the approved proposalId. This saves the repository intent.',
        'Use status with the proposalId for read-only verification. Report feedback.status (write outcome), evidence.source.status (current or superseded), and evidence.runtime.status (active, pending_sync or not_active) separately.',
        'Runtime status reflects the loaded list. A superseded source change can still be active at runtime until the following deployment.',
      ].join(' '),
      parameters,
      async execute(_callId, args, signal) {
        try {
          const config = ctx.getRuntimeConfig?.() ?? currentConfig();
          const request = ownerInvocation(ctx, config, args, signal);
          if (!execute) throw new AccessError('access_admin_unavailable');
          request.toolSurface = async projected => {
            const {createOpenClawCodingToolsAsync} = await import('openclaw/plugin-sdk/agent-harness');
            const tools = await createOpenClawCodingToolsAsync({config: projected, abortSignal: signal,
              agentId: ctx.agentId, sessionKey: ctx.sessionKey, sessionId: ctx.sessionId, workspaceDir: ctx.workspaceDir,
              toolPolicyMessageProvider: 'kurumi-qq', requesterSenderId: ctx.requesterSenderId, senderIsOwner: true});
            return tools.map(tool => tool.name);
          };
          return json(await execute(args, config, request));
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
