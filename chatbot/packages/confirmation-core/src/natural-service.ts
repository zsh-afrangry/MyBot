import { confirmationBackendProviders, type ConfirmationBackend } from './registry.js';
import { scopeFromInboundEvent } from './scope.js';
import { normalizedContent } from './protocol.js';
import type { ConfirmationInboundEvent, ConfirmationPreview, NaturalConfirmationBackend, NaturalConfirmationSelection } from './types.js';

type Opened = {backend: NaturalConfirmationBackend; rows: ConfirmationPreview[]}[];
const matches = (p: NaturalConfirmationSelection, s: NaturalConfirmationSelection) => p.domain === s.domain
  && p.proposalId === s.proposalId && p.payloadHash === s.payloadHash;

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
    return found.length === 1 && found[0]!.presented(event, selection, messageId);
  });
}

/** Bounded exclusions, not a target/title classifier. The assistant resolves intent and reference. */
export function naturalConfirmationTextAllowed(content: string): boolean {
  const text = normalizedContent(content);
  if (!text || text.length > 2000 || /[?？]/u.test(text)) return false;
  if (/^(?:[“"「『]|引用|转述|他说|她说|别人说|如果|假如|假设|什么|怎么|如何|是否|能否)/u.test(text)) return false;
  if (/(?:不(?:用|要|必|再)?|别|取消|撤回|暂缓|拒绝)\s*确认|不(?:同意|批准)|(?:先|暂时?)别|不要(?:发送|发信|执行|提交)/u.test(text)) return false;
  if (/(?:不过|但是|但|先).*(?:改成|改为|换成|调整)|[，,]\s*(?:请|把|再)?\s*(?:改成|改为|换成|调整)/u.test(text)) return false;
  return /^(?:我\s*)?(?:确认|同意|批准|可以|好的?|没问题|就按|按.*办|发吧|发送|执行|就这样|yes\b|ok\b)/iu.test(text)
    || /(?:确认|可以|同意|没问题|就这样|发吧|发送吧|执行吧)[。！!]?$/u.test(text);
}

export function confirmNaturalProposal(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, nowMs = Date.now()): {
  ok: boolean; code?: string; idempotent?: boolean;
} {
  if (!event.messageId || event.isGroup || event.replyToIsQuote || !scopeFromInboundEvent(event)
    || typeof event.timestamp !== 'number' || event.timestamp > nowMs + 30000 || event.timestamp < nowMs - 300000) {
    return {ok: false, code: 'confirmation_not_current'};
  }
  if (!naturalConfirmationTextAllowed(event.content)) return {ok: false, code: 'confirmation_not_explicit'};
  return withBackends(event, stores => {
    const uses = stores.flatMap(s => s.backend.used(event));
    if (uses.some(p => !matches(p, selection))) return {ok: false, code: 'confirmation_already_used'};
    const found = stores.flatMap(s => s.rows.filter(p => matches(p, selection)).map(p => ({backend: s.backend, proposal: p})));
    if (found.length !== 1) return {ok: false, code: found.length ? 'confirmation_target_ambiguous' : 'proposal_unavailable'};
    const row = found[0]!.proposal;
    if (!row.previewText || row.presentedAtUtc === null || row.sourceMessageId === event.messageId
      || row.presentedAtUtc > Math.floor(event.timestamp! / 1000)) return {ok: false, code: 'proposal_not_presented'};
    // A bare assent is anchored to the latest delivered preview batch. Two previews
    // in the same batch need a reference; an arbitrary model-selected ID is insufficient.
    if (/^(?:我\s*)?(?:确认|同意|批准|可以|好的?|没问题|yes|ok)[。！!]?$/iu.test(normalizedContent(event.content))) {
      const presented = stores.flatMap(s => s.rows).filter(p => p.presentedAtUtc !== null);
      const latest = Math.max(...presented.map(p => p.presentedAtUtc!));
      const focus = presented.filter(p => p.presentedAtUtc === latest);
      if (focus.length !== 1 || !matches(focus[0]!, selection)) return {ok: false, code: 'confirmation_target_ambiguous'};
    }
    return found[0]!.backend.confirm(event, selection)
      ? {ok: true, idempotent: uses.length > 0} : {ok: false, code: 'proposal_unavailable'};
  });
}
