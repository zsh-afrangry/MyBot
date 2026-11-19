import fs from 'node:fs/promises';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';
import {AccountExportError} from './projection.js';

const APPLICATION_ID = 0x4b453741; // KE7A: Kurumi E7 account snapshots
const VERSION = 1;
const identity = [
  ['instance_id', 'TEXT PRIMARY KEY NOT NULL', 'id'], ['code', 'TEXT NOT NULL'], ['name', 'TEXT'],
  ['catalog_status', 'TEXT NOT NULL', r => ({已匹配: 'matched', 图鉴排除: 'excluded', 图鉴未收录: 'unknown'})[r.catalog]],
];
const item = [...identity,
  ['slot', 'TEXT'], ['item_level', 'INTEGER', 'itemLevel'], ['quality', 'INTEGER'],
  ['set_code', 'TEXT', 'setCode'], ['set_name', 'TEXT', 'set'], ['enhance_xp', 'INTEGER', 'xp'],
  ['wearer_id', 'TEXT', 'wearer'], ['hero_instance_id', 'TEXT REFERENCES heroes(instance_id)', r => r.link === '已关联' ? r.wearer : null],
  ['options_json', 'TEXT CHECK (json_valid(options_json) OR options_json IS NULL)', 'options'],
];
const mainStat = [['main_stat', 'TEXT', 'mainStat'], ['main_value', 'REAL', 'mainValue']];
const enhanceLevel = ['enhance_level', 'INTEGER', 'enhance'];
const fields = {
  heroes: [...identity, ['attribute', 'TEXT'], ['role', 'TEXT'], ['stars', 'INTEGER'], ['initial_stars', 'INTEGER', 'initialStars'],
    ['level', 'INTEGER'], ['exp', 'INTEGER'], ['awakening', 'INTEGER'], ['intimacy', 'INTEGER'], ['intimacy_exp', 'INTEGER', 'intimacyExp'],
    ...[1, 2, 3].flatMap(slot => [[`skill_${slot}_name`, 'TEXT', r => r.skills[slot - 1].name],
      [`skill_${slot}_enhance`, 'INTEGER', r => r.skills[slot - 1].enhance]]),
    ['imprint_rank', 'TEXT', r => r.imprint.rank], ['imprint_mode', 'TEXT', r => r.imprint.mode],
    ['imprint_stat', 'TEXT', r => r.imprint.stat], ['imprint_value', 'REAL', r => r.imprint.value],
    ['imprint_count', 'INTEGER', 'imprintCount'], ['opt', 'INTEGER'],
  ],
  equipment: [...item, enhanceLevel, ...mainStat, ['substats_json', "TEXT NOT NULL CHECK (json_type(substats_json) = 'object')", r =>
    JSON.stringify(Object.fromEntries([...r.sub].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))],
  ],
  exclusive_equipment: [...item, ...mainStat, ['effect_options', 'TEXT', 'exclusiveEffect']],
  artifacts: [...item, enhanceLevel, ['stars', 'INTEGER', 'artifactStars'], ['limit_break', 'INTEGER', 'limitBreak'],
    ['attack', 'REAL', 'artifactAtk'], ['health', 'REAL', 'artifactHp'], ['defense', 'REAL', 'artifactDef'],
  ],
};
const columns = Object.fromEntries(Object.entries(fields).map(([table, defs]) => [table, defs.map(([name]) => name).join(', ')]));
const ownership = `link_status TEXT GENERATED ALWAYS AS (
  CASE WHEN hero_instance_id IS NOT NULL THEN 'linked' WHEN wearer_id IS NOT NULL THEN 'missing_hero' ELSE 'unequipped' END
) VIRTUAL, CHECK (hero_instance_id IS NULL OR (wearer_id IS NOT NULL AND hero_instance_id = wearer_id))`;

function rowsFor(account) {
  const lists = {heroes: account.heroes.slice(), equipment: [], exclusive_equipment: [], artifacts: []};
  // Unknown slots remain in equipment; keep the source code, raw options and any wearer.
  for (const row of account.equipment) lists[row.slot === 'artifact' ? 'artifacts' : row.slot === 'exclusive' ? 'exclusive_equipment' : 'equipment'].push(row);
  return Object.fromEntries(Object.entries(lists).map(([table, rows]) => [table, rows
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
    .map(row => fields[table].map(([name, , get = name]) => {
      const value = typeof get === 'function' ? get(row) : row[get];
      return value === 0 ? 0 : value ?? null;
    }))]));
}

function writeSnapshot(file, tables) {
  const db = new DatabaseSync(file);
  try {
    db.exec('PRAGMA synchronous=FULL; BEGIN IMMEDIATE');
    db.exec(`PRAGMA application_id=${APPLICATION_ID}; PRAGMA user_version=${VERSION}`);
    for (const [table, defs] of Object.entries(fields)) {
      const itemTable = table !== 'heroes';
      const declarations = defs.map(([name, type]) => `${name} ${type}`);
      if (itemTable) declarations.push(ownership);
      db.exec(`CREATE TABLE ${table} (${declarations.join(', ')}) STRICT`);
      if (itemTable) db.exec(`CREATE INDEX ${table}_hero ON ${table}(hero_instance_id)`);
      const insert = db.prepare(`INSERT INTO ${table} (${columns[table]}) VALUES (${defs.map(() => '?').join(', ')})`);
      for (const row of tables[table]) insert.run(...row);
    }
    db.exec('COMMIT');
  } finally {db.close();}
}

async function existingSnapshot(file, tables) {
  const stat = await fs.lstat(file).catch(err => {if (err.code !== 'ENOENT') throw err;});
  if (!stat) return false;
  const mismatch = '现有目标不是同一份可复用的账号快照，请另选 SQLite 文件';
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) throw new AccountExportError(mismatch);
  let db;
  try {
    db = new DatabaseSync(file, {readOnly: true});
    const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name").all().map(row => row.name);
    if (db.prepare('PRAGMA application_id').get().application_id !== APPLICATION_ID ||
        db.prepare('PRAGMA user_version').get().user_version !== VERSION ||
        !isDeepStrictEqual(names, Object.keys(fields).sort()) ||
        db.prepare('PRAGMA quick_check(1)').get().quick_check !== 'ok' || db.prepare('PRAGMA foreign_key_check').get()) throw Error();
    for (const [table, rows] of Object.entries(tables)) {
      const select = db.prepare(`SELECT ${columns[table]} FROM ${table} ORDER BY instance_id`);
      select.setReturnArrays(true);
      let index = 0;
      for (const row of select.iterate()) if (!isDeepStrictEqual(row, rows[index++])) throw Error();
      if (index !== rows.length) throw Error();
    }
    return true;
  } catch {throw new AccountExportError(mismatch);}
  finally {db?.close();}
}

export async function writeAccountDatabase(file, account) {
  const tables = rowsFor(account);
  const tableCounts = Object.fromEntries(Object.entries(tables).map(([table, rows]) => [table, rows.length]));
  if (await existingSnapshot(file, tables)) return {tableCounts, reused: true};

  // Stage and close the complete database before publishing it without overwriting an existing path.
  const staging = await fs.mkdtemp(path.join(path.dirname(file), '.kurumi-e7-'));
  const temp = path.join(staging, 'account.sqlite');
  try {
    await (await fs.open(temp, 'wx', 0o600)).close();
    writeSnapshot(temp, tables);
    try {await fs.link(temp, file);}
    catch (err) {
      if (err.code !== 'EEXIST' || !await existingSnapshot(file, tables)) throw err;
      return {tableCounts, reused: true};
    }
    return {tableCounts, reused: false};
  } finally {await fs.rm(staging, {recursive: true, force: true});}
}
