import type { ConfirmationInboundEvent, ConfirmationScope } from './types.js';
import { scopeFromInboundEvent } from './scope.js';

const key = Symbol.for('kurumi.confirmation.current-requests.v1');
type Permit = {messageId: string; at: number};
const host = globalThis as typeof globalThis & {[key]?: Map<string, Permit>};
const permits = () => host[key] ??= new Map();

/** Host provenance only. Capturing a request neither issues nor consumes an approval. */
export function captureNaturalConfirmationRequest(event: ConfirmationInboundEvent): void {
  const scope = scopeFromInboundEvent(event);
  if (!scope || !event.messageId || !Number.isFinite(event.timestamp)) return;
  while (permits().size >= 64) permits().delete(permits().keys().next().value!);
  permits().set(scope.primary, {messageId: event.messageId, at: event.timestamp!});
}
export function clearNaturalConfirmationRequest(sessionKey: string, messageId?: string): void {
  const key = `session:${sessionKey}`;
  if (!messageId || permits().get(key)?.messageId === messageId) permits().delete(key);
}
export function naturalConfirmationRequestCurrent(scope: ConfirmationScope, messageId: string, nowUtc: number): boolean {
  const permit = permits().get(scope.primary);
  return !!permit && permit.messageId === messageId && permit.at <= nowUtc * 1000 + 30000 && permit.at > nowUtc * 1000 - 300000;
}
