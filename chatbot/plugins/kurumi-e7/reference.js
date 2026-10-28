// Pure contracts/projections for rankings and paged public articles. No HTTP or cache IO.
import {object, codePattern, fail} from './policy.js';
import {digest} from './store.js';
import {text, hasImages} from './text.js';

const stableId = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
const short = (v, max = 500) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max;
const numericId = v => typeof v === 'string' && /^\d{1,10}$/.test(v);
export function validateReferenceQuery(a) {
  if (a.action === 'rankings') {
    if (a.mode === undefined) a.mode = 'list';
    if (!['list', 'get'].includes(a.mode) || ('objectType' in a && !['hero', 'artifact'].includes(a.objectType))
      || (a.mode === 'get' ? !numericId(a.rankingId) : 'rankingId' in a)) fail('invalid_query');
  }
  if (a.action === 'content') {
    if (a.mode === undefined) a.mode = 'search';
    if (!['guide', 'faq'].includes(a.kind) || !['search', 'get'].includes(a.mode)) fail('invalid_query');
    if (a.mode === 'get' ? !numericId(a.contentId) || ['query', 'limit', 'cursor'].some(k => k in a) : 'contentId' in a) fail('invalid_query');
    if (a.query) a.query = a.query.trim();
  }
}

export function validateReferenceData(kind, data, params) {
  const invalid = () => fail('invalid_response');
  const rows = kind === 'rankings' ? data : data?.list;
  if (!Array.isArray(rows) || rows.length > (kind === 'rankings' ? 500 : 10)) invalid();
  if (kind !== 'rankings') {
    const p = data.pagination;
    if (!object(p) || p.page !== (params.page ?? 1) || p.size !== 10 || !Number.isInteger(p.total)
      || p.total < 0 || (rows.length && p.total < (p.page - 1) * 10 + rows.length)) invalid();
  }
  const ids = new Set();
  for (const row of rows) {
    if (!object(row) || !numericId(String(row.id ?? '')) || ids.has(String(row.id))) invalid();
    ids.add(String(row.id));
    if (kind === 'rankings') {
      if (!short(row.title) || !Array.isArray(row.tiers) || row.tiers.length > 40 || !Array.isArray(row.heroAssignments)
        || row.heroAssignments.length > 10000 || (row.type != null && !short(row.type, 80))) invalid();
      const tiers = new Set();
      for (const tier of row.tiers) {
        if (!object(tier) || !stableId(tier.id) || tiers.has(tier.id) || !short(tier.name, 200)
          || (tier.order != null && !Number.isFinite(tier.order))) invalid();
        tiers.add(tier.id);
      }
      const assignments = new Set();
      for (const entry of row.heroAssignments) {
        if (!object(entry) || !tiers.has(entry.tierId) || typeof entry.heroCode !== 'string' || !codePattern.test(entry.heroCode)) invalid();
        const key = entry.tierId + ':' + entry.heroCode;
        if (assignments.has(key)) invalid(); assignments.add(key);
      }
    } else if (kind === 'guides') {
      if (!short(row.title) || (row.content != null && typeof row.content !== 'string')) invalid();
    } else if (!short(row.question, 2000) || ['answer', 'analysis'].some(k => row[k] != null && typeof row[k] !== 'string')) invalid();
  }
  return data;
}

function labels(value) {
  if (value == null || value === '') return [];
  let values = value;
  if (typeof value === 'string') {try {values = JSON.parse(value);} catch {return null;}}
  return Array.isArray(values) && values.length <= 40 && values.every(v => typeof v === 'string') ? values.map(v => text(v)) : null;
}
export const rankingIdentity = row => ({rankingId: String(row.id), title: text(row.title), description: text(row.description),
  objectType: ['hero', 'artifact'].includes(row.type) ? row.type : null, sourceObjectType: text(row.type) || null,
  tags: labels(row.tags), author: text(row.author) || null, updatedAt: text(row.updateTime) || null,
  tierCount: row.tiers.length, entryCount: row.heroAssignments.length});
export const rankingTiers = row => row.tiers.map(t => ({tierId: t.id, name: text(t.name), description: text(t.description), order: t.order ?? null}));
export const rankingEntries = row => row.heroAssignments.map(e => ({tierId: e.tierId, objectCode: e.heroCode, note: text(e.note)}));

export function contentProjection(row, kind, full = false) {
  const images = hasImages(row.content) || hasImages(row.answer) || hasImages(row.analysis);
  const summary = text(kind === 'guide' ? row.summary : row.answer);
  const result = {contentId: String(row.id), kind, title: text(kind === 'guide' ? row.title : row.question),
    summary: [...summary].slice(0, 360).join(''), summaryTruncated: [...summary].length > 360, tags: labels(row.tags),
    author: text(row.author) || null, updatedAt: text(row.updateTime) || null,
    sourcePage: 'https://e7.wiki/' + (kind === 'guide' ? 'guides' : 'faq'), detailUrl: null,
    imageDependency: images, imagesExtracted: false};
  if (kind === 'guide') result.categories = labels(row.category);
  if (full) {
    if (kind === 'guide') result.content = text(row.content);
    else Object.assign(result, {question: text(row.question), answer: text(row.answer), analysis: text(row.analysis)});
  }
  return result;
}

const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
  ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
export function queryFingerprint(args) {
  const {cursor, limit, ...query} = args;
  return digest(canonical(query));
}
export function contentCursor(args) {
  const f = queryFingerprint(args);
  if (!args.cursor) return {f, p: 1, o: 0, h: null};
  let c; try {c = JSON.parse(Buffer.from(args.cursor, 'base64url').toString('utf8'));} catch {fail('invalid_cursor');}
  if (!object(c) || Object.keys(c).sort().join(',') !== 'f,h,o,p' || !Number.isInteger(c.p) || c.p < 1 || c.p > 1000
    || !Number.isInteger(c.o) || c.o < 0 || c.o >= 10 || (c.h !== null && (typeof c.h !== 'string' || !/^[a-f0-9]{64}$/.test(c.h)))
    || (c.h === null && c.o !== 0)) fail('invalid_cursor');
  if (c.f !== f) fail('cursor_expired');
  return c;
}
export function contentPage(record, args, cursor) {
  if ((cursor.h !== null && cursor.h !== record.hash) || (cursor.o > 0 && cursor.o >= record.data.list.length)) fail('cursor_expired');
  const rows = record.data.list.slice(cursor.o, cursor.o + (args.limit ?? 5));
  let next = null;
  if (cursor.o + rows.length < record.data.list.length) next = {...cursor, o: cursor.o + rows.length, h: record.hash};
  else if (rows.length && cursor.p * 10 < record.data.pagination.total && cursor.p < 1000) next = {...cursor, p: cursor.p + 1, o: 0, h: null};
  return {items: rows.map(row => contentProjection(row, args.kind)), total: record.data.pagination.total,
    nextCursor: next ? Buffer.from(JSON.stringify(next)).toString('base64url') : null,
    coverage: '按来源关键词及分页读取；不是完整离线全站索引', page: cursor.p, paginationCapped: cursor.p === 1000 && cursor.p * 10 < record.data.pagination.total};
}
