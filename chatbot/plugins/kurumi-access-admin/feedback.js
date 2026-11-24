import {isDeepStrictEqual} from 'node:util';
import {businessFeedback} from '../../packages/feedback-core/index.js';
import {sha256} from './policy.js';

function matchesLegacyMember(list, change) {
  const member = list.find(entry => entry.qq === change.qq);
  if (change.op === 'remove') return !member;
  if (!member) return false;
  const {grant = [], revoke = [], enabled, note, expiresAt} = change;
  const expiry = expiresAt == null ? expiresAt : new Date(expiresAt).toISOString();
  if (change.op === 'add') {
    return member.enabled === (enabled ?? true) && member.note === (note ?? null)
      && member.expiresAt === (expiry ?? null) && member.permissions.length === grant.length
      && grant.every(permission => member.permissions.includes(permission));
  }
  return (enabled === undefined || enabled === member.enabled)
    && (note === undefined || note === member.note)
    && (expiry === undefined || expiry === member.expiresAt)
    && grant.every(permission => member.permissions.includes(permission))
    && revoke.every(permission => !member.permissions.includes(permission));
}

function matchesChange(category, list, plan) {
  if (plan.before === undefined || plan.after === undefined) return matchesLegacyMember(list, plan.change);
  const oldKey = plan.before === null ? null : category.key(plan.before);
  const newKey = plan.after === null ? null : category.key(plan.after);
  if (oldKey !== null && oldKey !== newKey && list.some(row => category.key(row) === oldKey)) return false;
  return newKey === null || list.some(row => category.key(row) === newKey && isDeepStrictEqual(row, plan.after));
}

function listEvidence(category, list, revision, status) {
  const entries = [...list].sort((a, b) => category.key(a).localeCompare(category.key(b)));
  return {status, listSha256: sha256(JSON.stringify(entries)), ...(revision !== undefined && {revision})};
}

export function accessChangeResult(result, {name, category, plan, repoList, liveList, feedbackActions}) {
  let sourceStatus = 'unverified', runtimeStatus = 'unverified';
  if (result.status === 'written') {
    const matchesVersion = (list, revision) => (revision === undefined || revision > plan.baseRevision)
      && matchesChange(category, list, plan);
    const sourceMatches = matchesVersion(repoList, result.sourceRevision);
    sourceStatus = sourceMatches ? 'current' : 'superseded';
    if (result.runtimeUnavailable) runtimeStatus = 'unverified';
    else if (matchesVersion(liveList, result.runtimeRevision)) runtimeStatus = 'active';
    else runtimeStatus = sourceMatches ? 'pending_sync' : 'not_active';
    result.activation = sourceMatches ? runtimeStatus : 'superseded';
  }
  const action = 'access.' + name;
  if (feedbackActions.has(action)) {
    result.feedback = businessFeedback(action, result.status, {
      proposalId: result.proposalId,
      category: name,
      operation: plan.change.op,
      entryKey: plan.change.qq ?? plan.change.key,
      ...(plan.change.replacement && {replacementKey: plan.change.replacement}),
      ...(result.code && {code: result.code}),
      source: listEvidence(category, repoList, result.sourceRevision, sourceStatus),
      runtime: listEvidence(category, liveList, result.runtimeRevision, runtimeStatus),
    });
  }
  return result;
}
