import {isDeepStrictEqual} from 'node:util';
import {AccessError, accessPolicy} from '../../packages/access-control/index.js';
import {assertFields, assertQq, buildMemberChange, findMember, memberPreview, memberView, proposalIdPattern, sha256} from './policy.js';

const encode = policy => JSON.stringify(policy, null, 2) + '\n';
const actions = {
  list: ['action'],
  get: ['action', 'qq'],
  propose: ['action', 'change'],
  commit: ['action', 'proposalId'],
  status: ['action', 'proposalId'],
};

export function createAccessAdminService(source, store) {
  function readSource(owner) {
    const current = source.read();
    const primary = current.policy.subjects.find(row => row.role === 'owner');
    if (primary.qq !== owner || primary.permissions['chat.use'] !== true || primary.permissions['access.manage'] !== true) {
      throw new AccessError('access_admin_source_not_authorized');
    }
    return current;
  }

  return function execute(args, config, {actor, scope, check}) {
    assertFields(args, Object.hasOwn(actions, args?.action) ? actions[args.action] : []);
    const owner = actor.id;
    const runtime = accessPolicy(config);
    const current = readSource(owner);
    const currentStatus = {
      sourceRevision: current.policy.revision, runtimeRevision: runtime.revision,
      inSync: isDeepStrictEqual(runtime, current.policy),
    };
    switch (args.action) {
      case 'list': {
        const members = policy => policy.subjects.filter(row => row.kind === 'user' && row.role === 'member').map(memberView);
        return {ok: true, ...currentStatus, source: members(current.policy),
          ...(!currentStatus.inSync ? {runtime: members(runtime)} : {})};
      }
      case 'get': {
        assertQq(args.qq);
        return {ok: true, ...currentStatus, source: memberView(findMember(current.policy, args.qq)),
          runtime: memberView(findMember(runtime, args.qq))};
      }
      case 'propose': {
        const {next, before, after} = buildMemberChange(current.policy, args.change);
        const plan = {change: args.change, baseRevision: current.policy.revision, baseHash: current.hash,
          nextHash: sha256(encode(next))};
        check();
        const proposal = store.propose(plan, owner, scope);
        const previewText = memberPreview(args.change, before, after, plan.baseRevision);
        return {ok: true, status: 'pending', ...proposal, previewText, presentationFacts: [previewText]};
      }
      case 'commit': {
        const id = args.proposalId;
        if (typeof id !== 'string' || !proposalIdPattern.test(id)) throw new AccessError('invalid_proposal_id');
        const candidate = store.claim(id, owner, scope, plan => {
          if (plan.baseHash !== current.hash || plan.baseRevision !== current.policy.revision) {
            throw new AccessError('access_policy_changed');
          }
          const {next} = buildMemberChange(current.policy, plan.change);
          const bytes = encode(next);
          if (sha256(bytes) !== plan.nextHash) throw new AccessError('access_policy_changed');
          check();
          return {bytes, revision: next.revision};
        });
        // Approval is consumed and the intent is durable before the file replacement.
        // A second SQLite transaction serializes writers and records the outcome.
        const result = store.finish(id, owner, plan => {
          try {
            check();
            source.write(current, candidate.bytes);
            return {state: 'written'};
          } catch (error) {
            if (error instanceof AccessError) return {state: 'failed', code: error.code};
            try {
              const hash = source.read().hash;
              if (hash === plan.nextHash) return {state: 'written'};
              if (hash === plan.baseHash) return {state: 'failed', code: 'access_source_write_failed'};
            } catch { /* The filesystem outcome is unknown. */ }
            return {state: 'unknown', code: 'access_source_write_unknown'};
          }
        });
        return {ok: result.state === 'written', status: result.state, proposalId: id,
          ...(result.code ? {code: result.code} : {sourceRevision: candidate.revision, activation: 'pending_sync'}),
          runtimeRevision: runtime.revision};
      }
      case 'status': {
        const id = args.proposalId;
        if (typeof id !== 'string' || !proposalIdPattern.test(id)) throw new AccessError('invalid_proposal_id');
        const row = store.get(id, owner);
        const confirmedWrite = ['writing', 'unknown'].includes(row.state) && current.hash === row.plan.nextHash;
        let status = row.state;
        if (confirmedWrite) status = 'written';
        else if (row.state === 'writing') status = 'unknown';
        else if (row.state === 'pending' && current.hash !== row.plan.baseHash) status = 'stale';
        return {ok: true, ...currentStatus, proposalId: id, status, change: row.plan.change,
          plannedRevision: row.plan.baseRevision + 1, expiresAtUtc: row.expires_at_utc,
          ...(row.error && !confirmedWrite ? {code: row.error} : {})};
      }
      default: throw new AccessError('unknown_access_admin_action');
    }
  };
}
