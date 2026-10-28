// Typed query validation and bounded projections; upstream text is never executable policy.
import {ACTIONS, HERO_VIEWS, RESULT_BYTES, codePattern, fail, object, normalize} from './policy.js';
import {digest} from './store.js';
import {text} from './text.js';
import {validateReferenceQuery, validateReferenceData} from './reference.js';
export {text} from './text.js';

export const ATTRIBUTES = ['fire', 'ice', 'wind', 'light', 'dark'];
export const ROLES = ['warrior', 'knight', 'assassin', 'ranger', 'mage', 'manauser'];
export const REVIEW_CATEGORIES = ['RTA', 'PVP', 'PVE', '综合'];
export const BUILD_STATS = Object.freeze({hp: 'health', atk: 'att', def: 'def', spd: 'speed', chc: 'cri', chd: 'cri_dmg', eff: 'acc', efr: 'res'});
const keys = (v, allowed) => {if (!object(v) || Object.keys(v).some(k => !allowed.includes(k))) fail('invalid_query');};
const string = (v, max = 128) => typeof v === 'string' && v.trim().length > 0 && [...v].length <= max;
const id = v => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(v);
export function validateQuery(raw) {
  if (!object(raw) || !ACTIONS.includes(raw.action)) fail('unknown_action');
  const a = {...raw}, fields = {
    search: ['kind', 'query', 'filters', 'limit', 'cursor'], hero: ['heroCode', 'view', 'skill'],
    artifact: ['artifactId', 'view'], dictionary: ['kind', 'query', 'entryId', 'limit', 'cursor'],
    codes: ['server', 'limit'], news: ['kind', 'server', 'limit', 'cursor'],
    builds: ['heroCode', 'filters', 'limit', 'cursor'], reviews: ['heroCode', 'category', 'limit', 'cursor'],
    rankings: ['mode', 'rankingId', 'objectType', 'limit', 'cursor'], content: ['kind', 'mode', 'query', 'contentId', 'limit', 'cursor'],
  };
  keys(a, ['action', ...fields[a.action]]);
  if ('query' in a && (!string(a.query) || !normalize(a.query))) fail('invalid_query');
  if ('limit' in a && (!Number.isInteger(a.limit) || a.limit < 1 || a.limit > 10)) fail('invalid_query');
  if ('cursor' in a && (!string(a.cursor, 256) || !/^[a-zA-Z0-9_-]+$/.test(a.cursor))) fail('invalid_cursor');
  if ('server' in a && !['国服', '国际服'].includes(a.server)) fail('invalid_query');
  if (['rankings', 'content'].includes(a.action)) validateReferenceQuery(a);
  if (['builds', 'reviews'].includes(a.action)) {
    if (typeof a.heroCode !== 'string' || !codePattern.test(a.heroCode)) fail('invalid_query');
    if ('category' in a && !REVIEW_CATEGORIES.includes(a.category)) fail('invalid_query');
    if ('filters' in a) {
      keys(a.filters, ['sets', 'minStats']);
      if (!Object.keys(a.filters).length) fail('invalid_query');
      if ('sets' in a.filters && (!Array.isArray(a.filters.sets) || a.filters.sets.length < 1 || a.filters.sets.length > 3
          || a.filters.sets.some(s => !string(s, 20) || !normalize(s)) || new Set(a.filters.sets.map(normalize)).size !== a.filters.sets.length)) fail('invalid_query');
      if ('minStats' in a.filters) {
        keys(a.filters.minStats, Object.keys(BUILD_STATS));
        if (!Object.keys(a.filters.minStats).length || Object.values(a.filters.minStats).some(v => typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000000)) fail('invalid_query');
      }
    }
  }
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

const listOf = (value, kind) => kind === 'items' ? Object.values(value).flat() : ['gameNews', 'guides', 'faq'].includes(kind) ? value.list : value;
export function validateData(kind, data, params = {}) {
  const invalid = () => fail('invalid_response');
  if (['rankings', 'guides', 'faq'].includes(kind)) return validateReferenceData(kind, data, params);
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
    if (['builds', 'reviews'].includes(kind) && row.hero_code !== params.heroCode) invalid();
    if (kind === 'builds' && (!string(row.name, 200) || (row.set != null && typeof row.set !== 'string')
      || (row.artifact_code != null && row.artifact_code !== '' && (typeof row.artifact_code !== 'string' || !codePattern.test(row.artifact_code)))
      || Object.values(BUILD_STATS).some(k => row[k] != null && row[k] !== '' && numericStat(row[k]) === null))) invalid();
    if (kind === 'reviews' && (!string(row.category, 80) || !string(row.title, 500) || typeof row.content !== 'string')) invalid();
  }
  return data;
}
export const dataCount = (kind, data) => kind === 'hero' ? 1 : listOf(data, kind).length;

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
    : {effect: text(row.skill_display_desc), parameterRanges: ranges,
      effectBasis: {level: null, limitBreak: null, description: '上游只给效果原文与参数上下限，未注明各端点对应的等级/突破；按区间原值表述'}})};
}
export const dictionaryProjection = (row, kind) => kind === 'effect' ? {...effect(row), entryId: String(row.id)}
  : {entryId: String(row.id), key: row.itemKey ?? null, name: text(row.name), category: row.category ?? null,
    description: text(row.description), defaultPrice: row.defaultPrice ?? null, active: row.isActive === 1, valuationBasis: 'E7·WIKI道具估值，不是实时商城价格'};

// Community equipped samples use percentage points, unlike the hero JSON's fractions.
const numericStat = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value
  : typeof value === 'string' && /^\d+(?:\.\d+)?$/.test(value.trim()) && Number.isFinite(Number(value)) ? Number(value) : null;
export function buildProjection(row) {
  return {id: String(row.id), heroCode: row.hero_code, name: text(row.name),
    sets: typeof row.set === 'string' ? row.set.split(/[,，;；]/).map(s => text(s)).filter(Boolean) : [],
    stats: Object.fromEntries(Object.entries(BUILD_STATS).map(([k, source]) => [k, numericStat(row[source])])),
    statBasis: {equipmentIncluded: true, percentUnit: 'percentage_points', level: null, awakening: null,
      description: '社区配装样本面板；百分比字段按百分数点，未推算等级/觉醒或重复加算被动、印记'},
    artifact: row.artifact_code ? {code: row.artifact_code, name: text(row.artifact_name) || null} : null,
    author: text(row.author) || null, remark: text(row.remark), updatedAt: row.updateTime ?? null,
    recommendationBasis: '来源列示的社区样本，不保证最优或适合当前环境'};
}
export const reviewProjection = row => ({id: String(row.id), heroCode: row.hero_code, category: text(row.category),
  title: text(row.title), tier: text(row.tier) || null, content: text(row.content), remark: text(row.remark),
  author: text(row.author) || null, updatedAt: row.updateTime ?? null});
export function matchBuilds(rows, filters = {}) {
  return rows.filter(row => (!filters.sets || filters.sets.every(s => row.sets.some(v => normalize(v) === normalize(s))))
    && Object.entries(filters.minStats ?? {}).every(([k, min]) => row.stats[k] !== null && row.stats[k] >= min));
}

export function pageRows(rows, args, stamp) {
  const {cursor, limit = 5, ...query} = args;
  // Models can reorder JSON fields between calls. Key order is not a query condition.
  const canonical = v => Array.isArray(v) ? v.map(canonical) : object(v)
    ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const fingerprint = digest({query: canonical(query), stamp});
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
        const max = /^(?:id|heroCode|artifactId|entryId|rankingId|contentId|tierId|objectCode|code|url|sourcePage|detailUrl|nextCursor|fetchedAt|upstreamUpdatedAt|hash|key|source|status)$/.test(key) ? 1024 : limit;
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
