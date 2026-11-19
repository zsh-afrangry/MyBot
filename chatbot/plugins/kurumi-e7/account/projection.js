// The E7Bot account-heroes v6 projection. Account identities are instance IDs, not catalog codes.
export class AccountExportError extends Error {}
const invalid = message => {throw new AccountExportError(message);};
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const entry = (table, key) => table && key != null && Object.hasOwn(table, key) ? table[key] : undefined;
const codePattern = /^[A-Za-z0-9_-]{1,80}$/u;
const key = value => typeof value === 'string' && codePattern.test(value) ? value : null;
const id = value => Number.isSafeInteger(value) && value > 0 ? String(value) : key(value);
const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null;
const uint = value => Number.isSafeInteger(value) && value >= 0 ? value : null;
const positive = value => num(value) > 0 ? value : null;
const precision = value => num(value) === null ? null : Number(value.toFixed(9));
const text = value => typeof value === 'string' && value.length ? value : null;

export const SLOTS = Object.freeze({weapon: '武器', helm: '头盔', armor: '铠甲', neck: '项链', ring: '戒指', boot: '鞋子', artifact: '神器', exclusive: '专属装备'});
export const STATS = Object.freeze({att: '攻击力', att_rate: '攻击力%', def: '防御力', def_rate: '防御力%', max_hp: '生命值',
  max_hp_rate: '生命值%', speed: '速度', cri: '暴击率', cri_dmg: '暴击伤害', acc: '效果命中', res: '效果抗性'});
export const rates = new Set(['att_rate', 'def_rate', 'max_hp_rate', 'cri', 'cri_dmg', 'acc', 'res']);
const ROLE = {knight:'骑士', warrior:'战士', assassin:'盗贼', ranger:'射手', mage:'魔导士', manauser:'精灵师'};
const ATTRIBUTE = {fire:'火', ice:'冰', wind:'自然', light:'光', dark:'暗'};

function indexRows(rows, label) {
  if (!Array.isArray(rows) || rows.length > 20000) invalid(`${label}需要是最多 20,000 条记录的数组`);
  const result = new Map();
  for (const [index, row] of rows.entries()) {
    const rowId = record(row) ? id(row.id) : null;
    if (!rowId || rowId === '0' || !key(row.code)) invalid(`${label}第 ${index + 1} 条实例 ID 或原始代码无效；长编号请用字符串`);
    if (result.has(rowId)) invalid(`${label}第 ${index + 1} 条实例 ID 重复`);
    result.set(rowId, row);
  }
  return result;
}

function levelFor(earned, cap, nextThreshold, first = 1) {
  if (earned === null || cap === null || cap < first) return null;
  let previous = -1;
  for (let level = first; level < cap; level++) {
    const threshold = nextThreshold(level);
    if (threshold == null || !Number.isFinite(threshold) || threshold < previous) return null;
    if (earned < threshold) return level;
    previous = threshold;
  }
  return cap;
}

function imprint(row, character, metadata) {
  const count = row.d === undefined ? 0 : uint(row.d), initialStars = uint(character?.grade), rawOpt = uint(row.opt);
  if (count === null || initialStars === null || initialStars < 3 || initialStars > 5) return {};
  if (count === 0) return {rank: 'Z'};
  const rank = text(entry(metadata.devotionSkillGrade, Math.min(7, count + initialStars - 3))?.grade);
  const tens = rawOpt === null ? null : Math.floor(rawOpt / 10) % 10;
  // Observed v6 records encode 01/11 as release and 21 as concentration. Leave unfamiliar codes blank.
  const mode = tens === 0 || tens === 1 ? '队伍' : tens === 2 ? '自身' : null;
  const effect = mode === '自身' ? character.devotionSkillSelf : mode === '队伍' ? character.devotionSkill : null;
  return {rank, mode, stat: key(effect?.type), value: num(entry(effect?.grades, rank?.toLowerCase()))};
}

function projectUnit(unitId, row, metadata, excluded, intimacyCap) {
  const character = entry(metadata.characters, row.code), initialStars = uint(character?.grade), stars = uint(row.g);
  const exp = uint(row.exp), intimacyExp = uint(row.f);
  const xpLevel = level => num(entry(metadata.exp, level)?.[`tier${initialStars}`]);
  const skills = Array.isArray(character?.skillSlots) ? character.skillSlots : [];
  return {id: unitId, code: row.code, name: text(character?.name),
    catalog: excluded.has(row.code) ? '图鉴排除' : character ? '已匹配' : '图鉴未收录',
    attribute: entry(ATTRIBUTE, character?.attribute) ?? key(character?.attribute), role: entry(ROLE, character?.role) ?? key(character?.role),
    stars, initialStars, exp, level: levelFor(exp, initialStars > 0 && initialStars <= 6 && stars > 0 && stars <= 6 ? stars * 10 : null, xpLevel),
    awakening: character && row.z === undefined ? 0 : uint(row.z), intimacyExp,
    intimacy: levelFor(character && row.f === undefined ? 0 : intimacyExp, intimacyCap, lv => num(entry(metadata.characterIntimacy, lv)?.exp)),
    skills: [1, 2, 3].map(slot => {
      const name = text(skills.find(skill => skill?.slot === slot)?.name);
      const enhance = name && (row.s === undefined || (Array.isArray(row.s) && slot > row.s.length)) ? 0
        : Array.isArray(row.s) ? uint(row.s[slot-1]) : null;
      return {name, enhance};
    }),
    imprint: imprint(row, character, metadata), imprintCount: uint(row.d), opt: uint(row.opt), worn: new Map(),
  };
}

function options(raw) {
  if (!Array.isArray(raw) || raw.length > 100) return null;
  const rows = raw.map(value => Array.isArray(value) ? value : record(value) ? [value.stat ?? value.type, value.value] : []);
  return rows.every(([stat, value]) => key(stat) && (/^ek_/u.test(stat) ? (key(value) || uint(value) !== null) : num(value) !== null)) ? rows : null;
}

function artifactBase(metadata, group, stat) {
  const row = entry(entry(metadata.equipStats, group), stat);
  return row?.valMin === row?.valMax ? num(row?.valMin) : null;
}

function artifactAttributes(metadata, item, op, power) {
  if (!item || power === null) return {};
  return Object.fromEntries(['att', 'max_hp', 'def'].map(stat => {
    const recorded = op?.find(([name]) => name === stat)?.[1];
    const base = op?.length ? recorded ?? null : artifactBase(metadata, item.mainStatGroup, stat) ?? artifactBase(metadata, item.mainStatGroup2, stat);
    return [stat, base == null ? null : precision(base * power)];
  }));
}

function projectEquipment(equipId, row, metadata, units) {
  const item = entry(metadata.equipItems, row.code), slot = key(item?.type), artifact = slot === 'artifact';
  const wearer = row.p == null || row.p === '' || row.p === 0 || row.p === '0' ? null : id(row.p);
  if (row.p && row.p !== '0' && wearer === null) invalid('装备的穿戴对象实例 ID 无效');
  const unit = wearer && units.get(wearer), xp = uint(row.e), quality = uint(row.g), limitBreak = artifact ? row.sk === undefined ? 0 : uint(row.sk) : null;
  const rate = positive(entry(metadata.itemGrade, quality)?.need_xp_rate), itemXp = positive(item?.xp);
  const enhancementCap = artifact ? limitBreak === null ? null : Math.min(30, 15 + 3 * limitBreak) : 15;
  const enhanceable = Object.hasOwn(SLOTS, slot) && slot !== 'exclusive';
  const enhance = enhanceable && rate && itemXp ? levelFor(artifact && row.e === undefined ? 0 : xp, enhancementCap, level => {
    const coefficient = positive(entry(metadata.itemEnhance, level)?.[artifact ? 'exp_artifact' : 'exp']);
    return coefficient === null ? null : Math.floor(coefficient * itemXp * rate + 0.5);
  }, 0) : null;
  const power = positive(entry(metadata.itemEnhance, enhance)?.[artifact ? 'power_artifact' : 'power']);
  const op = options(row.op), [mainStat, base] = !artifact && slot !== 'exclusive' ? op?.[0] ?? [] : [];
  const sub = new Map();
  if (enhanceable && !artifact) for (const [stat, value] of op?.slice(1) ?? []) {
    if (num(value) !== null && !stat.startsWith('ek_')) sub.set(stat, (sub.get(stat) ?? 0) + value);
  }
  const exclusiveStat = slot === 'exclusive' ? op?.find(([stat]) => Object.hasOwn(STATS, stat)) : null;
  const exclusiveEffect = slot === 'exclusive' ? op?.filter(([stat]) => stat.startsWith('ek_')).map(([stat, value]) => `${stat}: ${value}`).join(' / ') : null;
  const artifactStats = artifact ? artifactAttributes(metadata, item, op, power) : {};
  const equip = {id: equipId, code: row.code, name: text(item?.name), catalog: item ? '已匹配' : '图鉴未收录', slot,
    setCode: key(row.f), set: text(entry(metadata.itemSets, key(row.f))?.name), itemLevel: uint(item?.level), quality, xp, enhance,
    artifactStars: uint(item?.artifactGrade), limitBreak, wearer, wearerCode: unit?.code, wearerName: unit?.name,
    link: unit ? '已关联' : wearer ? '缺少英雄实例' : '未穿戴', mainStat: mainStat ?? exclusiveStat?.[0],
    mainValue: exclusiveStat ? exclusiveStat[1] : power !== null && num(base) !== null ? precision(base * power) : null,
    sub, exclusiveEffect, artifactAtk: artifactStats.att, artifactHp: artifactStats.max_hp, artifactDef: artifactStats.def,
    options: row.op === undefined ? null : JSON.stringify(row.op),
  };
  if (unit) {
    const bucket = Object.hasOwn(SLOTS, slot) ? slot : 'other';
    if (!unit.worn.has(bucket)) unit.worn.set(bucket, []);
    unit.worn.get(bucket).push(equip);
  }
  return equip;
}

export function projectAccount({equips, units}, metadata) {
  const maps = ['equipItems', 'equipStats', 'itemSets', 'itemEnhance', 'itemGrade', 'characters', 'exp', 'characterIntimacy', 'devotionSkillGrade'];
  if (metadata?.version !== 'account-heroes-meta-v6' || maps.some(k => !record(metadata[k]) || !Object.keys(metadata[k]).length)
    || !Array.isArray(metadata.excludedCharacterIds) || metadata.excludedCharacterIds.some(code => !key(code))) invalid('E7Bot v6 图鉴缺少必要的查询表');
  const rawUnits = indexRows(units, '英雄'), rawEquipment = indexRows(equips, '装备');
  const excluded = new Set(metadata.excludedCharacterIds), intimacyCap = Math.max(1, ...Object.keys(metadata.characterIntimacy).map(Number).filter(lv => lv > 0 && lv <= 100));
  const heroIndex = new Map([...rawUnits].map(([k, v]) => [k, projectUnit(k, v, metadata, excluded, intimacyCap)]));
  const equipment = [...rawEquipment].map(([k, v]) => projectEquipment(k, v, metadata, heroIndex));
  const heroes = [...heroIndex.values()];
  const summary = {equipment: equipment.length, heroes: heroes.length,
    linked: equipment.filter(row => row.link === '已关联').length, missingWearer: equipment.filter(row => row.link === '缺少英雄实例').length,
    unknownEquipment: equipment.filter(row => row.catalog !== '已匹配').length,
    excludedHeroes: heroes.filter(row => row.catalog === '图鉴排除').length,
    unknownHeroes: heroes.filter(row => row.catalog === '图鉴未收录').length,
    slotConflicts: heroes.reduce((n, hero) => n + [...hero.worn].filter(([slot, items]) => slot !== 'other' && items.length > 1).length, 0),
  };
  return {equipment, heroes, summary, metadataVersion: metadata.version};
}
