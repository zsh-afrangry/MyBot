// Typed query validation and bounded projections; upstream text is never executable policy.
import {ACTIONS, HERO_VIEWS, RESULT_BYTES, codePattern, fail, object, normalize} from './policy.js';
import {digest} from './store.js';

export const ATTRIBUTES = ['fire', 'ice', 'wind', 'light', 'dark'];
export const ROLES = ['warrior', 'knight', 'assassin', 'ranger', 'mage', 'manauser'];
const keys = (v, allowed) => {if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail('invalid_query');};
const string = (v, max = 128) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max;
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
export function validateQuery(raw) {
  if (!object(raw) || !ACTIONS.includes(raw.action)) fail('unknown_action');
  const a = {...raw}, fields = {
    search: ['kind', 'query', 'filters', 'limit', 'cursor'], hero: ['heroCode', 'view', 'skill'],
    artifact: ['artifactId', 'view'], dictionary: ['kind', 'query', 'entryId', 'limit', 'cursor'],
    codes: ['server', 'limit'], news: ['kind', 'server', 'limit', 'cursor'],
  };
  keys(a, ['action', ...fields[a.action]]);
  if ('query' in a && (!string(a.query) || !normalize(a.query))) fail('invalid_query');
  if ('limit' in a && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 10)) fail('invalid_query');
  if ('cursor' in a && (!string(a.cursor, 256) || !/^[a-zA-Z0-9_-]+$/.test(a.cursor))) fail('invalid_cursor');
  if ('server' in a && !['国服', '国际服'].includes(a.server)) fail('invalid_query');
  if (a.action === 'search') {
    if (!['hero', 'artifact'].includes(a.kind)) fail('invalid_query');
    if (a.filters !== undefined) {
      keys(a.filters, a.kind === 'hero' ? ['attribute', 'role', 'rarity', 'effectIds'] : ['role', 'rarity']);
      if (!Object.keys(a.filters).length) fail('invalid_query');
      if ('attribute' in a.filters && !ATTRIBUTES.includes(a.filters.attribute)) fail('invalid_query');
      if ('role' in a.filters && !ROLES.includes(a.filters.role)) fail('invalid_query');
      if ('rarity' in a.filters && ![3, 4, 5].includes(a.filters.rarity)) fail('invalid_query');
      if ('effectIds' in a.filters && (!Array.isArray(a.filters.effectIds) || !a.filters.effectIds.length || a.filters.effectIds.length > 3 || a.filters.effectIds.some(e => !id(e)))) fail('invalid_query');
    }
    if (!a.query && !a.filters) fail('invalid_query');
  }
  if (a.action === 'hero') {
    if (typeof a.heroCode !== 'string' || !codePattern.test(a.heroCode)) fail('invalid_query');
    a.view ??= 'skills';
    if (!HERO_VIEWS.includes(a.view) || ('skill' in a && (!['skills', 'multipliers'].includes(a.view) || ![1, 2, 3].includes(a.skill)))) fail('invalid_query');
  }
  if (a.action === 'artifact') {
    if (typeof a.artifactId !== 'string' || !/^\d{1,10}$/.test(a.artifactId)) fail('invalid_query');
    a.view ??= 'effect'; if (!['effect', 'stats', 'overview'].includes(a.view)) fail('invalid_query');
  }
  if (a.action === 'dictionary') {
    if (!['effect', 'item'].includes(a.kind) || ('entryId' in a && !id(a.entryId)) || (a.query && a.entryId)) fail('invalid_query');
  }
  if (a.action === 'news' && (!['game', 'wiki_update'].includes(a.kind) || (a.kind === 'wiki_update' && a.server))) fail('invalid_query');
  return a;
}

const listOf = (value, kind) => kind === 'items' ? Object.values(value).flat() : kind === 'gameNews' ? value.list : value;
export function validateData(kind, data, params = {}) {
  const invalid = () => fail('invalid_response');
  if (kind === 'hero') {
    if (!object(data) || data.code !== params.heroCode || !string(data.name, 200) || !Array.isArray(data.skills) || !object(data.stats)) invalid();
    if (data.skills.length > 20 || data.skills.some(s => !object(s) || !string(s.name, 200) || !Number.isInteger(s.slot)
      || ['effects', 'enhancements', 'exclusiveEffects', 'multipliers'].some(k => s[k] != null && !Array.isArray(s[k])))) invalid();
    if (['hp', 'atk', 'def', 'spd'].some(k => !Number.isFinite(data.stats[k]))) invalid();
    return data;
  }
  if (kind === 'items' && (!object(data) || !Object.values(data).every(Array.isArray))) invalid();
  if (kind === 'gameNews' && (!object(data) || !Array.isArray(data.list) || !object(data.pagination)
      || !Number.isInteger(data.pagination.total) || data.pagination.total < data.list.length || data.pagination.page !== (params.page ?? 1)
      || data.pagination.size !== 10 || data.list.length > 10)) invalid();
  const rows = listOf(data, kind);
  if (!Array.isArray(rows) || rows.length > 10000 || (['cards', 'summary', 'artifacts', 'effects', 'items'].includes(kind) && !rows.length)) invalid();
  const seen = new Set();
  for (const row of rows) {
    if (!object(row)) invalid();
    const key = kind === 'summary' ? row.hero_code : kind === 'cards' ? row.code : String(row.id ?? '');
    if (!id(key) || seen.has(key)) invalid(); seen.add(key);
    if (['cards', 'summary'].includes(kind) && (!codePattern.test(key) || !string(row.name, 200))) invalid();
    if (['artifacts', 'effects', 'items'].includes(kind) && !string(row.name, 200)) invalid();
    if (kind === 'codes' && !string(row.code, 200)) invalid();
    if (['gameNews', 'wikiUpdates'].includes(kind) && !string(row.title, 500)) invalid();
  }
  return data;
}
export const dataCount = (kind, data) => kind === 'hero' ? 1 : listOf(data, kind).length;

export function text(value, depth = 0) {
  if (depth > 10 || value == null) return '';
  if (Array.isArray(value)) return value.map(v => text(v, depth + 1)).join(value.some(Array.isArray) ? '\n' : '');
  if (object(value)) return typeof value.text === 'string' ? text(value.text, depth + 1) : '';
  if (typeof value !== 'string' && typeof value !== 'number') return '';
  return String(value).replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>|<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<br\s*\/?\s*>/gi, '\n').replace(/<[^>]*>/g, '').replace(/%n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}
const pick = (v, names) => Object.fromEntries(names.map(k => [k, v?.[k] ?? null]));
const names = row => [row.name, row.name_en, row.nameEn, row.name_zht, row.code, ...(String(row.nicknames ?? '').split(/[,，;；]/))].filter(Boolean);
export function matchRows(rows, query, filters = {}) {
  let found = rows.filter(r => ['attribute', 'role', 'rarity'].every(k => filters[k] === undefined || r[k] === filters[k]));
  if (!query) return {rows: found, match: 'filtered'};
  const q = normalize(query), exact = found.filter(r => names(r).some(n => normalize(n) === q));
  if (exact.length) return {rows: exact, match: 'exact'};
  return {rows: found.filter(r => names(r).some(n => normalize(n).includes(q))), match: 'partial'};
}
export const heroIdentity = hero => ({heroCode: hero.code, ...pick(hero, ['name', 'nameEn', 'attribute', 'role', 'rarity', 'zodiac'])});
export const cardProjection = row => ({heroCode: row.code, ...pick(row, ['name', 'attribute', 'role', 'rarity', 'zodiac'])});
export const artifactIdentity = row => ({artifactId: String(row.id), ...pick(row, ['code', 'name', 'role', 'rarity'])});
const effect = row => ({...pick(row, ['id', 'name', 'type']), description: text(row.description)});
const enhancements = rows => (Array.isArray(rows) ? rows : []).map(row => ({level: row.level, description: text(row.description)}));
const multipliers = rows => (Array.isArray(rows) ? rows : []).map(row => ({...pick(row, ['key', 'label']),
  items: (Array.isArray(row.items) ? row.items : []).map(i => pick(i, ['key', 'label', 'value']))}));

export function heroProjection(hero, args) {
  const identity = heroIdentity(hero), selected = hero.skills.filter(s => !args.skill || s.slot === args.skill);
  const missingFields = [];
  let data;
  if (args.view === 'skills') data = {skills: selected.map(s => ({...pick(s, ['slot', 'name', 'soulGain', 'pointGain', 'pointRequire', 'pointType']),
    description: text(s.description), cooldown: text(s.cooldown),
    soulBurn: s.soulBurn ? {cost: s.soulBurn.cost ?? null, description: text(s.soulBurn.description)} : null,
    effects: (s.effects ?? []).map(effect), ...(args.skill ? {enhancements: enhancements(s.enhancements), exclusiveEffects: (s.exclusiveEffects ?? []).map(s => text(s))} : {})}))};
  if (args.view === 'multipliers') data = {skills: selected.map(s => ({slot: s.slot, name: s.name, groups: multipliers(s.multipliers)}))};
  if (args.view === 'stats') {
    const fractions = ['chc', 'chd', 'dac', 'eff', 'efr'];
    data = {stats: pick(hero.stats, ['hp', 'atk', 'def', 'spd', ...fractions]),
      percentages: Object.fromEntries(fractions.map(k => [k, Number.isFinite(hero.stats[k]) ? Math.round(hero.stats[k] * 10000) / 100 : null])),
      statBasis: {equipmentIncluded: false, level: null, rarityStage: null, awakening: null, description: '角色JSON列示的基础数值；来源未注明等级/觉醒口径，不另加被动、印记或装备'},
      passiveStats: object(hero.passiveStats) ? Object.fromEntries(Object.entries(hero.passiveStats).filter(([k,v]) => /^[a-z_]{1,40}$/.test(k) && ['string', 'number'].includes(typeof v)).slice(0, 30)) : null};
  }
  if (args.view === 'devotion') {
    const devotion = v => v == null ? null : {type: v.type ?? null, grades: pick(v.grades, ['d', 'c', 'b', 'a', 's', 'ss', 'sss', 'z'])};
    data = {team: devotion(hero.devotion), self: devotion(hero.selfDevotion), slot: hero.devotionSlot ?? null};
  }
  if (args.view === 'exclusive') {
    const ee = hero.exclusiveEquipment;
    data = {exclusiveEquipment: ee ? {name: text(ee.name), description: text(ee.description), mainStat: pick(ee.mainStat, ['type', 'min', 'max']),
      skills: (ee.skills ?? []).map(s => ({index: s.index, slot: s.slot, description: text(s.description)}))} : null};
    if (!ee) missingFields.push('exclusiveEquipment');
  }
  if (args.view === 'profile') data = {...pick(hero, ['subtitle', 'limited', 'collaboration', 'collaborationName', 'releaseDate', 'variationGroup']),
    story: text(hero.story), profile: Object.fromEntries(['category', 'dislike', 'hobby', 'like', 'motto', 'specialty'].map(k => [k, text(hero.profile?.[k]) || null])),
    voiceCredits: pick(hero.voice, ['en', 'ja', 'kr', 'zhs']), audioAvailable: false};
  if (args.view === 'overview') data = {...pick(hero, ['limited', 'collaboration', 'collaborationName', 'releaseDate']),
    skills: hero.skills.map(s => ({slot: s.slot, name: s.name})), availableViews: HERO_VIEWS};
  if (!selected.length && ['skills', 'multipliers'].includes(args.view)) missingFields.push('skills');
  return {data: {...identity, view: args.view, ...data}, missingFields};
}

export function artifactProjection(row, view) {
  const baseStats = {atk: row.stat_att ?? null, hp: row.stat_max_hp ?? null, def: row.stat_def ?? null};
  const ranges = [1, 2, 3].map(n => ({parameter: 'ps_refer' + (n === 1 ? '' : n), min: row['skill_min_ps_refer' + (n === 1 ? '' : n)] ?? null,
    max: row['skill_max_ps_refer' + (n === 1 ? '' : n)] ?? null})).filter(r => r.min !== null || r.max !== null);
  return {...artifactIdentity(row), view, ...(view === 'stats' ? {baseStats, statBasis: '站点stat_*原始属性，未给等级口径，不推算满级属性'} : view === 'overview'
    ? {nameEn: row.name_en ?? null, limited: row.limited ?? null, description: text(row.description)}
    : {effect: text(row.skill_display_desc), parameterRanges: ranges})};
}
export const dictionaryProjection = (row, kind) => kind === 'effect' ? {...effect(row), entryId: String(row.id)}
  : {entryId: String(row.id), key: row.itemKey ?? null, name: text(row.name), category: row.category ?? null,
    description: text(row.description), defaultPrice: row.defaultPrice ?? null, active: row.isActive === 1, valuationBasis: 'E7·WIKI道具估值，不是实时商城价格'};

export function pageRows(rows, args, stamp) {
  const {cursor, limit = 5, ...query} = args;
  const fingerprint = digest({query, stamp});
  let offset = 0;
  if (cursor) {
    let c; try {c = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));} catch {fail('invalid_cursor');}
    if (!object(c) || c.f !== fingerprint || !Number.isInteger(c.o) || c.o < 0 || c.o >= rows.length) fail('cursor_expired');
    offset = c.o;
  }
  const items = rows.slice(offset, offset + limit);
  return {items, total: rows.length, nextCursor: offset + items.length < rows.length ? Buffer.from(JSON.stringify({f: fingerprint, o: offset + items.length})).toString('base64url') : null};
}

// Preserve structural facts and IDs; shorten only prose. The enclosing plugin adds the host's untrusted boundary.
export function boundResult(result) {
  for (const limit of [8000, 4000, 2000, 1000, 500, 250, 100, 32]) {
    let truncated = false;
    const walk = (v, key = '', depth = 0) => {
      if (depth > 12) {truncated = true; return null;}
      if (typeof v === 'string') {
        const max = /^(?:heroCode|artifactId|entryId|code|url|nextCursor|fetchedAt|upstreamUpdatedAt|hash|key|source|status)$/.test(key) ? 1024 : limit;
        if ([...v].length <= max) return v;
        truncated = true; const prefix = [...v].slice(0, max).join('');
        const paragraph = prefix.lastIndexOf('\n'); return (paragraph > max / 2 ? prefix.slice(0, paragraph) : prefix) + '…';
      }
      if (Array.isArray(v)) {if (v.length > 40) truncated = true; return v.slice(0, 40).map(x => walk(x, key, depth + 1));}
      if (object(v)) return Object.fromEntries(Object.entries(v).map(([k,x]) => [k, walk(x, k, depth + 1)]));
      return v;
    };
    const out = walk(result); out.truncated = result.truncated === true || truncated;
    if (Buffer.byteLength(JSON.stringify(out)) <= RESULT_BYTES - 2048) return out;
  }
  fail('result_too_large');
}
