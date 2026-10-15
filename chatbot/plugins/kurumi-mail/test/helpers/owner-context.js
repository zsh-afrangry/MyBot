// Shared owner-context fixtures for the mail tests.
//
// These mirror what the host actually provides: an owner-private kurumi-qq conversation. Building them
// through confirmation-core's own scope helpers (rather than hand-rolling a scope object) means the
// tests exercise the same binding rules production does, and would fail if those rules tightened.
import { scopeFromInboundEvent, scopeFromToolContext } from "@kurumi/confirmation-core";

export const OWNER_ID = "365999865";
export const OWNER_EMAIL = "owner@example.test";
export const RECIPIENT = "friend@example.test";
export const SESSION_KEY = `agent:main:kurumi-qq:direct:${OWNER_ID}`;

export function ownerToolContext(overrides = {}) {
  return {
    messageChannel: "kurumi-qq",
    deliveryContext: { channel: "kurumi-qq", to: `user:${OWNER_ID}`, accountId: "default" },
    requesterSenderId: OWNER_ID,
    senderIsOwner: true,
    sessionKey: SESSION_KEY,
    ...overrides,
  };
}

export function ownerScope(overrides = {}) {
  return scopeFromToolContext(ownerToolContext(overrides));
}

/** The owner's confirmation reply, as the host's inbound router would present it. */
export function inboundEvent({ content, messageId = "inbound-1", ...overrides }) {
  return {
    channel: "kurumi-qq",
    accountId: "default",
    conversationId: `user:${OWNER_ID}`,
    senderId: OWNER_ID,
    sessionKey: SESSION_KEY,
    messageId,
    content,
    isGroup: false,
    senderIsOwner: true,
    ...overrides,
  };
}

export function inboundScope(event) {
  return scopeFromInboundEvent(event);
}
