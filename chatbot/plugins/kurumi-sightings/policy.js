export class SightingsError extends Error {
  constructor(code) { super(code); this.code = code; }
}

const fail = code => { throw new SightingsError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const tz = 'Asia/Shanghai';
export const sightingId = /^sighting:[a-f0-9]{32}$/u;

export function shanghaiDay(time) {
  return new Date(time + 8 * 3600_000).toISOString().slice(0, 10);
}

export function listOptions(args = {}, now = Date.now()) {
  if (!object(args) || Object.keys(args).some(key => !['date','limit','offset'].includes(key))) fail('invalid_query');
  const date = args.date === undefined ? shanghaiDay(now) : args.date;
  const limit = args.limit === undefined ? 4 : args.limit;
  const offset = args.offset === undefined ? 0 : args.offset;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date)
    || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 4
    || !Number.isSafeInteger(offset) || offset < 0) fail('invalid_query');
  return {date, timeZone:tz, limit, offset};
}

function canonicalUrl(value) {
  if (typeof value !== 'string' || value.length > 2048) fail('invalid_source');
  let url;
  try { url = new URL(value); } catch { fail('invalid_source'); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port) fail('invalid_source');
  const video = /^\/video\/((?:BV[0-9A-Za-z]{10}|av[1-9]\d{0,19}))\/?$/u.exec(url.pathname);
  const opus = /^\/opus\/([1-9]\d{0,29})\/?$/u.exec(url.pathname);
  const dynamic = /^\/([1-9]\d{0,29})\/?$/u.exec(url.pathname);
  if (url.hostname === 'www.bilibili.com' && video) return `https://www.bilibili.com/video/${video[1]}/`;
  if (url.hostname === 'www.bilibili.com' && opus) return `https://www.bilibili.com/opus/${opus[1]}`;
  if (url.hostname === 't.bilibili.com' && dynamic) return `https://www.bilibili.com/opus/${dynamic[1]}`;
  fail('invalid_source');
}

function publicText(value, maxBytes) {
  if (typeof value !== 'string' || !value.trim()) fail('invalid_source');
  let bytes = 0, text = '';
  for (const character of value.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()) {
    bytes += Buffer.byteLength(character);
    if (bytes > maxBytes) break;
    text += character;
  }
  if (!text) fail('invalid_source');
  return text;
}

// The provider supplies the public page fields; never project browsing context, private text or model commentary.
export function publicPage(page) {
  if (!object(page)) fail('invalid_source');
  return {platform:'bilibili', url:canonicalUrl(page.url), title:publicText(page.title,180), excerpt:publicText(page.excerpt,500)};
}
