// External prose only. No HTML execution, image requests or instruction interpretation.
import {object} from './policy.js';

export const hasImages = value => typeof value === 'string' && /<img\b|!\[[^\]]*\]\(/i.test(value);
function entity(value) {
  const named = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' '};
  return value.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (whole, code) => {
    if (code[0] !== '#') return named[code.toLowerCase()];
    const point = code[1]?.toLowerCase() === 'x' ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return point > 0 && point <= 0x10ffff && !(point >= 0xd800 && point <= 0xdfff) ? String.fromCodePoint(point) : whole;
  });
}
export function text(value, depth = 0) {
  if (depth > 10 || value == null) return '';
  if (Array.isArray(value)) return value.map(v => text(v, depth + 1)).join(value.some(Array.isArray) ? '\n' : '');
  if (object(value)) return typeof value.text === 'string' ? text(value.text, depth + 1) : '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return entity(String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<br\s*\/?\s*>|<\/(?:p|div|h[1-6]|li|tr)\s*>/gi, '\n').replace(/<[^>]*>/g, '')
    .replace(/!\[[^\]]*\]\([^)]*\)/g, '[图片未提取]').replace(/%n/g, '\n'))
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
