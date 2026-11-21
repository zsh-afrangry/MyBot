// Disposable assembly for the same-process acceptance test. This module is not a deployed plugin.
import {createHash, randomUUID} from 'node:crypto';
import {mkdirSync} from 'node:fs';
import {join} from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {toolPolicyDecision} from '../../../packages/access-control/index.js';
import {attachHostControl} from '../../../packages/host-control/index.js';
import {checkApprovalGrant, confirmNaturalProposal, createNaturalConfirmationBackend, ensureConfirmationGateSchema,
  listNaturalConfirmations, markConfirmationProposalCommitted, prepareConfirmationPreview,
  registerConfirmationBackend, registerConfirmationProposal} from '../../../packages/confirmation-core/dist/index.js';
import {ACCEPTANCE_CONFIRMATION_CHANNEL as channel, recordScopedConfirmationDelivery,
  withScopedConfirmationBackends} from '../../../packages/confirmation-core/dist/acceptance.js';

const agentId = 'acceptance-probe';
const pluginId = 'acceptance-scope-probe';
const toolName = 'acceptance_scope_record';
const domain = 'scope_fixture';
const previewText = 'Scope fixture: create one local record';
const actions = {read: '查看测试记录', preview: '先给我预览，再等我确认', confirm: '确认', 'early-confirm': '确认这条尚未投递的预览'};
const now = () => Math.floor(Date.now() / 1000);

function createLane(root, name) {
  const subject = randomUUID(), sessionKey = `agent:${agentId}:scenario:${subject}`;
  const receiptsKey = 'inbox:' + subject;
  const db = new DatabaseSync(join(root, name + '.sqlite'));
  ensureConfirmationGateSchema(db);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE jobs (proposal_id TEXT PRIMARY KEY, subject TEXT, session_key TEXT, destination TEXT, status TEXT);
    CREATE TABLE inbox (id TEXT PRIMARY KEY, kind TEXT, source_id TEXT, destination TEXT);
  `);
  const receipt = (kind, sourceId) => {
    const id = randomUUID();
    db.prepare('INSERT INTO inbox VALUES (?,?,?,?)').run(id, kind, sourceId, receiptsKey);
    return id;
  };
  const natural = createNaturalConfirmationBackend(db, {subjectId: subject, domains: [domain], now});
  const provider = {id: 'scope-' + subject, open: () => ({natural, listInboundConfirmationCandidates: () => [],
    recordInboundConfirmation: () => false, close() {}})};
  const rows = turn => listNaturalConfirmations(turn.event);

  return {subject, sessionKey, db, receipt, provider,
    deliver(turn, text) {
      if (!text || (turn.proposalId && !text.includes(previewText))) return false;
      const id = receipt('reply', turn.messageId);
      recordScopedConfirmationDelivery(turn.event, {messageId: id, text});
      return true;
    },
    execute(turn, action) {
      if (action === 'read') return {ok: true, pending: rows(turn).length};
      if (action === 'preview') {
        const proposalId = randomUUID();
        const at = now();
        const payloadHash = createHash('sha256').update(previewText).digest('hex');
        registerConfirmationProposal(db, {proposalId, domain, actionKind: 'record.create', subjectId: subject, scope: turn.scope,
          payloadHash, createdAtUtc: at, expiresAtUtc: at + 60});
        if (!prepareConfirmationPreview(turn.event, {domain, proposalId, payloadHash}, previewText)) throw Error('fixture_preview_failed');
        turn.proposalId = proposalId;
        return {ok: true, previewText};
      }
      if (action !== 'confirm') return {ok: false, code: 'confirmation_expected'};
      const [proposal, ...other] = rows(turn);
      if (!proposal || other.length) return {ok: false, code: 'preview_unavailable'};
      const approved = confirmNaturalProposal(turn.event, proposal);
      if (!approved.ok) return approved;
      db.exec('BEGIN IMMEDIATE');
      try {
        const at = now();
        if (!checkApprovalGrant(db, {...proposal, scope: turn.scope, nowUtc: at, consume: true}).ok) throw Error('fixture_grant_failed');
        db.prepare("INSERT INTO jobs VALUES (?,?,?,?,'queued')").run(proposal.proposalId, subject, sessionKey, receiptsKey);
        markConfirmationProposalCommitted(db, {proposalId: proposal.proposalId, subjectId: subject, atUtc: at});
        db.exec('COMMIT');
        return {ok: true, queued: true};
      } catch (error) {db.exec('ROLLBACK'); throw error;}
    },
    runBackground() {
      const work = db.prepare("SELECT * FROM jobs WHERE status='queued'").all();
      for (const job of work) {
        const status = job.subject === subject && job.session_key === sessionKey && job.destination === receiptsKey
          ? 'delivered' : 'scope_rejected';
        db.exec('BEGIN IMMEDIATE');
        try {
          if (status === 'delivered') receipt('background', job.proposal_id);
          db.prepare('UPDATE jobs SET status=? WHERE proposal_id=?').run(status, job.proposal_id);
          db.exec('COMMIT');
        } catch (error) {db.exec('ROLLBACK'); throw error;}
      }
    },
  };
}

export function buildScopeFixture({root}) {
  return {id: pluginId, register(api) {
    const cfg = api.config;
    const turns = new Map(), toolCalls = new Map(), lanes = new Map(), busy = new Set(), decisions = [];
    let detach, unregister, timer, workerFailed = false, unscopedBackendOpens = 0;
    const isScopeRoute = ctx => ctx.agentId === agentId || ctx.sessionKey?.startsWith(`agent:${agentId}:`);
    const key = (ctx, id) => JSON.stringify([ctx.sessionKey, ctx.sessionId, id]);
    const match = ctx => {
      const turn = turns.get(ctx.runId), requester = ctx.requester;
      if (!turn || ctx.agentId !== agentId || ctx.sessionKey !== turn.lane.sessionKey || ctx.sessionId !== turn.sessionId
        || requester?.senderIsOwner === true
        || (requester?.senderId != null && requester.senderId !== turn.lane.subject)
        || (requester?.channel != null && requester.channel !== channel)) return undefined;
      return turn;
    };
    api.registerService({id: pluginId, start() {
      if (api.runtime.state.resolveStateDir() !== root) throw Error('Unexpected fixture state directory');
      const state = join(root, 'acceptance'); mkdirSync(state, {mode: 0o700});
      for (const name of ['a', 'b']) lanes.set(name, createLane(state, name));
      unregister = registerConfirmationBackend({id: 'scope-global-sentinel', open() {
        unscopedBackendOpens++;
        throw Error('Global confirmation storage must not open for a scoped request');
      }});
      // Exercise the real mandatory QQ tool boundary. Its trusted binding uses
      // the regular QQ decision for normal calls and a narrow test-run branch.
      detach = attachHostControl(cfg, {evaluate(event, ctx) {
        if (!isScopeRoute(ctx)) return toolPolicyDecision(event, ctx, cfg);
        const allowed = event.toolName === toolName && Boolean(match(ctx));
        decisions.push({allowed, tool: event.toolName});
        if (!allowed) return {block: true, blockReason: 'fixture_scope_required'};
      }});
      timer = setInterval(() => {
        try {for (const lane of lanes.values()) if (!busy.has(lane)) lane.runBackground();}
        catch {workerFailed = true; clearInterval(timer);}
      }, 50);
    }, stop() {
      clearInterval(timer); detach?.(); unregister?.(); turns.clear(); toolCalls.clear();
      for (const lane of lanes.values()) lane.db.close();
    }});
    api.on('before_tool_call', (event, ctx) => {
      const turn = match(ctx);
      if (turn) toolCalls.set(key(ctx, ctx.toolCallId ?? event.toolCallId), turn);
    }, {matcher: [toolName]});
    api.on('after_tool_call', (event, ctx) => toolCalls.delete(key(ctx, ctx.toolCallId ?? event.toolCallId)), {matcher: [toolName]});
    api.registerTool({contextVersion: 2, create: ctx => {
      if (ctx.agentId !== agentId || !isScopeRoute(ctx)) return null;
      return {name: toolName, label: 'Acceptance fixture record', description: 'Work only on an isolated fixture record.',
        parameters: {type: 'object', properties: {action: {type: 'string', enum: ['read', 'preview', 'confirm']}},
          required: ['action'], additionalProperties: false},
        async execute(callId, args, signal) {
          ctx.assertInvocationCurrent(); signal?.throwIfAborted();
          const turn = toolCalls.get(key(ctx, callId));
          if (!turn || turns.get(turn.runId) !== turn || ctx.toolBindings?.[channel] !== turn.binding
            || Object.keys(args).some(k => k !== 'action')) throw Error('fixture_tool_not_bound');
          const value = turn.lane.execute(turn, args.action);
          turn.toolResult = value;
          return {content: [{type: 'text', text: JSON.stringify(value)}]};
        }};
    }}, {name: toolName, optional: true});
    api.registerGatewayMethod(pluginId + '.turn', async ({params, respond, hasCurrentClientAuthority}) => {
      const lane = lanes.get(params?.lane), text = Object.hasOwn(actions, params?.step) ? actions[params.step] : undefined;
      if (!lane || !text || Object.keys(params).some(k => !['lane', 'step', 'mode'].includes(k)) ||
        ![undefined, 'drop-receipt', 'no-lease'].includes(params.mode) || busy.has(lane) || !hasCurrentClientAuthority?.()) {
        respond(false, undefined, {code: 'INVALID_REQUEST', message: 'Invalid fixture admission'}); return;
      }
      const start = decisions.length, agent = api.runtime.agent;
      const storePath = agent.session.resolveStorePath(cfg.session?.store, {agentId});
      busy.add(lane);
      try {
        const evidence = await agent.session.runWithWorkAdmission({storePath, sessionKey: lane.sessionKey}, async signal => {
          if (!hasCurrentClientAuthority()) throw Error('Fixture admission expired');
          let entry = await agent.session.getSessionEntryAsync({storePath, sessionKey: lane.sessionKey, readConsistency: 'latest'});
          if (!entry?.sessionId) {
            await agent.session.upsertSessionEntry({storePath, sessionKey: lane.sessionKey, entry: {sessionId: randomUUID(), updatedAt: Date.now()}});
            entry = await agent.session.getSessionEntryAsync({storePath, sessionKey: lane.sessionKey, readConsistency: 'latest'});
          }
          if (!entry?.sessionId) throw Error('Fixture session missing');
          const runId = randomUUID(), messageId = randomUUID();
          return withScopedConfirmationBackends({event: {channel, senderId: lane.subject, accountId: lane.subject,
            conversationId: 'inbox:' + lane.subject, sessionKey: lane.sessionKey, messageId, timestamp: Date.now(),
            content: text, senderIsOwner: false, isGroup: false}, providers: [lane.provider]}, async (event, scope) => {
            const turn = {runId, lane, event, scope, sessionId: entry.sessionId, messageId, binding: Object.freeze({})};
            if (params.mode !== 'no-lease') turns.set(runId, turn);
            try {
              const result = await agent.runEmbeddedAgent({config: cfg, agentId, sessionKey: lane.sessionKey, sessionId: entry.sessionId, runId,
                workspaceDir: agent.resolveAgentWorkspaceDir(cfg, agentId), agentDir: agent.resolveAgentDir(cfg, agentId),
                provider: 'fixture', model: 'fixture', timeoutMs: 10000, abortSignal: signal,
                messageChannel: channel, messageProvider: channel, chatType: 'direct', senderId: lane.subject, senderIsOwner: false,
                toolBindings: {[channel]: turn.binding},
                toolsAllow: [toolName], toolExecutionAllow: [toolName], disableMessageTool: true, disableToolSearch: true, codeModeOverride: false,
                trigger: 'manual', inputProvenance: {kind: 'internal_system', sourceTool: channel},
                prompt: 'SCOPE_STEP=' + params.step + '\n' + text, transcriptPrompt: 'SCOPE_STEP=' + params.step + '\n' + text});
              if (result.meta?.error || result.meta?.aborted) throw Error('Fixture model failed');
              const reply = (result.payloads ?? []).filter(p => !p.isError && !p.isReasoning && !p.isCommentary).map(p => p.text ?? '').join('\n');
              const delivered = params.mode === undefined && lane.deliver(turn, reply);
              return {toolResult: turn.toolResult, delivered, sessionKey: lane.sessionKey, sessionId: turn.sessionId};
            } finally {
              turns.delete(runId);
              for (const [id, value] of toolCalls) if (value === turn) toolCalls.delete(id);
            }
          });
        });
        respond(true, {...evidence, decisions: decisions.slice(start), active: turns.size, workerFailed, unscopedBackendOpens, pid: process.pid});
      } catch (error) {
        respond(false, undefined, {code: 'UNAVAILABLE', message: String(error.message).slice(0, 120)});
      } finally {busy.delete(lane);}
    }, {scope: 'operator.admin'});
  }};
}
