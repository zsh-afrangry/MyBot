import type { ConfirmationInboundEvent, NaturalConfirmationSelection } from './types.js';
import { markConfirmationPresented, saveConfirmationPreview } from './natural-service.js';
import { ACCEPTANCE_CONFIRMATION_CHANNEL, scopedConfirmationPreviews, type PreparedConfirmationPreview } from './request-backends.js';

const key = Symbol.for('kurumi.confirmation.presentations.v1');
const host = globalThis as typeof globalThis & {[key]?: Map<string, PreparedConfirmationPreview>};
const cache = () => host[key] ??= new Map();
const id = (event: ConfirmationInboundEvent, choice: NaturalConfirmationSelection) => JSON.stringify([
  event.accountId, event.conversationId, event.messageId, choice.domain, choice.proposalId, choice.payloadHash,
]);
const prune = (entries: Map<string, PreparedConfirmationPreview>) => {
  for (const [k, v] of entries) if (Date.now() - v.at > 300000) entries.delete(k);
};
export function freezeConfirmationFacts(facts: string[]): {previewText: string; presentationFacts: string[]} {
  if (!facts.length || facts.some(f=>typeof f!=='string' || !f)) throw Error('invalid_confirmation_facts');
  return {previewText:facts.join('\n'),presentationFacts:[...facts]};
}

/** A prepared preview is not yet confirmation evidence. Successful transport marks it presented. */
export function prepareConfirmationPreview(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, text: string, facts?: string[]): boolean {
  const entries = event.channel === ACCEPTANCE_CONFIRMATION_CHANNEL ? scopedConfirmationPreviews(event) : cache();
  if (!entries) return false;
  prune(entries);
  if (!saveConfirmationPreview(event, selection, text, facts)) return false;
  while (entries.size >= 256) entries.delete(entries.keys().next().value!);
  entries.set(id(event, selection), {event, selection, text, ...(facts ? {facts} : {}), at: Date.now()});
  return true;
}

type Receipt = {
  accountId: string; conversationId: string; sourceMessageId: string; messageId: string; text: string;
};
function recordDelivery(entries: Map<string, PreparedConfirmationPreview>, input: Receipt): void {
  prune(entries);
  for (const [key, preview] of entries) {
    if (preview.event.accountId !== input.accountId || preview.event.conversationId !== input.conversationId
      || preview.event.messageId !== input.sourceMessageId || !(preview.facts ?? [preview.text]).every(fact=>input.text.includes(fact))) continue;
    try {
      if (markConfirmationPresented(preview.event, preview.selection, input.messageId)) entries.delete(key);
    } catch { /* A failed receipt write leaves this preview unconfirmed; no approval is issued. */ }
  }
}

export function recordConfirmationDelivery(input: Receipt): void {
  recordDelivery(cache(), input);
}

/** Called by the isolated inbox after saving a receipt in the bound turn. */
export function recordScopedConfirmationDelivery(event: ConfirmationInboundEvent, input: {messageId: string; text: string}): void {
  const entries = scopedConfirmationPreviews(event);
  if (!entries || !event.accountId || !event.conversationId || !event.messageId) return;
  recordDelivery(entries, {...input, accountId: event.accountId, conversationId: event.conversationId, sourceMessageId: event.messageId});
}
