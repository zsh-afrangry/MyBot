import type { ConfirmationInboundEvent, NaturalConfirmationSelection } from './types.js';
import { markConfirmationPresented, saveConfirmationPreview } from './natural-service.js';

type Preview = {event: ConfirmationInboundEvent; selection: NaturalConfirmationSelection; text: string; at: number};
const key = Symbol.for('kurumi.confirmation.presentations.v1');
const host = globalThis as typeof globalThis & {[key]?: Map<string, Preview>};
const cache = () => host[key] ??= new Map();
const id = (event: ConfirmationInboundEvent, choice: NaturalConfirmationSelection) => JSON.stringify([
  event.accountId, event.conversationId, event.messageId, choice.domain, choice.proposalId, choice.payloadHash,
]);
const prune = () => {for (const [k, v] of cache()) if (Date.now() - v.at > 300000) cache().delete(k);};

/** A prepared preview is not yet confirmation evidence. Successful transport marks it presented. */
export function prepareConfirmationPreview(event: ConfirmationInboundEvent, selection: NaturalConfirmationSelection, text: string): boolean {
  prune();
  if (!saveConfirmationPreview(event, selection, text)) return false;
  while (cache().size >= 256) cache().delete(cache().keys().next().value!);
  cache().set(id(event, selection), {event, selection, text, at: Date.now()});
  return true;
}

export function recordConfirmationDelivery(input: {
  accountId: string; conversationId: string; sourceMessageId: string; messageId: string; text: string;
}): void {
  prune();
  for (const [key, preview] of cache()) {
    if (preview.event.accountId !== input.accountId || preview.event.conversationId !== input.conversationId
      || preview.event.messageId !== input.sourceMessageId || !input.text.includes(preview.text)) continue;
    try {
      if (markConfirmationPresented(preview.event, preview.selection, input.messageId)) cache().delete(key);
    } catch { /* A failed receipt write leaves this preview unconfirmed; no approval is issued. */ }
  }
}
