import {randomUUID} from 'node:crypto';
import {businessFeedback} from '../../packages/feedback-core/index.js';
import {
  DOMAIN, HostAdminError, actionIdPattern, assertFields, buildActionPreview, fail,
  proposalIdPattern, sha256, validateHostAdminConfig,
} from './policy.js';
import {createProcessRunner, getTemplate, validateTemplateTarget} from './templates.js';

const ACTIONS = Object.freeze({
  list: ['action'],
  propose: ['action', 'actionId'],
  commit: ['action', 'proposalId'],
  status: ['action', 'proposalId'],
});

function actionSummary(action) {
  return {
    id: action.id,
    template: action.template,
    target: action.target,
    label: action.label,
    impact: action.impact,
    leaseEligible: action.leaseEligible,
  };
}

function makeFeedback(plan, status, extra = {}) {
  return businessFeedback('host_admin.' + plan.template, status, {
    proposalId: extra.proposalId,
    actionId: plan.actionId,
    template: plan.template,
    target: plan.target,
    leaseEligible: plan.leaseEligible,
    beforeState: plan.beforeState,
    ...(extra.afterState !== undefined ? {afterState: extra.afterState} : {}),
    ...(extra.verification ? {verification: extra.verification} : {}),
    ...(extra.code ? {code: extra.code} : {}),
  });
}

export function createHostAdminService(rawConfig, store, {runner, trace, verifyExecutables = true} = {}) {
  const inflight = new Set();
  const resolveConfig = () => {
    const raw = typeof rawConfig === 'function' ? rawConfig() : rawConfig;
    return validateHostAdminConfig(raw, validateTemplateTarget, {verifyExecutables});
  };
  const commandSpecHashFor = (action, cfg, template) => sha256(JSON.stringify(template.commandSpec(action, cfg)));

  const assertActionMatchesPlan = (cfg, plan) => {
    const action = cfg.byId.get(plan.actionId);
    if (!action || action.template !== plan.template || action.target !== plan.target) {
      fail('host_admin_action_changed');
    }
    const template = getTemplate(action.template);
    if (!template || commandSpecHashFor(action, cfg, template) !== plan.commandSpecHash) {
      fail('host_admin_action_changed');
    }
    return {action, template};
  };

  return async function execute(args, _config, {actor, scope, check, correlation = {}}) {
    assertFields(args, typeof args?.action === 'string' && Object.hasOwn(ACTIONS, args.action) ? ACTIONS[args.action] : []);
    const cfg = resolveConfig();
    const execRunner = runner ?? createProcessRunner({timeoutMs: cfg.timeoutMs});

    switch (args.action) {
      case 'list':
        return {
          ok: true,
          actions: cfg.actions.map(actionSummary),
          recent: store.listRecent(actor.id, 10),
        };

      case 'propose': {
        if (typeof args.actionId !== 'string' || !actionIdPattern.test(args.actionId)) {
          fail('invalid_host_admin_action_id');
        }
        const action = cfg.byId.get(args.actionId);
        if (!action) fail('unknown_host_admin_action_id');
        const template = getTemplate(action.template);
        if (!template) fail('unknown_host_admin_template');

        const beforeState = await template.inspect(action, cfg, execRunner);
        check();
        const proposalId = randomUUID();
        const plan = {
          actionId: action.id,
          template: action.template,
          target: action.target,
          label: action.label,
          impact: action.impact,
          leaseEligible: action.leaseEligible,
          commandSpecHash: commandSpecHashFor(action, cfg, template),
          beforeState,
        };
        const proposal = store.propose(plan, actor.id, scope, proposalId, cfg.proposalTtlSeconds);
        const {previewText, presentationFacts} = buildActionPreview(action, beforeState);
        try {
          trace?.({
            source: 'host-admin',
            kind: 'host_admin.proposed',
            correlation: {...correlation, subjectId: actor.id, proposalId: proposal.proposalId, payloadHash: proposal.payloadHash},
            data: {
              actionId: action.id,
              template: action.template,
              target: action.target,
              leaseEligible: action.leaseEligible,
              beforeState,
            },
          });
        } catch { /* Telemetry does not alter proposal outcome. */ }
        return {
          ok: true,
          status: 'pending',
          ...proposal,
          actionId: action.id,
          template: action.template,
          target: action.target,
          leaseEligible: action.leaseEligible,
          beforeState,
          previewText,
          presentationFacts,
        };
      }

      case 'commit': {
        if (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId)) {
          fail('invalid_proposal_id');
        }
        const id = args.proposalId;
        if (inflight.has(id)) fail('host_admin_already_submitted');
        const row = store.get(id, actor.id);
        if (row.state === 'expired') fail('host_admin_proposal_expired');
        if (row.state !== 'pending') fail('host_admin_already_submitted');

        const {action, template} = assertActionMatchesPlan(cfg, row.plan);
        const spec = template.commandSpec(action, cfg);
        check();

        inflight.add(id);
        try {
          const claimed = store.claim(id, actor.id, scope, currentPlan => {
            assertActionMatchesPlan(resolveConfig(), currentPlan);
            check();
          });

          let execResult = null;
          let afterState = null;
          let outcome;
          try {
            execResult = await execRunner.run(spec);
            afterState = await template.inspect(action, cfg, execRunner);
            outcome = template.verifyOutcome(claimed.plan.beforeState, afterState, execResult);
          } catch {
            outcome = {
              state: 'unknown',
              code: 'host_admin_exec_unknown',
              verification: {executed: Boolean(execResult?.ok)},
            };
          }

          const execSummary = {
            verification: outcome.verification,
            exitCode: execResult?.exitCode ?? null,
            signal: execResult?.signal ?? null,
            timedOut: Boolean(execResult?.timedOut),
          };
          store.finish(id, actor.id, {
            state: outcome.state,
            code: outcome.code,
            afterState,
            execSummary,
          });

          try {
            trace?.({
              source: 'host-admin',
              kind: 'host_admin.executed',
              correlation: {...correlation, subjectId: actor.id, proposalId: id, payloadHash: claimed.hash},
              data: {
                actionId: action.id,
                template: action.template,
                target: action.target,
                leaseEligible: action.leaseEligible,
                status: outcome.state,
                ...(outcome.code ? {code: outcome.code} : {}),
                beforeState: claimed.plan.beforeState,
                afterState,
                verification: outcome.verification,
              },
            });
          } catch { /* Telemetry does not alter execution outcome. */ }

          return {
            ok: outcome.state === 'succeeded',
            status: outcome.state,
            proposalId: id,
            actionId: action.id,
            template: action.template,
            target: action.target,
            leaseEligible: action.leaseEligible,
            ...(outcome.code ? {code: outcome.code} : {}),
            beforeState: claimed.plan.beforeState,
            afterState,
            verification: outcome.verification,
            feedback: makeFeedback(claimed.plan, outcome.state, {
              proposalId: id,
              afterState,
              verification: outcome.verification,
              code: outcome.code,
            }),
          };
        } finally {
          inflight.delete(id);
        }
      }

      case 'status': {
        if (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId)) {
          fail('invalid_proposal_id');
        }
        const row = store.get(args.proposalId, actor.id);
        let status = row.state;
        let currentState = null;
        const action = cfg.byId.get(row.plan.actionId);
        const template = getTemplate(row.plan.template);
        let configMatches = false;
        if (action && template) {
          try {
            assertActionMatchesPlan(cfg, row.plan);
            configMatches = true;
          } catch (error) {
            if (!(error instanceof HostAdminError)) throw error;
          }
          if (action.template === row.plan.template && action.target === row.plan.target) {
            currentState = await template.inspect(action, cfg, execRunner);
          }
        }
        if (status === 'pending' && !configMatches) status = 'stale';
        if (status === 'executing') status = 'unknown';

        return {
          ok: true,
          proposalId: row.id,
          domain: DOMAIN,
          status,
          actionId: row.plan.actionId,
          template: row.plan.template,
          target: row.plan.target,
          leaseEligible: row.plan.leaseEligible,
          expiresAtUtc: row.expires_at_utc,
          beforeState: row.plan.beforeState,
          afterState: row.afterState,
          currentState,
          ...(row.execResult?.verification ? {verification: row.execResult.verification} : {}),
          ...(row.error ? {code: row.error} : {}),
          feedback: makeFeedback(row.plan, status, {
            proposalId: row.id,
            afterState: row.afterState,
            verification: row.execResult?.verification,
            code: row.error,
          }),
        };
      }

      default:
        fail('unknown_host_admin_action');
    }
  };
}
