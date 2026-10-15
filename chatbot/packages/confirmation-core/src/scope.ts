import type { ConfirmationScope, ConfirmationToolContext, ConfirmationInboundEvent } from "./types.js";
import { boundedText } from "./validation.js";

const MAX_SCOPE_VALUE_LENGTH = 500;

export function scopeFromToolContext(input: ConfirmationToolContext): ConfirmationScope | undefined {
  const channel = input.messageChannel ?? input.deliveryContext?.channel;
  if (!["qqbot", "kurumi-qq"].includes(channel ?? "") || input.senderIsOwner !== true) return undefined;
  const target = input.deliveryContext?.to?.trim();
  if (!target) return undefined;
  if (channel === "qqbot" && !/^(?:qqbot:)?c2c:/u.test(target)) return undefined;
  if (channel === "kurumi-qq" && (!/^user:[0-9]{5,12}$/u.test(target)
    || target !== `user:${input.requesterSenderId}`
    || input.sessionKey !== `agent:main:kurumi-qq:direct:${input.requesterSenderId}`)) return undefined;
  const delivery = uniqueStrings([
    target ? `target:${target}` : undefined,
    `account:${input.deliveryContext?.accountId?.trim() || "default"}`,
    input.requesterSenderId ? `sender:${input.requesterSenderId.trim()}` : undefined,
  ]);
  const primary = input.sessionKey?.trim()
    ? `session:${input.sessionKey.trim()}`
    : delivery[0] ?? "unbound";
  return { primary, delivery };
}

/** Binds inbound data to an owner-authorized proposal; does not grant tool access. */
export function scopeFromInboundEvent(event: ConfirmationInboundEvent): ConfirmationScope | undefined {
  if (!["qqbot", "kurumi-qq"].includes(event.channel) || event.isGroup) return undefined;
  if (event.channel === "kurumi-qq" && (event.conversationId !== `user:${event.senderId}`
    || !/^[0-9]{5,12}$/u.test(event.senderId ?? "")
    || event.sessionKey !== `agent:main:kurumi-qq:direct:${event.senderId}`)) return undefined;
  const delivery = uniqueStrings([
    event.accountId?.trim() ? `account:${event.accountId.trim()}` : undefined,
    event.conversationId?.trim() ? `conversation:${event.conversationId.trim()}` : undefined,
    event.conversationId?.trim() ? `target:${event.conversationId.trim()}` : undefined,
    event.senderId?.trim() ? `sender:${event.senderId.trim()}` : undefined,
  ]);
  const primary = event.sessionKey?.trim()
    ? `session:${event.sessionKey.trim()}`
    : delivery[0] ?? "unbound";
  return { primary, delivery };
}

export function scopesMatch(left: ConfirmationScope, right: ConfirmationScope): boolean {
  // Correlation aliases never override conflicting identity. Existing proposals
  // without account binding require reproposal through the current live adapter.
  const aliases = (scope: ConfirmationScope, prefix: string) =>
    scope.delivery.filter(value => value.startsWith(prefix)).map(value => value.slice(prefix.length));
  const accountLeft = aliases(left, "account:");
  const accountRight = aliases(right, "account:");
  if (accountLeft.length || accountRight.length) {
    if (accountLeft.length !== 1 || accountRight.length !== 1 || accountLeft[0] !== accountRight[0]) return false;
  }
  const peers = (scope: ConfirmationScope) => [...new Set([
    ...aliases(scope, "target:"), ...aliases(scope, "conversation:"),
  ].map(value => value.replace(/^qqbot:/u, "")))];
  const leftPeers = peers(left), rightPeers = peers(right);
  if (leftPeers.length !== 1 || rightPeers.length !== 1 || leftPeers[0] !== rightPeers[0]) return false;
  const leftSender = aliases(left, "sender:"), rightSender = aliases(right, "sender:");
  if (leftSender.length && rightSender.length && leftSender[0] !== rightSender[0]) return false;
  if (left.primary.startsWith("session:") && right.primary.startsWith("session:") && left.primary !== right.primary) return false;
  return true;
}

export function serializeScope(scope: ConfirmationScope): string {
  const normalized = {
    primary: boundedText(scope.primary, "scope.primary", MAX_SCOPE_VALUE_LENGTH),
    delivery: uniqueStrings(scope.delivery).map((value) => boundedText(value, "scope.delivery", MAX_SCOPE_VALUE_LENGTH)),
  };
  return JSON.stringify(normalized);
}

export function parseScope(value: string): ConfirmationScope {
  try {
    const parsed = JSON.parse(value) as { primary?: unknown; delivery?: unknown };
    if (typeof parsed.primary !== "string") throw new Error("scope.primary missing");
    const delivery = Array.isArray(parsed.delivery)
      ? parsed.delivery.filter((item): item is string => typeof item === "string")
      : [];
    return { primary: parsed.primary, delivery };
  } catch {
    return { primary: "invalid", delivery: [] };
  }
}

function uniqueStrings(values: Array<string | undefined>): string[] {
  return [...new Set(values.filter((value): value is string => Boolean(value && value.length > 0)))];
}
