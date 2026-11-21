import { AsyncLocalStorage } from 'node:async_hooks';
import type { ConfirmationBackendProvider } from './registry.js';
import type { ConfirmationInboundEvent, ConfirmationScope, NaturalConfirmationSelection } from './types.js';

export const ACCEPTANCE_CONFIRMATION_CHANNEL = 'kurumi-acceptance';
export type ConfirmationPermit = {messageId: string; at: number; targets?: readonly NaturalConfirmationSelection[]};
export type PreparedConfirmationPreview = {event: ConfirmationInboundEvent; selection: NaturalConfirmationSelection;
  text: string; facts?: string[]; at: number};

type Binding = {
  event: ConfirmationInboundEvent;
  scope: ConfirmationScope;
  expiresAt: number;
  providers: readonly ConfirmationBackendProvider[];
  permit: ConfirmationPermit;
  previews: Map<string, PreparedConfirmationPreview>;
  active: boolean;
};
const key = Symbol.for('kurumi.confirmation.request-backends.v1');
const host = globalThis as typeof globalThis & {[key]?: AsyncLocalStorage<Binding>};
const context = host[key] ??= new AsyncLocalStorage<Binding>();
const uuidSource = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const uuid = new RegExp('^' + uuidSource + '$', 'u');
const testSession = new RegExp('^agent:(acceptance-[a-z0-9-]{1,48}):scenario:(' + uuidSource + ')$', 'u');
const lifetimeMs = 5 * 60 * 1000;
export const isScopedConfirmationSession = (sessionKey?: string): boolean => testSession.test(sessionKey ?? '');

function current(): Binding | undefined {
  const binding = context.getStore();
  return binding?.active && Date.now() < binding.expiresAt ? binding : undefined;
}

function forEvent(event: ConfirmationInboundEvent): Binding | undefined {
  const binding = current();
  return binding?.event === event ? binding : undefined;
}

/** Internal host composition only. This grants no model/tool admission authority.
 * The host supplies its own immutable event and providers after admission. A
 * scope is selected before any storage opens; ordinary QQ never enters here.
 */
export async function withScopedConfirmationBackends<T>(input: {
  event: ConfirmationInboundEvent;
  providers: readonly ConfirmationBackendProvider[];
}, work: (event: ConfirmationInboundEvent, scope: ConfirmationScope) => Promise<T>): Promise<T> {
  const event = Object.freeze({...input.event});
  const now = Date.now();
  if (event.channel !== ACCEPTANCE_CONFIRMATION_CHANNEL || event.isGroup || event.senderIsOwner !== false
    || !uuid.test(event.senderId ?? '') || !uuid.test(event.accountId ?? '')
    || event.conversationId !== 'inbox:' + event.senderId || testSession.exec(event.sessionKey ?? '')?.[2] !== event.senderId
    || !event.messageId || !uuid.test(event.messageId) || typeof event.timestamp !== 'number'
    || !Number.isSafeInteger(event.timestamp) || event.timestamp > now + 30000 || event.timestamp <= now - lifetimeMs
    || typeof event.content !== 'string' || event.content.length > 16000
    || !input.providers.length || new Set(input.providers.map(p => p.id)).size !== input.providers.length) {
    throw Error('invalid_scoped_confirmation_request');
  }
  const scope = Object.freeze({primary: 'session:' + event.sessionKey,
    delivery: Object.freeze(['account:' + event.accountId, 'target:' + event.conversationId, 'sender:' + event.senderId])});
  const providers = Object.freeze(input.providers.map(provider => Object.freeze({id: provider.id, open: provider.open.bind(provider)})));
  const binding: Binding = {event, scope, providers, active: true, expiresAt: Math.min(now, event.timestamp) + lifetimeMs,
    permit: {messageId: event.messageId, at: event.timestamp}, previews: new Map()};
  return context.run(binding, async () => {
    try {return await work(event, scope);}
    finally {binding.active = false; binding.previews.clear();}
  });
}

export const scopedConfirmationScope = (event: ConfirmationInboundEvent) => forEvent(event)?.scope;
export const scopedConfirmationProviders = (event: ConfirmationInboundEvent) => forEvent(event)?.providers;
export const scopedConfirmationPreviews = (event: ConfirmationInboundEvent) => forEvent(event)?.previews;
export function scopedConfirmationPermit(scope: ConfirmationScope): ConfirmationPermit | undefined {
  const binding = current();
  return binding?.scope === scope ? binding.permit : undefined;
}
