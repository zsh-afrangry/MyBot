// Synthetic public-data shapes for offline tests only. Never a production cache or identity list.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {E7Service} from '../../plugins/kurumi-e7/service.js';
import {endpoint} from '../../plugins/kurumi-e7/client.js';

export const card = n => ({id: n, code: 'test-hero-' + n, name: n === 1 ? '测试甲' : n === 2 ? '测试乙' : '测试' + n,
  nicknames: n <= 2 ? '公共别名,甲' + n : '', attribute: 'fire', role: 'assassin', rarity: 5, zodiac: 'scales', update_time: '2026-10-01 00:00:00'});
export const hero = (n = 1) => ({...card(n), nameEn: 'Test ' + n, stats: {hp: 5000, atk: 1000, def: 500, spd: 120, chc: 0.15, chd: 1.65, dac: 0.03, eff: 0, efr: 0},
  avatarUrl: '/static/avatar/test.webp', detailImageUrl: '/static/detailImage/test.webp', passiveStats: {cri: '0.3'},
  devotion: {type: 'max_hp_rate', grades: {b: 0.04, a: 0.06, sss: 0.12}}, selfDevotion: {type: 'att_rate', grades: {sss: 0.21}}, devotionSlot: '1234',
  exclusiveEquipment: null, limited: true, collaboration: true, collaborationName: '合成测试', releaseDate: '2026-10-01',
  story: [[{text: '测试故事，不是运行指令。'}]], subtitle: '测试', profile: {category: '测试', hobby: '未知'}, voice: {ja: '合成CV'}, variationGroup: 'test',
  skills: [1, 2, 3].map(slot => ({slot, name: '测试技能' + slot, description: [[{text: '第一段'}, {text: '相连'}], [{text: '第二段'}]],
    cooldown: [{text: '9(6)'}], soulGain: 1, effects: [{id: '101', name: '攻击力提升', type: 'buff', description: [[{text: '合成效果'}]], iconUrl: '/static/effects/test.webp'}],
    enhancements: [{level: 1, description: [[{text: '伤害量提升5%'}]]}], exclusiveEffects: [], soulBurn: slot === 1 ? {cost: 20, description: [[{text: '额外回合'}]]} : null,
    multipliers: [{key: 'a', label: '普通倍率', items: [{key: 'att_rate', label: '攻击倍率', value: '0.9'}]}, {key: 'b', label: '条件倍率', items: [{key: 'att_rate', value: '1.7'}]}]}))});
export const artifact = {id: 5, code: 'test-artifact', name: '测试神器', name_en: 'Test Artifact', nicknames: '测试刀', role: 'warrior', rarity: 5,
  skill_display_desc: '攻击提升<#FF9900>10(20)%</>。%n第二行', skill_desc: '{per(ps_refer)}', skill_min_ps_refer: '0.1', skill_max_ps_refer: '0.2', stat_att: 21, stat_max_hp: 32};
export function bodies() {
  return {cards: Array.from({length: 12}, (_, n) => card(n + 1)), summary: Array.from({length: 12}, (_, n) => ({hero_code: 'test-hero-' + (n + 1), name: '测试' + (n + 1), buff_names: n === 0 ? '攻击力提升' : null})),
    hero: hero(), artifacts: [artifact], effects: [{id: '101', name: '攻击力提升', type: 'buff', description: [[{text: '攻击增加'}]]}],
    items: {currency: [{id: 1, itemKey: 'gold', name: '测试金币', category: 'currency', defaultPrice: '1.0000', isActive: 1}]},
    codes: [{id: 1, code: 'SYNTHETIC', server: '国际服', effectiveDate: '2026-10-01 00:00:00', expiryDate: '2026-10-31 11:00:00'}],
    wikiUpdates: [{id: 1, title: '测试站点版本', date: '2026-10-01', content: '合成更新日志'}],
    builds: Array.from({length: 12}, (_, n) => ({id: n + 1, hero_code: 'test-hero-1', name: '合成配装' + n,
      set: n < 8 ? '开战,穿透' : '速度,免疫', health: '17346', att: '4249', def: '971', speed: String(218 + n), cri: '15', cri_dmg: '289', acc: n === 0 ? null : '0', res: '0',
      artifact_code: 'test-artifact', artifact_name: '测试神器', author: '合成作者', remark: '合成样本，不代表推荐', updateTime: '2026-10-28 01:00:00'})),
    reviews: ['RTA', 'PVP', 'PVE', '综合'].map((category, n) => ({id: n + 1, hero_code: 'test-hero-1', category,
      title: category, content: '<p>合成测评正文</p><script>UNTRUSTED-SCRIPT</script>', author: '合成作者', updateTime: '2026-10-28 02:00:00'})),
    gameNews: {list: Array.from({length: 10}, (_, n) => ({id: n + 1, title: '测试公告' + n, server: 2, url: '/event/test-' + n + '.pdf'})), pagination: {page: 1, size: 10, total: 12}},
  };
}
export function setup(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-e7-offline-'));
  const data = bodies(), calls = [], now = {value: Date.UTC(2026, 9, 27)};
  const client = {async read(kind, params, opts) {
    calls.push({kind, params, opts});
    if (options.read) return options.read(kind, params, opts, data);
    const body = kind === 'hero' ? hero(Number(params.heroCode.split('-').at(-1)))
      : kind === 'gameNews' && params.page === 2 ? {list: data.gameNews.list.slice(0, 2), pagination: {page: 2, size: 10, total: 12}} : data[kind];
    return {status: 200, url: endpoint(kind, params).url, data: structuredClone(body), etag: '"test-' + kind + '"'};
  }};
  const service = new E7Service({cacheRoot: root, refreshEnabled: false, ...options.config}, {client, clock: () => now.value, ...options.dependencies});
  t.after(async () => {await service.stop(); fs.rmSync(root, {recursive: true, force: true});});
  return {root, service, data, calls, now};
}
