// Authorize only the current trusted owner text, never quoted/web/cron context.
export const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();
export function listIntent(ctx, owner, event = {}, now = Date.now()) {
  if (event.isTailDispatch || event.sendPolicy === 'deny' || ctx.CommandAuthorized !== true
    || ctx.ChatType !== 'direct' || ctx.SenderId !== owner || ctx.OriginatingChannel !== 'kurumi-qq'
    || ctx.OriginatingTo !== `user:${owner}` || ctx.SessionKey !== `agent:main:kurumi-qq:direct:${owner}`
    || typeof ctx.RawBody !== 'string' || ctx.RawBody.length > 6000 || !ctx.MessageSid
    || typeof ctx.Timestamp !== 'number' || Math.abs(now - ctx.Timestamp) > 300000) return;
  const raw = ctx.RawBody.trim();
  if (!/提醒列表/u.test(raw) || /^(?:假如|假设|如果|举例|示例|测试提示词|不要|别|不用)/u.test(raw)
    || /(?:不要|别|不用).{0,8}(?:添加|追加|新建|作废|修改|取消|播报|播放)/u.test(raw)) return;
  const actions = new Set();
  if (/加一条|添加|追加|新建|新增|加入|加到|加上|记录/u.test(raw)) actions.add('add');
  if (/修改|更改|改成|改为|改到|改一下|更新|调整|设为|设置|清除|清空/u.test(raw)) actions.add('update');
  if (/做好了|做完了|已完成|完成了|标.{0,4}完成|标.{0,4}已完成|完成.{0,20}(?:事项|任务)/u.test(raw)) actions.add('complete');
  if (/作废|取消|删除|不做了/u.test(raw)) actions.add('void');
  if (/重新开启|重新激活|恢复.{0,8}(事项|待办|记录)|重新.{0,6}(待办|有效)/u.test(raw)) actions.add('reopen');
  if (/(?:播报|播放|推送|汇总)/u.test(raw) && /修改|调整|设置|改成|改为|每天|每日|时刻|时间|次数/u.test(raw)) actions.add('schedule');
  if (/(?:暂停|关闭|停止).{0,12}(?:提醒列表|播报|播放|推送|汇总)|提醒列表.{0,12}(?:暂停|关闭|停止)/u.test(raw)) actions.add('pause');
  if (/(?:恢复|开启|启用).{0,12}(?:提醒列表|播报|播放|推送|汇总)|提醒列表.{0,12}(?:恢复|开启|启用).{0,8}(?:播报|播放|推送|汇总)/u.test(raw)) actions.add('resume');
  if (!actions.size) return;
  return {raw, actions, at: now, messageId: String(ctx.MessageSid), sessionKey: ctx.SessionKey};
}
export function checkPermit(permit, action, now) {
  if (!permit || now - permit.at >= 300000 || !permit.actions.has(action)) throw Error('需要本人本次原文明确要求此提醒列表操作；一个请求只维护一项');
}
export function checkTextSource(value, permit) {
  if (value !== null && value !== '' && value !== undefined && !normalize(permit.raw).includes(normalize(value))) throw Error('标题、内容和备注需取自本次原文，不能添加推测事实');
}
export function checkScheduleSource(permit) {
  // A requested frequency alone does not determine the actual daily times.
  if (!/(?:\d{1,2}[:：.]\d{2}|\d{1,2}[点时]|[零一二三四五六七八九十两]{1,3}点|午夜|零点)/u.test(permit.raw)) throw Error('仅指定次数还不能确定播报时刻，请补充每日具体时间');
}
