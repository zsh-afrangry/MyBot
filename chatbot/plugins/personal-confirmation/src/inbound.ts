import type { ConfirmationInboundEvent } from "@kurumi/confirmation-core";

/** Only original, direct QQ channel messages can supply confirmation evidence. */
export function confirmationFromDispatch(
  event: { ctx: Record<string, unknown>; isTailDispatch?: boolean; sendPolicy?: string },
  nowMs = Date.now(),
): ConfirmationInboundEvent | undefined {
  const ctx = event.ctx;
  if (event.isTailDispatch || event.sendPolicy === "deny" || ctx.ChatType !== "direct"
    || ctx.ReplyToIsQuote === true) return undefined;
  const channel = ctx.OriginatingChannel ?? ctx.Surface ?? ctx.Provider;
  const conversation = ctx.OriginatingTo ?? ctx.To;
  const messageId = ctx.MessageSidFull ?? ctx.MessageSid;
  const sender = ctx.SenderId;
  const account = ctx.AccountId;
  const session = ctx.SessionKey;
  const routeValid = channel === "qqbot"
    ? typeof conversation === "string" && /^(?:qqbot:)?c2c:[^\s:]+$/u.test(conversation)
    : channel === "kurumi-qq" && ctx.CommandAuthorized === true
      && typeof sender === "string" && /^[0-9]{5,12}$/u.test(sender)
      && conversation === `user:${sender}` && session === `agent:main:kurumi-qq:direct:${sender}`;
  if (!routeValid || typeof conversation !== "string"
    || typeof messageId !== "string" || !messageId.trim() || messageId.length > 500
    || typeof sender !== "string" || !sender.trim()
    || typeof ctx.RawBody !== "string" || ctx.RawBody.length > 2000
    || typeof ctx.Timestamp !== "number" || !Number.isFinite(ctx.Timestamp)) return undefined;
  // QQ adapter supplies epoch milliseconds. Never use run IDs, history text,
  // reply-to text, or a processing timestamp as invented message evidence.
  if (ctx.Timestamp > nowMs + 30_000 || ctx.Timestamp < nowMs - 300_000) return undefined;
  return {
    channel: channel as string, conversationId: conversation, senderId: sender,
    accountId: typeof account === "string" && account.trim() ? account.trim() : "default",
    ...(typeof session === "string" && session.trim() ? { sessionKey: session } : {}),
    messageId, content: ctx.RawBody, timestamp: ctx.Timestamp, isGroup: false,
  };
}
