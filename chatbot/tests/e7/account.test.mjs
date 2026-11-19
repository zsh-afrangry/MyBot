import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {DatabaseSync} from 'node:sqlite';
import {gzipSync} from 'node:zlib';
import {checkedMetadata, inspectPcap, loadE7BotMetadata, submitAndroidCapture} from '../../plugins/kurumi-e7/account/source.js';
import {projectAccount} from '../../plugins/kurumi-e7/account/projection.js';
import {writeAccountDatabase} from '../../plugins/kurumi-e7/account/storage.js';

const meta = {
  version: 'account-heroes-meta-v6', excludedCharacterIds: ['excluded'],
  equipItems: {sword: {name: '=非公式武器', level: 85, type: 'weapon', xp: 10},
    charm: {name: '测试神器', type: 'artifact', xp: 50, artifactGrade: 3, mainStatGroup: 'atk', mainStatGroup2: 'hp'},
    exclusive: {name: '测试专属', type: 'exclusive'}},
  equipStats: {atk: {att: {valMin: 15, valMax: 15}}, hp: {max_hp: {valMin: 45, valMax: 45}}},
  itemSets: {speed: {name: '速度套装'}}, itemGrade: {1: {need_xp_rate: 1.25}},
  itemEnhance: Object.fromEntries(Array.from({length: 31}, (_, l) => [l, {exp:l + 1, exp_artifact:l + 1, power:1.2 ** l, power_artifact:1 + 0.5 * l}])),
  characters: {hero: {name: '测试英雄', grade: 5, attribute: 'fire', role: 'knight', skillSlots: [{slot: 1, name: '测试技能'}],
    devotionSkill: {type: 'att', grades: {b: 60}}, devotionSkillSelf: {type: 'att_rate', grades: {b: 0.09, sss: 0.18}}}},
  exp: {1: {tier5: 350, tier6: 450}, 2: {tier5: 625, tier6: 775}},
  characterIntimacy: {1: {exp: 5}, 2: {exp: 50}, 3: {exp: 100}}, devotionSkillGrade: {0: {grade: 'Z'}, 3: {grade: 'B'}, 7: {grade: 'SSS'}},
};
const account = {
  units: [{id: '9007199254740999', code: 'hero', g: 6, exp: 350, f: 5, z: 0, s: [0, 1, 2], opt: 21, d: 1},
    {id: 45, code: 'hero', g: 5, exp: 0, f: 0, d: 1, opt: 11}, {id: 46, code: 'excluded'}, {id: 47, code: 'missing-hero'}],
  equips: [{id: 1, code: 'sword', e: 13, g: 1, f: 'speed', p: '9007199254740999', op: [['att', 70], ['speed', 2], ['speed', 3], ['cri', 0.05]]},
    {id: 2, code: 'sword', e: 12, g: 1, p: '9007199254740999', op: [['att', 50]]},
    {id: 3, code: 'charm', g: 1, sk: 1, e: 999999, p: '45'},
    {id: 4, code: 'exclusive', p: 45, op: [['acc', 0.16], ['ek_9', 2]]},
    {id: 5, code: 'missing-equip', p: 46}, {id: 6, code: 'sword', p: 51}, {id: 7, code: 'sword', p: 0}],
};

test('projects account stats and retains every source instance, unresolved link and conflicting slot', () => {
  const {equipment, heroes, summary} = projectAccount(account, meta);
  assert.deepEqual(summary, {equipment: 7, heroes: 4, linked: 5, missingWearer: 1, unknownEquipment: 1, excludedHeroes: 1, unknownHeroes: 1, slotConflicts: 1});
  assert.deepEqual(equipment.map(r => r.enhance), [1, 0, 18, null, null, null, null]);
  assert.deepEqual([equipment[0].mainValue, equipment[0].sub.get('speed'), equipment[0].set], [84, 5, '速度套装']);
  assert.deepEqual([equipment[2].artifactAtk, equipment[2].artifactHp, equipment[3].exclusiveEffect, equipment[3].mainValue], [150, 450, 'ek_9: 2', 0.16]);
  assert.deepEqual(heroes[0].imprint, {rank: 'B', mode: '自身', stat: 'att_rate', value: 0.09});
  assert.deepEqual(heroes[1].imprint, {rank: 'B', mode: '队伍', stat: 'att', value: 60});
  assert.deepEqual([heroes[0].level, heroes[0].intimacy, heroes[0].skills[0].enhance, heroes[0].awakening], [2, 2, 0, 0]);
  assert.deepEqual(heroes[0].worn.get('weapon').map(r => r.id), ['1', '2']);
  assert.equal(heroes[1].worn.get('artifact')[0].id, '3');
  assert.equal(heroes[2].worn.get('other')[0].code, 'missing-equip');
  assert.equal(equipment[5].wearer, '51');
  assert.throws(() => projectAccount({...account, units: [...account.units, {id: '45', code: 'hero'}]}, meta), /重复/u);
  assert.throws(() => projectAccount({...account, units: [{id: 9007199254740999, code: 'hero'}]}, meta), /长编号/u);
  assert.throws(() => projectAccount(account, {...meta, equipStats: {}}), /缺少必要/u);
});

test('source records may omit zero progression or store a defense artifact and surplus imprint copies', () => {
  const {equipment, heroes} = projectAccount({equips: [
    {id: 1, code: 'charm', g: 1, op: [['att', 10], ['def', 7]]},
    {id: 2, code: 'charm', g: 1, e: 999999, op: [['att', 10], ['def', 7]]},
  ], units: [{id: 1, code: 'hero', d: 7, opt: 21}, {id: 2, code: 'hero'}]}, meta);
  assert.deepEqual(equipment.map(r => [r.enhance, r.limitBreak, r.artifactAtk, r.artifactHp, r.artifactDef, r.xp]),
    [[0, 0, 10, null, 7, null], [15, 0, 85, null, 59.5, 999999]]);
  assert.equal(heroes[0].imprintCount, 7);
  assert.deepEqual(heroes[0].imprint, {rank: 'SSS', mode: '自身', stat: 'att_rate', value: 0.18});
  assert.deepEqual([heroes[1].imprint.rank, heroes[1].intimacy, heroes[1].awakening, heroes[1].skills[0].enhance], ['Z', 1, 0, 0]);
});

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
test('metadata accepts only the pinned E7Bot asset path, declared length, digest and schema', async () => {
  const data = gzipSync(JSON.stringify(meta)), digest = sha256(data);
  const asset = {encoding:'gzip', sha256:digest, size:data.length, url:`/api/client/account-heroes/files/${digest}.json.gz`};
  const manifest = {schemaVersion:1, metadata:asset};
  const calls = [];
  const result = await loadE7BotMetadata({fetcher: async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, 'error'); assert.equal(options.credentials, 'omit');
    return url.endsWith('/manifest') ? Response.json(manifest) : new Response(data);
  }});
  assert.equal(result.version, meta.version);
  assert.deepEqual(calls, ['https://e7bot.top/api/client/account-heroes/manifest', 'https://e7bot.top' + asset.url]);
  assert.throws(() => checkedMetadata({...manifest, metadata:{...asset, url:'https://other.invalid/asset'}}, data), /清单/);
  assert.throws(() => checkedMetadata(manifest, Buffer.alloc(data.length)), /SHA-256/);
});

function fakePcap() {
  const bytes = Buffer.alloc(41);
  bytes.writeUInt32LE(0xa1b2c3d4, 0); bytes.writeUInt16LE(2, 4); bytes.writeUInt16LE(4, 6);
  bytes.writeUInt32LE(65535, 16); bytes.writeUInt32LE(101, 20);
  bytes.writeUInt32LE(1700000000, 24); bytes.writeUInt32LE(1, 32); bytes.writeUInt32LE(1, 36);
  return bytes;
}
test('the uploader refuses an unapproved or modified capture before I/O and sends only the bound original', async () => {
  const bytes = fakePcap(), facts = inspectPcap(bytes), digest = sha256(bytes);
  assert.deepEqual(facts, {packetCount:1, startedAt:1700000000, stoppedAt:1700000000, linkType:101, bytes:41, sha256:digest});
  assert.throws(() => inspectPcap(bytes.subarray(0, 40)), /包边界/u);
  const file = {bytes, facts, name: 'synthetic.pcap'};
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push(url);
    assert.equal(options.method, 'POST'); assert.equal(options.credentials, 'omit'); assert.equal(options.redirect, 'error');
    assert.deepEqual(Buffer.from(await options.body.get('file').arrayBuffer()), bytes);
    assert.equal(options.body.get('sha256'), digest);
    assert.equal(options.body.get('file_size'), '41');
    assert.equal(options.body.get('started_at'), '1700000000');
    return Response.json({status: 'parsed', account_data: {sources: account}, ignored: 'not exported'});
  };
  await assert.rejects(submitAndroidCapture(file, 'wrong', {fetcher}), /确认 SHA-256/);
  const changed = Buffer.from(bytes); changed[40] = 5;
  await assert.rejects(submitAndroidCapture({...file, bytes:changed}, digest, {fetcher}), /确认 SHA-256/);
  assert.deepEqual(calls, []);
  assert.deepEqual(await submitAndroidCapture(file, digest, {fetcher}), account);
  assert.deepEqual(calls, ['https://e7bot.top/captures']);
  const exact = await submitAndroidCapture(file, digest, {fetcher: async () => new Response(
    '{"status":"parsed","account_data":{"sources":{"equips":[{"p":9007199254741019}],"units":[{"id":9007199254741019}]}}}')});
  assert.equal(exact.units[0].id, '9007199254741019');
  assert.equal(exact.equips[0].p, exact.units[0].id);
  await assert.rejects(submitAndroidCapture(file, digest, {fetcher: async () => Response.json({status: 'queued'})}), /未返回已解析/);
});

test('the private SQLite snapshot keeps four independently queryable tables and every relationship', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-e7-account-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const out = path.join(dir, 'account.sqlite');
  const projected = projectAccount(account, meta);
  const results = await Promise.all([writeAccountDatabase(out, projected), writeAccountDatabase(out, projected)]);
  assert.deepEqual(results.map(r => r.reused).sort(), [false, true]);
  const expected = {heroes: 4, equipment: 5, exclusive_equipment: 1, artifacts: 1};
  for (const result of results) assert.deepEqual(result.tableCounts, expected);
  assert.equal((await fs.stat(out)).mode & 0o777, 0o600);
  const db = new DatabaseSync(out, {readOnly: true});
  const all = (sql, ...parameters) => db.prepare(sql).all(...parameters).map(row => ({...row}));
  try {
    assert.deepEqual(all("SELECT name FROM sqlite_schema WHERE type='table' ORDER BY name").map(r => r.name), Object.keys(expected).sort());
    for (const [table, count] of Object.entries(expected)) assert.equal(all(`SELECT COUNT(*) AS n FROM ${table}`)[0].n, count);
    assert.deepEqual(all('PRAGMA foreign_key_check'), []);
    assert.deepEqual(all(`SELECT h.instance_id AS hero, e.instance_id AS equipment, e.name, e.main_value,
      json_extract(e.substats_json, '$.speed') AS speed, json_extract(e.substats_json, '$.cri') AS cri
      FROM equipment e JOIN heroes h ON e.hero_instance_id=h.instance_id
      WHERE h.instance_id=? AND e.slot='weapon' ORDER BY e.instance_id`, '9007199254740999'), [
      {hero: '9007199254740999', equipment: '1', name: '=非公式武器', main_value: 84, speed: 5, cri: 0.05},
      {hero: '9007199254740999', equipment: '2', name: '=非公式武器', main_value: 50, speed: null, cri: null},
    ]);
    assert.deepEqual(all("SELECT code, slot, wearer_id, hero_instance_id, catalog_status, link_status FROM equipment WHERE instance_id IN ('5','6','7') ORDER BY instance_id"), [
      {code: 'missing-equip', slot: null, wearer_id: '46', hero_instance_id: '46', catalog_status: 'unknown', link_status: 'linked'},
      {code: 'sword', slot: 'weapon', wearer_id: '51', hero_instance_id: null, catalog_status: 'matched', link_status: 'missing_hero'},
      {code: 'sword', slot: 'weapon', wearer_id: null, hero_instance_id: null, catalog_status: 'matched', link_status: 'unequipped'},
    ]);
    assert.deepEqual(all('SELECT stars, enhance_level, limit_break, attack, health, defense, hero_instance_id FROM artifacts'),
      [{stars: 3, enhance_level: 18, limit_break: 1, attack: 150, health: 450, defense: null, hero_instance_id: '45'}]);
    assert.deepEqual(all('SELECT main_stat, main_value, effect_options, options_json, hero_instance_id FROM exclusive_equipment'),
      [{main_stat: 'acc', main_value: 0.16, effect_options: 'ek_9: 2', options_json: '[["acc",0.16],["ek_9",2]]', hero_instance_id: '45'}]);
    assert.deepEqual(all("SELECT catalog_status, code FROM heroes WHERE instance_id IN ('46','47') ORDER BY instance_id"),
      [{catalog_status: 'excluded', code: 'excluded'}, {catalog_status: 'unknown', code: 'missing-hero'}]);
    assert.deepEqual(all('SELECT skill_1_enhance, awakening, imprint_value FROM heroes WHERE instance_id=?', '9007199254740999'),
      [{skill_1_enhance: 0, awakening: 0, imprint_value: 0.09}]);
  } finally {db.close();}
  const before = await fs.readFile(out);
  assert.equal((await writeAccountDatabase(out, projectAccount({equips: [...account.equips].reverse(), units: account.units}, meta))).reused, true);
  await assert.rejects(writeAccountDatabase(out, projectAccount({equips: [], units: []}, meta)), /另选 SQLite 文件/u);
  assert.deepEqual(await fs.readFile(out), before);
  const link = path.join(dir, 'link.sqlite');
  await fs.symlink(out, link);
  await assert.rejects(writeAccountDatabase(link, projected), /另选 SQLite 文件/u);
  const broken = projectAccount(account, meta);
  broken.equipment[0].wearer = 'does-not-exist';
  await assert.rejects(writeAccountDatabase(path.join(dir, 'invalid.sqlite'), broken), /FOREIGN KEY/u);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['account.sqlite', 'link.sqlite']);
});
