// Domain time is Asia/Shanghai. A date-only DDL ends at the next midnight: SQLite mode
// marks it expired; shared KnowledgeMap mode has no expired state and leaves it active.
export const TIMEZONE = 'Asia/Shanghai';
export const DEFAULT_TIMES = ['00:00', '08:00', '12:00', '18:00'];
export function localTime(ms) { return new Date(ms + 8 * 3600000).toISOString().slice(0, 19); }
export function normalizeTimes(input) {
  if (!Array.isArray(input) || input.length < 1 || input.length > 24) throw Error('每天需要 1 至 24 个播报时刻；暂停请使用 pause');
  const times = input.map(value => {
    if (value === '24:00') return '00:00';
    if (typeof value !== 'string' || !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value)) throw Error('播报时刻需要 HH:mm（00:00 至 23:59）');
    return value;
  });
  if (new Set(times).size !== times.length) throw Error('播报时刻重复（24:00 与 00:00 相同）');
  return times.sort();
}
export function parseDeadline(value) {
  if (value === null || value === undefined || value === '') return {ddl: null, deadlineMs: null};
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d)?$/.test(value)) throw Error('DDL 需要 YYYY-MM-DD 或 YYYY-MM-DDTHH:mm，Asia/Shanghai');
  const stamp = value.length === 10 ? value + 'T00:00' : value;
  const ms = Date.parse(stamp + ':00+08:00');
  if (!Number.isFinite(ms) || localTime(ms).slice(0, 16) !== stamp) throw Error('DDL 日期不存在');
  return {ddl: value, deadlineMs: ms + (value.length === 10 ? 86400000 : 0)};
}
export function dueSlot(time, now, graceMs = 120000) {
  normalizeTimes([time]);
  let at = Date.parse(localTime(now).slice(0, 10) + 'T' + time + ':00+08:00');
  if (at > now) at -= 86400000;
  if (now - at >= graceMs) return undefined;
  return {key: localTime(at).slice(0, 16), at};
}
