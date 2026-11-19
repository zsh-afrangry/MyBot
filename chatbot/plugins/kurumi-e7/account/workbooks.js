import fs from 'node:fs/promises';
import path from 'node:path';
import {SLOTS, STATS, rates} from './projection.js';
import {xlsx} from './xlsx.js';

const column = (title, width, value) => ({title, width, value});
const statName = stat => Object.hasOwn(STATS, stat) ? STATS[stat] : stat;
const displayStat = (stat, value) => value != null && rates.has(stat) ? {percent: true, value} : value;
const textColumn = (title, key, width = 18) => column(title, width, row => row[key]);

const equipmentColumns = [
  textColumn('装备名称', 'name', 34), textColumn('装备实例 ID', 'id', 23), textColumn('原始代码', 'code'),
  column('部位', 16, r => Object.hasOwn(SLOTS, r.slot) ? SLOTS[r.slot] : r.slot), textColumn('套装', 'set', 27),
  textColumn('物品等级', 'itemLevel', 13), textColumn('品质编号', 'quality', 13), textColumn('强化等级', 'enhance', 14),
  textColumn('穿戴英雄', 'wearerName', 24), textColumn('英雄实例 ID', 'wearer', 23), textColumn('穿戴状态', 'link', 18),
  column('主属性', 16, r => statName(r.mainStat)), column('主属性数值', 17, r => displayStat(r.mainStat, r.mainValue)),
  ...Object.entries(STATS).map(([stat, label]) => column('副：' + label, 17, r => displayStat(stat, r.sub.get(stat)))),
  textColumn('神器攻击力', 'artifactAtk', 17), textColumn('神器生命值', 'artifactHp', 17), textColumn('神器防御力', 'artifactDef', 17), textColumn('神器星级', 'artifactStars', 14),
  textColumn('神器突破次数', 'limitBreak', 18), textColumn('专属效果代码与值', 'exclusiveEffect', 30),
  textColumn('图鉴匹配', 'catalog'), textColumn('原始套装代码', 'setCode', 22), textColumn('穿戴英雄代码', 'wearerCode', 22),
  textColumn('强化经验', 'xp', 16), textColumn('原始属性 op', 'options', 46),
];

const slotItems = (row, slot) => row.worn.get(slot)?.map(item => `${item.name ?? item.code} [${item.id}]`).join(' / ');
const heroColumns = [
  textColumn('英雄名称', 'name', 26), textColumn('英雄实例 ID', 'id', 23), textColumn('原始代码', 'code'),
  textColumn('属性', 'attribute', 11), textColumn('职业', 'role', 13), textColumn('当前星级', 'stars', 14),
  textColumn('初始星级', 'initialStars', 14), textColumn('等级', 'level', 12), textColumn('觉醒阶段', 'awakening', 14),
  textColumn('亲密等级', 'intimacy', 14),
  ...[1, 2, 3].flatMap(i => [column(`技能 ${i}`, 26, r => r.skills[i-1].name), column(`技能 ${i} 强化`, 16, r => r.skills[i-1].enhance)]),
  column('刻印档位', 14, r => r.imprint.rank), column('刻印模式', 14, r => r.imprint.mode),
  column('刻印属性', 16, r => statName(r.imprint.stat)), column('刻印效果', 16, r => displayStat(r.imprint.stat, r.imprint.value)),
  column('穿戴数', 12, r => [...r.worn.values()].reduce((sum, items) => sum + items.length, 0)),
  ...Object.entries(SLOTS).map(([slot, title]) => column(title, 36, r => slotItems(r, slot))),
  column('未分部位装备', 35, r => slotItems(r, 'other')), textColumn('图鉴匹配', 'catalog'),
  textColumn('原始经验', 'exp'), textColumn('原始亲密经验', 'intimacyExp', 20), textColumn('原始刻印次数', 'imprintCount', 20),
  textColumn('原始 opt', 'opt'),
];

const definitions = {
  equipment: [
    ['装备实例 ID、装备名称、部位、物品等级', 'equips.id / code；equipItems', '一行对应一个装备实例。图鉴未收录时保留代码。'],
    ['套装、品质编号', 'equips.f / g；itemSets / itemGrade', '套装按原始代码查图鉴。品质保留来源编号。'],
    ['强化等级、强化经验', 'equips.e / sk；itemEnhance / equipItems.xp / itemGrade', '逐级对照累计经验。神器经验或突破未列时按 0；上限为 +15 加每次突破 3 级，最多 +30。'],
    ['主属性、副属性、专属效果', 'equips.op；itemEnhance', '普通装备第一条按强化倍率换算，其余同属性值加总。专属装备保留 ek_ 效果代码和值。'],
    ['神器属性', 'equips.op；equipItems / equipStats / itemEnhance', '属性基础值乘神器强化倍率。优先使用记录中的值；缺少属性列表时取图鉴中固定的基础值。'],
    ['穿戴状态、英雄实例 ID', 'equips.p = units.id', '按实例编号关联。穿戴对象不在英雄来源中时保留其编号。'],
  ],
  heroes: [
    ['英雄实例 ID、英雄名称、职业、属性、初始星级', 'units.id / code；characters', '一行对应一个来源实例。同名英雄各自保留。图鉴排除和图鉴未收录均保留原始代码。'],
    ['等级、当前星级、觉醒阶段', 'units.exp / g / z；exp', '经验按初始星级的表读取，等级上限为当前星级乘 10。'],
    ['亲密等级、技能与强化', 'units.f / s；characterIntimacy / characters.skillSlots', '按亲密经验阈值换算；图鉴已匹配的英雄，省略的亲密经验及技能强化按 0。'],
    ['刻印档位、模式、效果', 'units.d / opt；devotionSkillGrade / characters', '按初始星级换算至 SSS 为止，保留原始次数；opt 十位 0 或 1 用队伍，2 用自身。'],
    ['穿戴数、装备部位', 'equips.p = units.id', '显示装备名和实例 ID。未知部位单列，同部位多件均保留。'],
  ],
};

export function accountWorkbook(kind, account) {
  const equipment = kind === 'equipment';
  const columns = equipment ? equipmentColumns : heroColumns;
  const label = equipment ? '装备明细' : '英雄明细';
  const fields = [
    ['数据来源', '本地选定的 equips / units；E7Bot 图鉴', `图鉴：${account.metadataVersion}。https://e7bot.top/api/client/account-heroes/manifest`],
    ['空值、百分比和编号', '适用于明细各列', '空白表示缺失或不适用，零保留。百分比可直接筛选；实例 ID 作为文本保留全部位数。'],
    ...definitions[kind],
  ];
  return xlsx({name: label, columns, rows: account[kind].map(row => columns.map(c => c.value(row))), filter: true, freezeColumns: 2},
    {name: '字段对照', columns: [{title: '导出字段', width: 39}, {title: '原始字段或图鉴表', width: 43}, {title: '规则及备注', width: 76}], rows: fields, wrap: true});
}

export async function writeAccountWorkbooks(directory, account) {
  const files = ['equipment', 'heroes'].map(kind => [path.join(directory, kind + '.xlsx'), accountWorkbook(kind, account)]);
  await fs.mkdir(directory, {mode: 0o700}); // Refuses existing targets and symlinks.
  const created = [];
  try {
    for (const [file, bytes] of files) {
      const handle = await fs.open(file, 'wx', 0o600);
      created.push(file);
      try {await handle.writeFile(bytes);} finally {await handle.close();}
    }
  } catch (error) {
    for (const file of created) await fs.unlink(file).catch(() => {});
    await fs.rmdir(directory).catch(() => {});
    throw error;
  }
}
