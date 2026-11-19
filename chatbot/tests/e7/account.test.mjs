import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {checkedMetadata, inspectPcap, loadE7BotMetadata, submitAndroidCapture} from '../../plugins/kurumi-e7/account/source.js';
import {projectAccount} from '../../plugins/kurumi-e7/account/projection.js';
import {writeAccountWorkbooks} from '../../plugins/kurumi-e7/account/workbooks.js';

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

test('the two private workbooks reopen as XLSX with intact text IDs, numeric attributes, filters and every relationship', async t => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'kurumi-e7-account-'));
  t.after(() => fs.rm(dir, {recursive:true, force:true}));
  const out = path.join(dir, 'new');
  const projected = projectAccount(account, meta);
  await writeAccountWorkbooks(out, projected);
  assert.equal((await fs.stat(out)).mode & 0o777, 0o700);
  for (const book of ['equipment.xlsx', 'heroes.xlsx']) assert.equal((await fs.stat(path.join(out, book))).mode & 0o777, 0o600);
  await assert.rejects(writeAccountWorkbooks(out, projected), {code: 'EEXIST'});
  const check = spawnSync('/usr/bin/python3', ['-c', `
from pathlib import Path
from xml.etree import ElementTree as E
from zipfile import ZipFile
import sys
ns = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'}
def validate(filename, first_sheet, rowcount):
    with ZipFile(Path(sys.argv[1]) / filename) as z:
        assert z.testzip() is None
        wb = E.fromstring(z.read('xl/workbook.xml'))
        assert [s.attrib['name'] for s in wb.findall('.//s:sheet', ns)] == [first_sheet, '字段对照']
        sheet = E.fromstring(z.read('xl/worksheets/sheet1.xml'))
        assert sheet.find('s:autoFilter', ns).attrib['ref'].endswith(str(rowcount + 1))
        assert sheet.find('.//s:pane', ns).attrib['state'] == 'frozen'
        assert len(sheet.findall('.//s:row', ns)) == rowcount + 1
        assert not sheet.findall('.//s:f', ns)
        return sheet
def cell(sheet, addr): return sheet.find(f'.//s:c[@r="{addr}"]', ns)
def text(sheet, addr): return cell(sheet, addr).find('.//s:t', ns).text
def number(sheet, addr): return float(cell(sheet, addr).find('s:v', ns).text)
e = validate('equipment.xlsx', '装备明细', 7)
h = validate('heroes.xlsx', '英雄明细', 4)
assert text(e, 'A2') == '=非公式武器'
assert text(e, 'J2') == text(h, 'B2') == '9007199254740999'
assert number(e, 'M2') == 84 and number(e, 'T2') == 5
assert number(e, 'U2') == .05 and cell(e, 'U2').attrib['s'] == '2'
assert text(h, 'V2').endswith('[1] / =非公式武器 [2]')
assert '测试神器 [3]' == text(h, 'AB3')
assert text(h, 'AD4') == 'missing-equip [5]'
`, out], {encoding:'utf8'});
  assert.equal(check.status, 0, check.stderr || String(check.error));
});
