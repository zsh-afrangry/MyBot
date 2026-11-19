import {isDeepStrictEqual} from 'node:util';
import {AccessError, accessPolicy} from '../../packages/access-control/index.js';
import {getCategory} from './categories.js';
import {assertFields, proposalIdPattern, sha256} from './policy.js';

const encode = policy => JSON.stringify(policy, null, 2) + '\n';
const actions = {
  list: ['action', 'category'],
  get: ['action', 'category', 'qq', 'key'],
  propose: ['action', 'category', 'change'],
  commit: ['action', 'proposalId'],
  status: ['action', 'proposalId'],
};

function applied(list, category, {before, after}) {
  const oldKey = before === null ? null : category.key(before);
  const newKey = after === null ? null : category.key(after);
  if (oldKey !== null && oldKey !== newKey && list.some(row => category.key(row) === oldKey)) return false;
  return newKey === null || list.some(row => category.key(row) === newKey && isDeepStrictEqual(row, after));
}

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
    assertFields(args, typeof args?.action === 'string' && Object.hasOwn(actions, args.action) ? actions[args.action] : []);
    const byProposal = args.action === 'commit' || args.action === 'status';
    if (byProposal && (typeof args.proposalId !== 'string' || !proposalIdPattern.test(args.proposalId))) {
      throw new AccessError('invalid_proposal_id');
    }
    const owner = actor.id;
    const row = byProposal ? store.get(args.proposalId, owner) : undefined;
    const name = (byProposal ? row.plan.category : args.category) ?? 'member';
    const category = getCategory(name, config);
    const legacy = name === 'member';
    const runtime = accessPolicy(config);
    const current = readSource(owner);
    const repoList = category.list(current.policy);
    const liveList = category.live(runtime, config);
    const currentStatus = {
      ...(!legacy ? {category: name} : {}),
      sourceRevision: current.policy.revision, runtimeRevision: runtime.revision,
      inSync: legacy ? isDeepStrictEqual(runtime, current.policy) : isDeepStrictEqual(liveList, repoList),
    };
    switch (args.action) {
      case 'list':
        return {ok: true, ...currentStatus, source: repoList,
          ...(!legacy || !currentStatus.inSync ? {runtime: liveList} : {})};
      case 'get': {
        assertFields(args, ['action', 'category', category.arg]);
        const key = category.parseKey(args[category.arg]);
        const selected = list => list.find(entry => category.key(entry) === key) ?? null;
        return {ok: true, ...currentStatus, source: selected(repoList), runtime: selected(liveList)};
      }
      case 'propose': {
        const draft = category.build(current.policy, args.change);
        const change = draft.change ?? args.change;
        const plan = {
          ...(!legacy ? {category: name, before: draft.before, after: draft.after} : {}),
          change, baseRevision: current.policy.revision, baseHash: current.hash,
          nextHash: sha256(encode(draft.next)),
        };
        check();
        const proposal = store.propose(plan, owner, scope);
        const previewText = category.preview({...draft, change}, plan.baseRevision);
        return {ok: true, status: 'pending', ...(!legacy ? {category: name} : {}),
          ...proposal, previewText, presentationFacts: [previewText]};
      }
      case 'commit': {
        const id = args.proposalId;
        const candidate = store.claim(id, owner, scope, plan => {
          if (plan.baseHash !== current.hash || plan.baseRevision !== current.policy.revision) {
            throw new AccessError('access_policy_changed');
          }
          const {next} = category.build(current.policy, plan.change);
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
          ...(!legacy ? {category: name} : {}),
          ...(result.code ? {code: result.code} : {sourceRevision: candidate.revision, activation: 'pending_sync'}),
          runtimeRevision: runtime.revision};
      }
      case 'status': {
        const id = args.proposalId;
        const confirmedWrite = ['writing', 'unknown'].includes(row.state) && current.hash === row.plan.nextHash;
        let status = row.state;
        if (confirmedWrite) status = 'written';
        else if (row.state === 'writing') status = 'unknown';
        else if (row.state === 'pending' && current.hash !== row.plan.baseHash) status = 'stale';
        const activation = !legacy && status === 'written'
          ? (!applied(repoList, category, row.plan) ? 'superseded'
            : applied(liveList, category, row.plan) ? 'active' : 'pending_sync')
          : undefined;
        return {ok: true, ...currentStatus, proposalId: id, status, change: row.plan.change,
          plannedRevision: row.plan.baseRevision + 1, expiresAtUtc: row.expires_at_utc,
          ...(activation ? {activation} : {}),
          ...(row.error && !confirmedWrite ? {code: row.error} : {})};
      }
      default: throw new AccessError('unknown_access_admin_action');
    }
  };
}
