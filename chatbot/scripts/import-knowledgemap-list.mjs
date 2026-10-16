#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「迁移与切换」。
// Boundary: reads private legacy SQLite, calls real API; --apply writes shared DB.
import {DatabaseSync} from 'node:sqlite';
import {parseArgs} from 'node:util';
import {createHash} from 'node:crypto';
import {existsSync, readFileSync, writeFileSync, renameSync, mkdirSync} from 'node:fs';
import {join, isAbsolute, dirname} from 'node:path';
import {pathToFileURL} from 'node:url';
import {clientFromEnvironment} from '../packages/knowledgemap-client/client.js';
import {stateRoot} from '../plugins/personal-reminder-list/application.js';
import {readListSource, sourceFile} from '../plugins/personal-reminder-list/data-source.js';

export function legacyRows(file) {
  if (!isAbsolute(file) || !existsSync(file)) throw Error('需要已有旧列表数据库绝对路径');
  const db = new DatabaseSync(file, {readOnly: true});
  try {return db.prepare('SELECT id,title,content,note,ddl,deadline_ms,status,version,created_ms,updated_ms FROM items ORDER BY id').all();}
  finally {db.close();}
}
export const sourceHash = rows => createHash('sha256').update(JSON.stringify(rows)).digest('hex');

export async function main(argv = process.argv.slice(2)) {
  const {values} = parseArgs({args: argv, options: {source: {type: 'string'}, apply: {type: 'boolean'}, activate: {type: 'boolean'}, 'expect-source-hash': {type: 'string'}, 'backup-dir': {type: 'string'}}});
  if (values.activate && !values.apply) throw Error('--activate需要--apply');
  if (values.activate && values.source !== join(stateRoot(), 'state', 'personal-reminder-list', 'list.sqlite')) throw Error('切换标记必须与本运行目录的来源数据库一致');
  const rows = legacyRows(values.source), hash = sourceHash(rows);
  if (values.apply) {
    if (values['expect-source-hash'] !== hash) throw Error('来源已变化或未提供预览hash，未迁移');
    const manifest = join(values['backup-dir'] ?? '', 'private-state', 'manifest.json');
    if (!isAbsolute(manifest) || !existsSync(manifest) || !JSON.parse(readFileSync(manifest, 'utf8')).sqlite?.['state/personal-reminder-list/list.sqlite']) throw Error('需要今晚备份目录');
  }
  const client = clientFromEnvironment();
  const result = await client.request('/api/assistant/tasks/import', {method: 'POST', body: {apply: Boolean(values.apply), items: rows}, key: 'migration:' + hash});
  if (values.activate) {
    if (!result.ok || !result.applied || result.count !== rows.length || sourceHash(legacyRows(values.source)) !== hash) throw Error('迁移结果或来源变化，未切换');
    const root = stateRoot(), file = sourceFile(root), prior = readListSource(root);
    if (prior && (prior.baseUrl !== client.baseUrl || prior.tokenFile !== client.tokenFile || prior.sourceHash !== hash)) throw Error('已有不同切换标记，先人工核对');
    if (!prior) {
      mkdirSync(dirname(file), {recursive: true, mode: 0o700});
      writeFileSync(file + '.tmp', JSON.stringify({dataSource: 'knowledgemap', baseUrl: client.baseUrl, tokenFile: client.tokenFile, sourceHash: hash, at: new Date().toISOString()}) + '\n', {mode: 0o600});
      renameSync(file + '.tmp', file);
    }
  }
  // No title/body in public evidence. Save mappings privately if needed.
  process.stdout.write(JSON.stringify({sourceHash: hash, ...result}) + '\n');
  return 0;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(error => {process.stderr.write((error.code ?? 'migration_failed') + ': ' + error.message + '\n'); process.exitCode = 1;});
