// Document 25 P2. SQLite owns the single snapshot and compare-and-swap transaction.
// No chat parsing, identity inference, fallback storage or automatic legacy import.
import fs from 'node:fs';
import path from 'node:path';
import {randomBytes} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {STATE_RELATIVE, MEMORY_NOTICE, validateState} from './model.js';
const schema = fs.readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
function regular(file, missing = false) {
  try {if (!fs.lstatSync(file).isFile() || fs.lstatSync(file).isSymbolicLink()) throw Error('Memory state must be a regular file');}
  catch (error) {if (!(missing && error.code === 'ENOENT')) throw error;}
}
export function memoryPaths(workspace, create = false) {
  if (!path.isAbsolute(workspace) || fs.realpathSync(workspace) !== path.resolve(workspace) || fs.lstatSync(workspace).isSymbolicLink()) throw Error('Memory workspace must be a real absolute directory');
  const directory = path.join(workspace, '.kurumi-memory'), file = path.join(workspace, STATE_RELATIVE), notice = path.join(workspace, 'MEMORY.md');
  if (create && !fs.existsSync(directory)) fs.mkdirSync(directory, {mode: 0o700});
  if (fs.existsSync(directory) || create) {
    const st = fs.lstatSync(directory);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077)) throw Error('Memory directory must be private and real');
  }
  regular(notice, true); regular(file, true);
  for (const suffix of ['-wal','-shm','-journal']) regular(file + suffix, true);
  return {directory, file, notice};
}
function fsyncDirectory(directory) {const fd = fs.openSync(directory, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}}
export function replaceNotice(workspace) {
  const {notice} = memoryPaths(workspace), tmp = notice + '.' + randomBytes(8).toString('hex') + '.tmp';
  const fd = fs.openSync(tmp, 'wx', 0o600);
  try {fs.writeFileSync(fd, MEMORY_NOTICE); fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
  try {fs.renameSync(tmp, notice); fsyncDirectory(workspace);} finally {fs.rmSync(tmp, {force: true});}
}
export function initializeContinuity(workspace, state) {
  validateState(state);
  const {file, directory} = memoryPaths(workspace, true), tmp = file + '.' + randomBytes(8).toString('hex') + '.tmp';
  if (fs.existsSync(file)) throw Error('Personal memory already exists');
  const db = new DatabaseSync(tmp);
  try {
    fs.chmodSync(tmp, 0o600); db.exec('PRAGMA synchronous=FULL'); db.exec(schema);
    db.prepare('INSERT INTO memory_state VALUES (1,2,?,?,?)').run(state.ownerId, state.revision, JSON.stringify(state));
  } finally {db.close();}
  try {
    const fd = fs.openSync(tmp, 'r'); try {fs.fsyncSync(fd);} finally {fs.closeSync(fd);}
    fs.linkSync(tmp, file); fsyncDirectory(directory);
  } finally {fs.rmSync(tmp, {force: true});}
}
export function openContinuityStore({workspace, ownerId, requireNotice = true, readonly = false}) {
  const {file, notice} = memoryPaths(workspace);
  if (requireNotice && fs.readFileSync(notice, 'utf8') !== MEMORY_NOTICE) throw Error('Personal memory requires explicit migration');
  if (!fs.existsSync(file) || fs.statSync(file).mode & 0o077 || fs.statSync(file).size > 8 * 1024 * 1024) throw Error('Personal memory state missing or unsafe');
  const db = new DatabaseSync(file, {readOnly: readonly});
  try {db.exec('PRAGMA busy_timeout=2000'); if (!readonly) db.exec('PRAGMA synchronous=FULL');
    if (db.prepare('PRAGMA user_version').get().user_version !== 2) throw Error('Unsupported personal memory schema');
  } catch (error) {db.close(); throw error;}
  const read = () => {
    const row = db.prepare('SELECT * FROM memory_state WHERE singleton=1').get();
    if (!row || row.state_json.length > 1024 * 1024) throw Error('Invalid personal memory row');
    const data = validateState(JSON.parse(row.state_json), ownerId);
    if (data.revision !== row.revision || data.ownerId !== row.owner_id || row.version !== 2) throw Error('Personal memory metadata mismatch');
    return data;
  };
  return {read, write(data, expectedRevision) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const previous = read();
      if (previous.revision !== expectedRevision) throw Error('记忆已改变，请重新读取revision后重试');
      const next = validateState({...data, revision: previous.revision + 1}, ownerId);
      if (next.ownerId !== previous.ownerId || next.generation < previous.generation) throw Error('Invalid memory generation');
      db.prepare('UPDATE memory_state SET revision=?,state_json=? WHERE singleton=1').run(next.revision, JSON.stringify(next));
      db.exec('COMMIT'); return next;
    } catch (error) {db.exec('ROLLBACK'); throw error;}
  }, close() {db.close();}};
}
