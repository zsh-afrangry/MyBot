// Existing explicit-memory admission rules. No file access or confirmation grants.
import {normalize} from './model.js';
import {trustedMemoryText} from './inbound.js';

export function memoryIntent(ctx, owner, event = {}) {
  const raw = trustedMemoryText(ctx, owner, event);
  if (raw === undefined) return;
  const match = raw.trim().match(/^(?:请你|请|帮我|麻烦你)?\s*(记住|记下来|更新记忆|修改记忆|忘记|删除记忆)/u);
  if (!match) return;
  return {raw, verb: match[1], at: Date.now(), messageId: ctx.MessageSid};
}
export function checkMemoryAction(action, permit) {
  if (action === 'upsert' && !['记住', '记下来', '更新记忆', '修改记忆'].includes(permit.verb)) throw Error('本次消息没有授权保存记忆');
  if (action === 'delete' && !['忘记', '删除记忆'].includes(permit.verb)) throw Error('本次消息没有授权删除记忆');
}
export function checkMemoryText(text, permit) {
  if (!normalize(permit.raw).includes(normalize(text))) throw Error('仅可保存本次主人原文中的事实，不自动概括或引入网页内容');
}
export function checkMemoryTarget(args, existing, permit) {
  const raw = normalize(permit.raw);
  if (args.action === 'upsert' && args.id && (!existing || !raw.includes(args.id))) throw Error('更正时请在原文指定记忆ID');
  if (args.action === 'delete' && !raw.includes(args.id) && !raw.includes(normalize(existing.text))) throw Error('删除时请指出记忆ID或完整内容');
}
export const defaultMemoryPolicy = Object.freeze({intent: memoryIntent, authorize: checkMemoryAction,
  checkText: checkMemoryText, checkTarget: checkMemoryTarget});
