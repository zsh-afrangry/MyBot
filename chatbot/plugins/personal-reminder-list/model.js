import {parseDeadline} from './time.js';

export const normalize = value => String(value ?? '').normalize('NFKC').replace(/[\s\p{P}]/gu, '').toLowerCase();

function text(value, field, max, required = false) {
  if (value === null || value === undefined || value === '') {
    if (required) throw Error(`${field}不能为空`);
    return null;
  }
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value)) throw Error(`${field}必须为 1 至 ${max} 字的文本`);
  return value.trim();
}
export function item(row) {
  return {id: row.id, title: row.title, content: row.content, note: row.note, ddl: row.ddl,
    deadlineMs: row.deadline_ms, status: row.status, version: row.version,
    createdAt: new Date(row.created_ms).toISOString(), updatedAt: new Date(row.updated_ms).toISOString()};
}

export function validateCommand(args) {
  const allowed = ['action', 'id', 'query', 'expectedVersion', 'title', 'content', 'note', 'ddl', 'times'];
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(k => !allowed.includes(k))) throw Error('Unknown list parameters');
}
export function validateScheduleCommand(args) {
  if (Object.keys(args).some(k => !['action', 'times'].includes(k)) || (args.action !== 'schedule' && 'times' in args)) throw Error('Invalid schedule parameters');
}
export function prepareAddedItem(args, now) {
  if (Object.keys(args).some(k => ['id', 'query', 'expectedVersion', 'times'].includes(k))) throw Error('Invalid add parameters');
  const title = text(args.title, '标题', 120, true), content = text(args.content, '内容', 800), note = text(args.note, '备注', 400);
  const deadline = parseDeadline(args.ddl);
  if (deadline.deadlineMs !== null && deadline.deadlineMs <= now) throw Error('DDL 已经过期；请澄清日期或留空');
  return {title, content, note, ...deadline};
}
export function prepareItemChange(args, row, now) {
  let title = row.title, content = row.content, note = row.note, ddl = row.ddl, deadlineMs = row.deadline_ms, status = row.status;
  if (args.action === 'update' || args.action === 'reopen') {
    if (args.action === 'update' && !['title', 'content', 'note', 'ddl'].some(k => k in args)) throw Error('没有要修改的字段');
    for (const [field, max] of [['title', 120], ['content', 800], ['note', 400]]) {
      if (!(field in args)) continue;
      const value = text(args[field], field, max, field === 'title');
      if (field === 'title') title = value; else if (field === 'content') content = value; else note = value;
    }
    if ('ddl' in args) { const d = parseDeadline(args.ddl); ddl = d.ddl; deadlineMs = d.deadlineMs; }
    if (deadlineMs !== null && deadlineMs <= now && (status === 'active' || args.action === 'reopen' || 'ddl' in args)) throw Error('DDL 已过期，请提供未来 DDL 或显式清除');
    if (args.action === 'reopen') status = 'active';
  } else {
    if (['title', 'content', 'note', 'ddl'].some(k => k in args)) throw Error('状态操作不能同时改动内容');
    status = args.action === 'complete' ? 'completed' : 'void';
  }
  return {title, content, note, ddl, deadlineMs, status};
}
