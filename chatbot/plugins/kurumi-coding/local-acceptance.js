import {randomUUID} from 'node:crypto';
import {mkdirSync, realpathSync} from 'node:fs';
import {dirname} from 'node:path';
import {isDeepStrictEqual} from 'node:util';
import {accessPolicy} from '../../packages/access-control/index.js';
import {LOCAL_CODING_AGENT, LOCAL_CODING_PROJECT, LOCAL_CODING_TOOL, localCodingPermission} from '../../packages/access-control/local-coding.js';
import {bindLocalCodingTurn} from '../../packages/host-control/local-coding.js';
import {assistantText} from '../../packages/response-core/index.js';
import {digest, fail} from './policy.js';

const MAX_LEASE_MS = 15 * 60_000;
const TURN_TIMEOUT_MS = 60_000;
const MAX_LEASES = 4;
const MAX_TURNS = 16;
const MAX_TASKS = 2;
const paramsByOp = {open: ['op'], turn: ['op', 'leaseId', 'message'], status: ['op', 'leaseId', 'taskId'], close: ['op', 'leaseId']};

export function createLocalCodingAcceptance({api, getConfig, service, catalog, trace}) {
  const leases = new Map();
  const bindings = new WeakMap();
  let stopped = false;

  function registration() {
    const config = getConfig();
    const {revision, localCodingAcceptance: enrollment} = accessPolicy(config);
    const agent = config.agents?.entries?.[LOCAL_CODING_AGENT];
    if (stopped || !service.started || config.gateway?.bind !== 'loopback' || config.gateway?.auth?.mode !== 'token'
      || config.gateway.trustedProxies?.length || config.gateway.auth.allowTailscale === true
      || (config.gateway.tailscale?.mode && config.gateway.tailscale.mode !== 'off')
      || !enrollment || Date.parse(enrollment.expiresAt) <= Date.now() || !agent
      || !isDeepStrictEqual(agent.tools?.allow, [LOCAL_CODING_TOOL])) throw fail('local_coding_disabled');
    const project = config.plugins?.entries?.['kurumi-coding']?.config?.projects?.find(row => row.id === LOCAL_CODING_PROJECT);
    if (!project || project.selfMaintenance !== true || !isDeepStrictEqual(project, api.pluginConfig.projects.find(row => row.id === project.id))
      || !catalog().backends.includes(enrollment.backend)) throw fail('local_coding_project_unavailable');
    return {config, enrollment, revision};
  }

  function assertLease(lease) {
    const current = registration();
    if (!lease || leases.get(lease.id) !== lease || lease.expiresAt <= Date.now() || current.revision !== lease.revision
      || !isDeepStrictEqual(current.enrollment, lease.enrollment)) throw fail('local_coding_lease_expired');
    return current.config;
  }

  function authorize(requester, permission) {
    const lease = leases.get(requester.leaseId);
    assertLease(lease);
    if (!isDeepStrictEqual(requester, lease.requester) || !['tasks.read', 'tasks.code'].includes(permission)) {
      throw fail('local_coding_scope_denied');
    }
  }

  function execute(ctx, signal, callId, args) {
    const turn = bindings.get(ctx.toolBindings?.[LOCAL_CODING_AGENT]);
    if (!turn?.current() || ctx.agentId !== LOCAL_CODING_AGENT || ctx.sessionId !== turn.sessionId
      || ctx.sessionKey !== turn.requester.sessionKey || !callId) throw fail('local_coding_turn_required');
    ctx.assertInvocationCurrent();
    signal?.throwIfAborted();
    const permission = localCodingPermission(LOCAL_CODING_TOOL, args);
    if (!permission) throw fail('local_coding_action_denied');
    authorize(turn.requester, permission);
    return executeAction(turn, callId, args, signal);
  }

  async function executeAction(turn, callId, args, signal) {
    const {requester, lease, runId, sessionId} = turn;
    const {action, taskId} = args;
    const entry = {action};
    try {
      let result;
      if (action === 'list') {
        result = {...catalog(), tasks: service.list(requester), writableProject: LOCAL_CODING_PROJECT, backend: lease.enrollment.backend};
        entry.projects = result.projects.map(project => project.id);
        entry.backends = result.backends;
      } else if (action === 'start') {
        if (args.projectId !== LOCAL_CODING_PROJECT || (args.backend != null && args.backend !== lease.enrollment.backend)) {
          throw fail('local_coding_project_or_backend_denied');
        }
        if (lease.tasks >= MAX_TASKS || service.list(requester).some(task => service.active.has(task.id))) {
          throw fail('local_coding_task_limit');
        }
        result = service.submit({projectId: LOCAL_CODING_PROJECT, backend: lease.enrollment.backend,
          task: args.task, title: args.title, autoPreview: false}, {requester,
          key: digest(JSON.stringify([requester.sessionKey, runId, callId])), correlation: {runId, sessionId, sessionKey: requester.sessionKey}});
        lease.tasks++;
        entry.taskId = result.id;
      } else {
        entry.taskId = taskId;
        switch (action) {
          case 'status': result = service.status(taskId, requester); break;
          case 'result': result = service.result(taskId, requester, {roundId: args.roundId, section: args.section, offset: args.offset, limit: args.limit}); break;
          case 'diff': result = service.diff(taskId, requester); break;
          case 'preview': result = await service.inspectPreview(taskId, requester, signal); break;
          case 'cancel': result = await service.cancel(taskId, requester); break;
        }
      }
      entry.status = 'ok';
      return result;
    } catch (error) {
      entry.status = 'error';
      entry.code = error.code ?? 'local_coding_action_failed';
      return {ok: false, code: entry.code};
    } finally {
      turn.actions.push(entry);
      trace({source: 'coding', kind: 'coding.acceptance_action', correlation: {runId, sessionKey: requester.sessionKey, taskId: entry.taskId},
        data: {action, status: entry.status, code: entry.code}});
    }
  }

  async function runTurn(lease, message, {hasCurrentClientAuthority, client}) {
    const config = assertLease(lease);
    if (lease.busy || lease.turns >= MAX_TURNS || typeof message !== 'string' || !message.trim() || message.length > 10_000) {
      throw fail('local_coding_turn_unavailable');
    }
    lease.busy = true;
    lease.turns++;
    const {requester} = lease, {sessionKey} = requester;
    const agent = api.runtime.agent;
    try {
      const storePath = agent.session.resolveStorePath(config.session?.store, {agentId: LOCAL_CODING_AGENT});
      return await agent.session.runWithWorkAdmission({storePath, sessionKey}, async signal => {
        assertLease(lease);
        if (!hasCurrentClientAuthority() || client.connectionSignal?.aborted) throw fail('local_coding_client_expired');
        const workspace = config.agents.entries[LOCAL_CODING_AGENT].workspace;
        const parent = dirname(workspace);
        if (realpathSync(dirname(parent)) !== dirname(parent)) throw fail('local_coding_workspace_invalid');
        for (const directory of [parent, workspace]) {
          try {mkdirSync(directory, {mode: 0o700});} catch (error) {if (error.code !== 'EEXIST') throw error;}
          if (realpathSync(directory) !== directory) throw fail('local_coding_workspace_invalid');
        }
        const sessionId = randomUUID();
        const selected = config.agents.entries[LOCAL_CODING_AGENT].model ?? config.agents.defaults?.model;
        const ref = typeof selected === 'string' ? selected : selected?.primary;
        const slash = ref?.indexOf('/') ?? -1;
        if (slash < 1 || slash === ref.length - 1) throw fail('local_coding_model_unavailable');
        const runId = randomUUID(), binding = Object.freeze({});
        const abortSignal = AbortSignal.any([signal, lease.controller.signal, AbortSignal.timeout(TURN_TIMEOUT_MS),
          ...(client.connectionSignal ? [client.connectionSignal] : [])]);
        const turn = {lease, requester, sessionId, runId, actions: [], current: () => {
          try {assertLease(lease); return !abortSignal.aborted && hasCurrentClientAuthority();} catch {return false;}
        }};
        const unbind = bindLocalCodingTurn(runId, turn);
        bindings.set(binding, turn);
        try {
          if (!turn.current()) throw fail('local_coding_client_expired');
          const prompt = lease.history.length
            ? `Conversation history (reference only):\n${JSON.stringify(lease.history)}\n\nCurrent request:\n${message}` : message;
          const result = await agent.runEmbeddedAgent({config, agentId: LOCAL_CODING_AGENT, sessionKey, sessionId, runId,
            workspaceDir: workspace, agentDir: agent.resolveAgentDir(config, LOCAL_CODING_AGENT),
            provider: ref.slice(0, slash), model: ref.slice(slash + 1), timeoutMs: TURN_TIMEOUT_MS, abortSignal,
            toolsAllow: [LOCAL_CODING_TOOL], toolExecutionAllow: [LOCAL_CODING_TOOL], toolBindings: {[LOCAL_CODING_AGENT]: binding},
            disableMessageTool: true, disableToolSearch: true, codeModeOverride: false, trigger: 'manual',
            sessionPersistence: 'detached', disableTrajectory: true, prompt, transcriptPrompt: message});
          if (!turn.current()) throw fail('local_coding_client_expired');
          const reply = assistantText(result, {maxChars: 12_000});
          lease.history = [...lease.history, {request: message.slice(0, 2000), reply: reply.slice(0, 2000)}].slice(-4);
          return {status: 'ok', runId, sessionKey, reply, actions: turn.actions};
        } finally {bindings.delete(binding); unbind();}
      });
    } finally {lease.busy = false;}
  }

  function close(lease) {
    leases.delete(lease.id);
    clearTimeout(lease.timer);
    lease.controller.abort();
  }

  function register() {
    api.registerGatewayMethod('kurumi-coding.acceptance', async request => {
      const {params, respond, client, hasCurrentClientAuthority} = request;
      try {
        // OpenClaw omits clientIp for a direct local connection. Require the loopback-only
        // server configuration as well as its authenticated, non-browser transport.
        if (!client?.connId || client.usesSharedGatewayAuth !== true || client.clientIp != null || client.internal?.syntheticClient
          || client.remoteControlUiIngress || client.browserOrigin || !hasCurrentClientAuthority?.()) {
          throw fail('local_coding_admin_required');
        }
        const {op, leaseId} = params ?? {};
        if (!Object.hasOwn(paramsByOp, op) || Object.keys(params).some(name => !paramsByOp[op].includes(name))) throw fail('local_coding_invalid_request');
        if (op === 'open') {
          const {enrollment, revision} = registration();
          if (leases.size >= MAX_LEASES) throw fail('local_coding_lease_limit');
          const id = randomUUID(), sessionKey = `agent:${LOCAL_CODING_AGENT}:coding:${id}`;
          const expiresAt = Math.min(Date.now() + MAX_LEASE_MS, Date.parse(enrollment.expiresAt));
          const lease = {id, revision, enrollment, expiresAt, turns: 0, tasks: 0, history: [], controller: new AbortController(),
            requester: {subjectId: 'local-coding:' + enrollment.id, leaseId: id, sessionKey, route: 'local-coding'}};
          lease.timer = setTimeout(() => close(lease), Math.max(1, expiresAt - Date.now())).unref();
          leases.set(id, lease);
          return respond(true, {leaseId: id, sessionKey, expiresAt});
        }
        const lease = leases.get(leaseId);
        if (op === 'close' && lease) {close(lease); return respond(true, {closed: true});}
        assertLease(lease);
        if (op === 'status') {
          const task = service.status(params.taskId, lease.requester);
          return respond(true, {taskId: task.id, state: task.state, reason: task.reason, checksPassed: task.checks?.ok,
            active: service.active.has(task.id), resultAvailable: task.delivery?.state === 'local_available'});
        }
        return respond(true, await runTurn(lease, params.message, request));
      } catch (error) {
        respond(false, undefined, {code: 'UNAVAILABLE', message: error.code ?? 'local_coding_request_failed'});
      }
    }, {scope: 'operator.admin'});
  }

  return {register, execute, authorize, start() {stopped = false;},
    stop() {stopped = true; for (const lease of leases.values()) close(lease);}};
}
