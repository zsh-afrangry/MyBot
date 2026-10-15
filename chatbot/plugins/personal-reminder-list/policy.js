// Existing language admission rules. Only service/intake call this module;
// persistence never reads chat text or imports this policy.
import {normalize} from './model.js';
import {trustedText, PERMIT_TTL_MS} from './inbound.js';

const ADD = /加一(?:条|个|项)|添加|追加|新建|新增|加入|加(?:到|进|上)|记录|加紧(?:到|进)?提醒列表/u;
const NON_ADD = /修改|更改|改成|改为|改到|改一下|更新|调整|清除|清空|做好了|做完了|已完成|完成了|作废|取消|删除|不做了|恢复|重开|暂停|停止|关闭/u;
const NO_WRITE = /假如|假设|举例|示例|测试提示词|如果|是什么意思|(?:解释|翻译|分析)(?:一下)?(?:这段|这句话|下面)|(?:不要|别|不用|不需要)(?:再|替我|帮我|给我|去|继续|往提醒列表里)?\s*(?:加|添|追|记|新建|作废|修改|取消|播报|播放)/u;
const INQUIRY = /(?:能否|能不能|可不可以|是否可以).{0,24}(?:添加|加一|修改|作废|创建)|(?:能|可以).{0,24}(?:添加|加一|修改|作废|创建).{0,12}[吗？?]/u;
const END = /换(?:个)?话题|聊(?:点|点儿|个)?别的|先不(?:录|加|记)|结束(?:录入|添加)|停止(?:录入|添加)|录完了|先这样|就这些|不加了|不记了|不用了|^\s*\/(?:new|reset|stop)(?:\s|$)/u;
const ONE_OFF = /一次性|单独.{0,8}提醒|(?:\d+|[一二三四五六七八九十两半]+)(?:分钟|小时|秒钟|秒)后.{0,8}提醒|到点.{0,8}提醒/u;
export function isStandaloneReminder(raw) {
  return ONE_OFF.test(raw) && (!/提醒列表/u.test(raw) || /(?:不用|不要用|不放|不加|不记录|别用|别放|别加).{0,8}提醒列表/u.test(raw));
}
export function wantsContinuousEntry(raw) {
  return !NO_WRITE.test(raw) && !END.test(raw) && /提醒列表/u.test(raw)
    && (/接下来.{0,15}(?:逐条|一条条|发|事项)|(?:帮我|请).{0,12}(?:维护|管理).{0,12}提醒列表/u.test(raw)
      || /(?:维护|管理).{0,12}提醒列表/u.test(raw) && /需要.{0,12}(?:定期|提醒我)|事情有点多/u.test(raw));
}
export function isContinuationCandidate(raw) {
  if (!raw || NO_WRITE.test(raw) || INQUIRY.test(raw) || END.test(raw) || ONE_OFF.test(raw) || NON_ADD.test(raw)) return false;
  if (/[？?]|(?:吗|呢)[。！!]?$/u.test(raw) || /天气|为什么|怎么样|帮我(?:查|搜|找).{0,6}(?:论文|新闻|资料)/u.test(raw)) return false;
  // A continuation must look like a next item; arbitrary conversation is not a write request.
  return ADD.test(raw) || /^(?:第?[一二三四五六七八九十\d]+(?:条|项|个)[：:、，,]?|还有(?:一条|一个|一项)?[：:、，,]?|(?:\d{1,2}月\d{1,2}|今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]))/u.test(raw)
    || /(?:需要|要交|得交|越快越好|无\s*DDL|没有\s*DDL|结束后|选举后|联系.{0,12}党支部|整理.{0,12}(?:党费|材料))/iu.test(raw);
}
export function listIntent(ctx, owner, event = {}, now = Date.now()) {
  const raw = trustedText(ctx, owner, event, now);
  if (!raw || !/提醒列表/u.test(raw) || NO_WRITE.test(raw) || INQUIRY.test(raw) || END.test(raw) || isStandaloneReminder(raw)) return;
  const actions = new Set();
  // Action words inside the new item's data do not authorize edits to existing items/settings.
  if (ADD.test(raw)) actions.add('add');
  else {
    if (/修改|更改|改成|改为|改到|改一下|更新|调整|设为|设置|清除|清空/u.test(raw)) actions.add('update');
    if (/做好了|做完了|已完成|完成了|标.{0,4}完成|标.{0,4}已完成|完成.{0,20}(?:事项|任务)/u.test(raw)) actions.add('complete');
    if (/作废|取消|删除|不做了/u.test(raw)) actions.add('void');
    if (/重新开启|重新激活|恢复.{0,8}(事项|待办|记录)|重新.{0,6}(待办|有效)/u.test(raw)) actions.add('reopen');
    if (/(?:播报|播放|推送|汇总)/u.test(raw) && /修改|调整|设置|改成|改为|每天|每日|时刻|时间|次数/u.test(raw)) actions.add('schedule');
    if (/(?:暂停|关闭|停止).{0,12}(?:提醒列表|播报|播放|推送|汇总)|提醒列表.{0,12}(?:暂停|关闭|停止)/u.test(raw)) actions.add('pause');
    if (/(?:恢复|开启|启用).{0,12}(?:提醒列表|播报|播放|推送|汇总)|提醒列表.{0,12}(?:恢复|开启|启用).{0,8}(?:播报|播放|推送|汇总)/u.test(raw)) actions.add('resume');
  }
  if (!actions.size) return;
  return {raw, actions, at: now, messageId: String(ctx.MessageSid), sessionKey: ctx.SessionKey};
}
export function checkPermit(permit, action, now) {
  if (!permit || !Number.isFinite(permit.at) || now < permit.at || now - permit.at >= PERMIT_TTL_MS) throw Error('需要有效的本人当前请求');
  // Existing-item semantics belong to the model. Transport freshness is still
  // enforced, but an exact title/list name/verb in this message is not a grant.
  if (!['update', 'complete', 'void', 'reopen'].includes(action) && !permit.actions?.has(action)) throw Error('需要本人本次原文明确要求此提醒列表操作；连续录入仅追加，一个请求只维护一项');
}
export function checkTextSource(value, permit) {
  if (value !== null && value !== '' && value !== undefined && !normalize(permit.raw).includes(normalize(value))) throw Error('标题、内容和备注需取自本次原文，不能添加推测事实');
}
export function checkItemFacts(fields, permit, checkDeadline = true) {
  const raw = permit.raw.normalize('NFKC'), hasDdl = fields.ddl !== null;
  const noDdl = /(?:无|没有|未设|不设|不设置|不指定).{0,4}(?:DDL|截止|期限)|(?:DDL|截止|期限).{0,4}(?:为空|没有|无|不设|不设置)/iu.test(raw);
  const dateGiven = /\d{1,2}月\d{1,2}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天]/u.test(raw);
  const condition = raw.match(/(?:活动|会议|选举|换届|组会|汇报|课程|上课|考试|答辩)(?:结束|完成)?(?:之后|以后|后)/u)?.[0];
  const explicitDeadline = /(?:DDL|截止(?:时间)?|期限).{0,12}(?:\d{1,2}月\d{1,2}|\d{4}[-/]\d{1,2}[-/]\d{1,2}|今天|明天|后天|周[一二三四五六日天]|星期[一二三四五六日天])/iu.test(raw);
  if (!noDdl && /下次课前|下次上课前|下节课前/u.test(raw) && !dateGiven) throw Error('下次课的日期未确定，请先澄清DDL');
  if (hasDdl && noDdl) throw Error('原文明确无DDL，必须留空；紧迫程度或活动条件保存为内容/备注');
  if (checkDeadline && hasDdl && (!dateGiven || condition && !explicitDeadline)) throw Error('原文没有确定的截止日期；不能从活动关系或紧迫程度补造DDL');
  const saved = normalize([fields.title, fields.content, fields.note].filter(Boolean).join(' '));
  if (condition && !saved.includes(normalize(condition))) throw Error('活动结束后的条件必须保存在标题、内容或备注中');
  if (/越快越好/u.test(raw) && !normalize([fields.content, fields.note].filter(Boolean).join(' ')).includes('越快越好')) throw Error('原文的“越快越好”必须保存在内容或备注中');
}
export function checkScheduleSource(permit) {
  if (!/(?:\d{1,2}[:：.]\d{2}|\d{1,2}[点时]|[零一二三四五六七八九十两]{1,3}点|午夜|零点)/u.test(permit.raw)) throw Error('仅指定次数还不能确定播报时刻，请补充每日具体时间');
}

// One mutation per incoming message is a product policy, separate from exact
// replay detection/storage. A later policy change must also change this key.
export function listRequestKey(permit) {
  return `${permit.sessionKey}:${permit.messageId}`;
}
export function checkRequestReplay(previousHash, nextHash) {
  if (previousHash !== nextHash) throw Error('本次消息已经执行过一项维护，请用新消息提出下一项');
}
