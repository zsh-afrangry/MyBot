import {createRuntimeConfigReader} from 'openclaw/plugin-sdk/runtime-config-snapshot';
import {AccessError} from '../../packages/access-control/index.js';
import {registerConfirmationBackend} from '../../packages/confirmation-core/dist/index.js';
import {createRuntimeTraceSink} from '../../packages/observability/index.js';
import {createToolTrace} from '../../packages/observability/tool-trace.js';
import {OfficeReaderError} from '../../packages/office-reader/index.js';
import {
  ELIGIBLE_LEASE_ACTIONS,
  LEASE_TOOL,
  ScopedLeaseError,
  ScopedLeaseStore,
} from '../../packages/scoped-lease/index.js';
import {ownerFilesInvocation} from './inbound.js';
import {FILES_TOOL, FilesError, validateFilesConfig} from './policy.js';
import {createFilesService, createLeaseService} from './service.js';
import {FilesStore} from './store.js';

const UUID_PATTERN = '^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$';
const SHA256_PATTERN = '^[a-f0-9]{64}$';

const OPERATION_ENUM = [
  'batch_delete',
  'batch_move',
  'batch_copy',
  'cleanup_dir',
  't2_write',
  't2_edit',
  't2_delete',
  't2_move',
  'write',
  'edit',
  'delete',
  'move',
  'copy',
  'restore',
  'mkdir',
];

const filesParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {
      type: 'string',
      enum: [
        'roots', 'list', 'stat', 'read', 'read_structured', 'search', 'snapshots', 'status',
        'mkdir', 'write', 'edit', 'copy', 'move', 'delete', 'restore',
        'propose', 'commit', 'apply_leased',
      ],
    },
    operation: {type: 'string', enum: OPERATION_ENUM},
    format: {type: 'string', enum: ['auto', 'csv', 'tsv', 'xlsx', 'docx']},
    sheet: {type: 'string', maxLength: 128},
    path: {type: 'string', maxLength: 4096},
    sourcePath: {type: 'string', maxLength: 4096},
    targetPath: {type: 'string', maxLength: 4096},
    paths: {type: 'array', maxItems: 500, items: {type: 'string', maxLength: 4096}},
    items: {
      type: 'array',
      maxItems: 500,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourcePath', 'targetPath'],
        properties: {
          sourcePath: {type: 'string', maxLength: 4096},
          targetPath: {type: 'string', maxLength: 4096},
          overwrite: {type: 'boolean'},
        },
      },
    },
    content: {type: 'string'},
    mode: {type: 'string', enum: ['create', 'overwrite', 'append']},
    oldText: {type: 'string'},
    newText: {type: 'string'},
    replaceAll: {type: 'boolean'},
    overwrite: {type: 'boolean'},
    recursive: {type: 'boolean'},
    expectedSha256: {type: 'string', pattern: SHA256_PATTERN},
    offset: {type: 'integer', minimum: 0},
    limit: {type: 'integer', minimum: 1, maximum: 200000},
    maxEntries: {type: 'integer', minimum: 1, maximum: 500},
    maxResults: {type: 'integer', minimum: 1, maximum: 100},
    pattern: {type: 'string', maxLength: 256},
    query: {type: 'string', maxLength: 512},
    pathPrefix: {type: 'string', maxLength: 4096},
    includeRoot: {type: 'boolean'},
    allowOversizeSkip: {type: 'boolean'},
    snapshotId: {type: 'string', pattern: UUID_PATTERN},
    proposalId: {type: 'string', pattern: UUID_PATTERN},
    leaseId: {type: 'string', pattern: UUID_PATTERN},
  },
};

const leaseParameters = {
  type: 'object',
  additionalProperties: false,
  required: ['action'],
  properties: {
    action: {type: 'string', enum: ['list', 'status', 'propose', 'commit', 'revoke', 'revoke_all']},
    label: {type: 'string', minLength: 1, maxLength: 80},
    actions: {type: 'array', minItems: 1, maxItems: 16, items: {type: 'string', enum: ELIGIBLE_LEASE_ACTIONS}},
    roots: {type: 'array', minItems: 1, maxItems: 16, items: {type: 'string', maxLength: 4096}},
    maxOps: {type: 'integer', minimum: 1, maximum: 200},
    maxBytes: {type: 'integer', minimum: 1024, maximum: 268435456},
    ttlSeconds: {type: 'integer', minimum: 60, maximum: 14400},
    leaseId: {type: 'string', pattern: UUID_PATTERN},
    proposalId: {type: 'string', pattern: UUID_PATTERN},
    includeInactive: {type: 'boolean'},
    limit: {type: 'integer', minimum: 1, maximum: 100},
    reason: {type: 'string', maxLength: 120},
  },
};

const json = result => ({content: [{type: 'text', text: JSON.stringify(result)}], details: result});

function handleKnownError(error, signal, fallbackCode, api, logLabel) {
  signal?.throwIfAborted();
  if (error instanceof FilesError || error instanceof ScopedLeaseError || error instanceof AccessError || error instanceof OfficeReaderError) {
    return json({ok: false, code: error.code});
  }
  api.logger?.warn?.(logLabel);
  return json({ok: false, code: fallbackCode});
}

export function createFilesPlugin(dependencies = {}) {
  return {
    id: 'kurumi-files',
    name: 'Kurumi tiered file management',
    register(api) {
      const full = api.registrationMode === undefined || api.registrationMode === 'full';
      const currentConfig = createRuntimeConfigReader(api.config);
      const toolTrace = createToolTrace([FILES_TOOL, LEASE_TOOL]);
      if (typeof api.on === 'function') toolTrace.attach(api);

      let filesStore, leaseStore, executeFiles, executeLease, unregisterFiles, unregisterLease;

      if (full) {
        api.registerService({
          id: 'kurumi-files',
          start() {
            const stateRoot = api.runtime.state.resolveStateDir();
            const readPluginCfg = () => currentConfig().plugins?.entries?.['kurumi-files']?.config ?? api.pluginConfig;
            const cfg = validateFilesConfig(readPluginCfg(), {
              stateRoot,
              verifyRoots: dependencies.verifyRoots !== false,
            });
            const trace = dependencies.trace ?? createRuntimeTraceSink('trace-events.jsonl', {stateRoot}).emit;
            filesStore = new FilesStore(stateRoot, () => validateFilesConfig(readPluginCfg(), {
              stateRoot,
              verifyRoots: dependencies.verifyRoots !== false,
            }));
            try {
              leaseStore = new ScopedLeaseStore(stateRoot);
              const filesNatural = filesStore.natural;
              const leaseNatural = leaseStore.natural;
              unregisterFiles = registerConfirmationBackend({
                id: 'kurumi-files',
                open: () => ({
                  natural: filesNatural,
                  listInboundConfirmationCandidates: () => [],
                  recordInboundConfirmation: () => false,
                  close() {},
                }),
              });
              unregisterLease = registerConfirmationBackend({
                id: 'kurumi-scoped-lease',
                open: () => ({
                  natural: leaseNatural,
                  listInboundConfirmationCandidates: () => [],
                  recordInboundConfirmation: () => false,
                  close() {},
                }),
              });
              executeFiles = createFilesService(() => readPluginCfg() ?? cfg, filesStore, leaseStore, {
                stateRoot,
                trace,
                verifyRoots: dependencies.verifyRoots !== false,
              });
              executeLease = createLeaseService(() => readPluginCfg() ?? cfg, leaseStore, {
                stateRoot,
                trace,
                verifyRoots: dependencies.verifyRoots !== false,
              });
            } catch (error) {
              unregisterLease?.();
              unregisterLease = undefined;
              unregisterFiles?.();
              unregisterFiles = undefined;
              leaseStore?.close();
              leaseStore = undefined;
              filesStore.close();
              filesStore = undefined;
              throw error;
            }
          },
          stop() {
            executeFiles = undefined;
            executeLease = undefined;
            const releaseLease = unregisterLease;
            const releaseFiles = unregisterFiles;
            unregisterLease = undefined;
            unregisterFiles = undefined;
            releaseLease?.();
            releaseFiles?.();
            const activeLease = leaseStore;
            const activeFiles = filesStore;
            leaseStore = undefined;
            filesStore = undefined;
            activeLease?.close();
            activeFiles?.close();
          },
        });
      }

      api.registerTool({
        contextVersion: 2,
        create: ctx => ({
          name: FILES_TOOL,
          label: 'Tiered owner file management',
          description: [
            'Owner private chat only. Manages files across operator-configured T0/T1/T2 tiers while strictly blocking T3 redlines and symlink escapes.',
            'T0/T1 single-file overwrite/edit/delete automatically snapshot the prior file first (restore accepts snapshotId from snapshots/mutation responses).',
            'Batch delete/move/copy, cleanup_dir, and writable-T2 writes require propose + owner confirmation (personal_confirmation domain=host_files) + commit, or an active leaseId via apply_leased.',
          ].join(' '),
          parameters: filesParameters,
          async execute(callId, args, signal) {
            try {
              const config = ctx.getRuntimeConfig?.() ?? currentConfig();
              const request = ownerFilesInvocation(ctx, config, FILES_TOOL, args, signal);
              if (!executeFiles) throw new FilesError('files_unavailable');
              const runId = toolTrace.resolve(ctx, callId, FILES_TOOL);
              request.correlation = {
                sessionId: ctx.sessionId,
                sessionKey: ctx.sessionKey,
                toolCallId: callId,
                ...(runId ? {runId} : {}),
              };
              return json(await executeFiles(args, config, request));
            } catch (error) {
              return handleKnownError(error, signal, 'files_unavailable', api, 'File operation failed');
            }
          },
        }),
      }, {name: FILES_TOOL, optional: true});

      api.registerTool({
        contextVersion: 2,
        create: ctx => ({
          name: LEASE_TOOL,
          label: 'Bounded task leases for interactive owner workflows',
          description: [
            'Owner private chat only. Creates, commits, lists, inspects, and revokes bounded task leases (domain=scoped_lease).',
            'Leases are restricted to eligible actions on approved non-readonly directories with strict op/byte quotas and TTL, and are never inherited by Cron or proactive wake sessions.',
          ].join(' '),
          parameters: leaseParameters,
          async execute(callId, args, signal) {
            try {
              const config = ctx.getRuntimeConfig?.() ?? currentConfig();
              const request = ownerFilesInvocation(ctx, config, LEASE_TOOL, args, signal);
              if (!executeLease) throw new ScopedLeaseError('lease_unavailable');
              const runId = toolTrace.resolve(ctx, callId, LEASE_TOOL);
              request.correlation = {
                sessionId: ctx.sessionId,
                sessionKey: ctx.sessionKey,
                toolCallId: callId,
                ...(runId ? {runId} : {}),
              };
              return json(await executeLease(args, config, request));
            } catch (error) {
              return handleKnownError(error, signal, 'lease_unavailable', api, 'Scoped lease operation failed');
            }
          },
        }),
      }, {name: LEASE_TOOL, optional: true});
    },
  };
}

export default createFilesPlugin();
