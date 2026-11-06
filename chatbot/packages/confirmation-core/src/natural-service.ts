import { confirmationBackendProviders, type ConfirmationBackend } from './registry.js';
import { scopeFromInboundEvent } from './scope.js';
import { normalizedContent } from './protocol.js';
import { bindConfirmationTargets, currentConfirmationTargets } from './current-request.js';
import type { ConfirmationInboundEvent, ConfirmationPreview, NaturalConfirmationBackend, NaturalConfirmationSelection, NaturalConfirmationResult } from './types.js';

type Opened = {backend: NaturalConfirmationBackend; rows: ConfirmationPreview[]}[];
const matches = (p: NaturalConfirmationSelection, s: NaturalConfirmationSelection) => p.domain === s.domain
  && p.proposalId === s.proposalId && p.payloadHash === s.payloadHash;
export const MAX_CONFIRMATION_TARGETS = 16;
const bareAssent = (content: string) => /^(?:我\s*)?(?:确认|同意|批准|可以|好的?|没问题|yes|ok)[。！!]?$/iu.test(normalizedContent(content));
const orderOf = (p: ConfirmationPreview) => p.presentationOrder ?? (p.presentedAtUtc ?? 0) * 1000;

function withBackends<T>(event: ConfirmationInboundEvent, work: (opened: Opened) => T): T {
  const opened: ConfirmationBackend[] = [];
  try {
    const providers = confirmationBackendProviders();
    if (!providers.length) throw Error('no_backends');
    const rows: Opened = [];
    for (const provider of providers) {
      const backend = provider.open(); opened.push(backend);
      if (!backend.natural) throw Error('natural_confirmation_not_supported');
      rows.push({backend: backend.natural, rows: backend.natural.list(event)});
    }
    return work(rows);
  } finally { for (const backend of opened.reverse()) backend.close(); }
}

export function listNaturalConfirmations(event: ConfirmationInboundEvent): ConfirmationPreview[] {
  return withBackends(event, stores => stores.flatMap(s => s.rows));
}

export function saveConfirmationPreview(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, text: string): boolean {
  return withBackends(event, stores => {
    const found = stores.flatMap(s => s.rows.filter(p => matches(p, selection)).map(() => s.backend));
    return found.length === 1 && found[0]!.savePreview(event, selection, text);
  });
}

/** Called only after the QQ adapter returned successful receipts for the entire preview. */
export function markConfirmationPresented(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, messageId: string): boolean {
  return withBackends(event, stores => {
    const found = stores.flatMap(s => s.rows.filter(p => matches(p, selection)).map(() => s.backend));
    if (found.length !== 1) return false;
    const presented = stores.flatMap(s => s.rows).filter(p => p.presentedAtUtc !== null);
    const batch = presented.find(p => p.sourceMessageId === event.messageId && p.presentationOrder != null);
    const order = batch?.presentationOrder ?? Math.max(Date.now(), ...presented.map(orderOf)) + 1;
    return found[0]!.presented(event, selection, messageId, order);
  });
}

/** Bounded exclusions, not a target/title classifier. The assistant resolves intent and reference. */
export function naturalConfirmationTextAllowed(content: string): boolean {
  const text = normalizedContent(content);
  if (!text || text.length > 2000 || /[?？]/u.test(text)) return false;
  if (/^(?:[“"「『]|引用|转述|他说|她说|别人说|如果|假如|假设|什么|怎么|如何|是否|能否)/u.test(text)) return false;
  if (/(?:如果|假如|假设|他说|她说|别人说)|确认(?:是什么|的意思|是什么意思)|(?:知道了|收到|先放着|先放一放|稍后再说)/u.test(text)) return false;
  if (/(?:不(?:用|要|必|再)?|别|取消|撤回|暂缓|拒绝)\s*确认|不(?:同意|批准)|(?:先|暂时?)别|不要(?:发送|发信|执行|提交)/u.test(text)) return false;
  if (/(?:不过|但是|但|先).*(?:改成|改为|换成|调整)|[，,]\s*(?:请|把|再)?\s*(?:改成|改为|换成|调整)/u.test(text)) return false;
  // Intent/reference remains the assistant's job. Assent need not begin or end
  // the sentence (e.g. “只确认刚才两项中的第二项，第一项先不要动”).
  return /(?:确认|同意|批准|可以|没问题|就按|按.*办|发吧|发送|执行|就这样|\byes\b|\bok\b)/iu.test(text);
}

function requestError(event: ConfirmationInboundEvent, nowMs: number): string | undefined {
  if (!event.messageId || event.isGroup || event.replyToIsQuote || !scopeFromInboundEvent(event)
    || typeof event.timestamp !== 'number' || event.timestamp > nowMs + 30000 || event.timestamp < nowMs - 300000) {
    return 'confirmation_not_current';
  }
  if (!naturalConfirmationTextAllowed(event.content)) return 'confirmation_not_explicit';
}

function confirmOne(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, stores: Opened, nowMs: number, batch = false): NaturalConfirmationResult {
  const uses = stores.flatMap(s => s.backend.used(event));
  const bound = currentConfirmationTargets(event);
  if (bound ? !bound.some(p => matches(p, selection)) || uses.some(p => !bound.some(t => matches(p, t)))
    : uses.some(p => !matches(p, selection))) return {ok: false, code: 'confirmation_already_used'};
  const found = stores.flatMap(s => s.rows.filter(p => matches(p, selection)).map(p => ({backend: s.backend, proposal: p})));
  if (found.length !== 1) return {ok: false, code: found.length ? 'confirmation_target_ambiguous' : 'proposal_unavailable'};
  if (batch && !found[0]!.backend.supportsBatch) return {ok: false, code: 'confirmation_batch_unsupported'};
  const row = found[0]!.proposal;
  if (!row.previewText || row.presentedAtUtc === null || row.sourceMessageId === event.messageId
    || row.presentedAtUtc > Math.floor(event.timestamp! / 1000)) return {ok: false, code: 'proposal_not_presented'};
  // A bare assent is anchored to the latest delivered preview batch. Two previews
  // in the same batch need a reference; an arbitrary model-selected ID is insufficient.
  if (bareAssent(event.content)) {
    const presented = stores.flatMap(s => s.rows).filter(p => p.presentedAtUtc !== null);
    const latest = Math.max(...presented.map(orderOf));
    const focus = event.replyToMessageId
      ? presented.filter(p => p.presentationMessageId === event.replyToMessageId)
      : presented.filter(p => orderOf(p) === latest);
    if (focus.length !== 1 || !matches(focus[0]!, selection)) return {ok: false, code: 'confirmation_target_ambiguous'};
  }
  // Single-item callers retain the legacy API. When called from a captured
  // host request they freeze a singleton, so a later batch cannot expand it.
  if (!bound) bindConfirmationTargets(event, [selection], nowMs);
  return found[0]!.backend.confirm(event, selection)
    ? {ok: true, idempotent: uses.some(p => matches(p, selection))} : {ok: false, code: 'proposal_unavailable'};
}

export function confirmNaturalProposal(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, nowMs = Date.now()): NaturalConfirmationResult {
  const code = requestError(event, nowMs);
  return code ? {ok: false, code} : withBackends(event, stores => confirmOne(event, selection, stores, nowMs));
}

/** Explicit finite set, authorized per target; business commits remain independent. */
export function confirmNaturalProposals(event: ConfirmationInboundEvent, selections: readonly NaturalConfirmationSelection[], nowMs = Date.now()) {
  const code = requestError(event, nowMs);
  if (code) return {ok: false, code, results: []};
  if (!Array.isArray(selections) || !selections.length || selections.length > MAX_CONFIRMATION_TARGETS
    || selections.some(p => !p || typeof p.domain !== 'string' || !/^[a-f0-9-]{36}$/iu.test(p.proposalId) || !/^[a-f0-9]{64}$/u.test(p.payloadHash))
    || new Set(selections.map(p => JSON.stringify([p.domain, p.proposalId]))).size !== selections.length) {
    return {ok: false, code: 'confirmation_invalid_targets', results: []};
  }
  if (selections.length > 1 && bareAssent(event.content)) return {ok: false, code: 'confirmation_target_ambiguous', results: []};
  return withBackends(event, stores => {
    const used = stores.flatMap(s => s.backend.used(event));
    if ((!currentConfirmationTargets(event) && used.length) || !bindConfirmationTargets(event, selections, nowMs)) {
      return {ok: false, code: 'confirmation_targets_locked', results: []};
    }
    const results = selections.map(selection => {
      try { return {...selection, ...confirmOne(event, selection, stores, nowMs, selections.length > 1)}; }
      // A storage exception may follow a committed grant. Report uncertainty;
      // never retry it or pretend a cross-store rollback happened.
      catch { return {...selection, ok: false, code: 'confirmation_outcome_unknown'}; }
    });
    const count = results.filter(r => r.ok).length;
    return {ok: count === results.length, status: count === results.length ? 'authorized' : count ? 'partial' : 'rejected', results};
  });
}
