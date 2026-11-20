// Pure values shared by the domain store and execution boundary.
import {createHash} from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const fail = code => Object.assign(Error(code), {code});
export function taskText(text) {
  if (typeof text !== 'string' || !text.trim() || text.length > 8000) throw fail('invalid_coding_task');
  return text;
}
export function taskTitle(value) {
  if (value === undefined) return;
  if (typeof value !== 'string' || value.length > 96 || /[\u0000-\u001f\u007f\u2028\u2029]/.test(value) || !value.trim()) throw fail('invalid_coding_task_title');
  return value.trim();
}
