import type { ConfirmationInboundEvent, ConfirmationScope, NaturalConfirmationSelection } from './types.js';
import { scopeFromInboundEvent } from './scope.js';

const key = Symbol.for('kurumi.confirmation.current-requests.v1');
type Permit = {messageId: string; at: number; targets?: readonly NaturalConfirmationSelection[]};
const host = globalThis as typeof globalThis & {[key]?: Map<string, Permit>};
const permits = () => host[key] ??= new Map();

/** Host provenance only. Capturing a request neither issues nor consumes an approval. */
export function captureNaturalConfirmationRequest(event: ConfirmationInboundEvent): void {
  const scope = scopeFromInboundEvent(event);
  if (!scope || !event.messageId || !Number.isFinite(event.timestamp)) return;
  // Re-observing the same delivery must not clear its already frozen target set.
  if (permits().get(scope.primary)?.messageId === event.messageId) return;
  while (permits().size >= 64) permits().delete(permits().keys().next().value!);
  permits().set(scope.primary, {messageId: event.messageId, at: event.timestamp!});
}

export function currentConfirmationTargets(event: ConfirmationInboundEvent): readonly NaturalConfirmationSelection[] | undefined {
  const scope = scopeFromInboundEvent(event);
  const permit = scope && permits().get(scope.primary);
  return permit && permit.messageId === event.messageId ? permit.targets : undefined;
}

/** The host-captured message owns this immutable set; model arguments cannot extend it. */
export function bindConfirmationTargets(event: ConfirmationInboundEvent, targets: readonly NaturalConfirmationSelection[], nowMs: number): boolean {
  const scope = scopeFromInboundEvent(event);
  if (!scope || !event.messageId || !naturalConfirmationRequestCurrent(scope, event.messageId, nowMs / 1000)) return false;
  const permit = permits().get(scope.primary)!;
  const keyOf = (p: NaturalConfirmationSelection) => JSON.stringify([p.domain, p.proposalId, p.payloadHash]);
  const keys = (rows: readonly NaturalConfirmationSelection[]) => rows.map(keyOf).sort().join('\n');
  if (permit.targets) return keys(permit.targets) === keys(targets);
  permit.targets = Object.freeze(targets.map(p => Object.freeze({...p})));
  return true;
}
export function clearNaturalConfirmationRequest(sessionKey: string, messageId?: string): void {
  const key = `session:${sessionKey}`;
  if (!messageId || permits().get(key)?.messageId === messageId) permits().delete(key);
}
export function naturalConfirmationRequestCurrent(scope: ConfirmationScope, messageId: string, nowUtc: number): boolean {
  const permit = permits().get(scope.primary);
  return !!permit && permit.messageId === messageId && permit.at <= nowUtc * 1000 + 30000 && permit.at > nowUtc * 1000 - 300000;
}
