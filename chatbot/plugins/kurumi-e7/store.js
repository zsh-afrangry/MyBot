// Public JSON cache only, atomic replacement; no identity, credentials or chat text.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {E7Error} from './policy.js';

export const digest = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
function safeDirectory(root) {
  const absolute = path.resolve(root);
  let current = path.parse(absolute).root;
  for (const part of absolute.slice(current.length).split(path.sep)) {
    current = path.join(current, part);
    try {if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) throw new E7Error('unsafe_cache_path');}
    catch (e) {if (e.code !== 'ENOENT') throw e; fs.mkdirSync(current, {mode: 0o700});}
  }
}
export class E7Store {
  constructor(root) {this.root = root;}
  file(key) {return path.join(this.root, digest(key) + '.json');}
  read(key) {
    try {
      safeDirectory(this.root);
      const fd = fs.openSync(this.file(key), fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
      try {
        const stat = fs.fstatSync(fd);
        if (!stat.isFile() || stat.size > 6 * 1024 * 1024) return null;
        const record = JSON.parse(fs.readFileSync(fd, 'utf8'));
        if (record.version !== 1 || record.key !== key || record.hash !== digest(record.data)
          || !Number.isFinite(record.fetchedAt) || !Number.isFinite(record.checkedAt)) return null;
        return record;
      } finally {fs.closeSync(fd);}
    } catch (error) {
      if (error.code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw new E7Error('cache_read_failed');
    }
  }
  write(key, record) {
    safeDirectory(this.root);
    const file = this.file(key), tmp = file + '.' + randomUUID() + '.tmp';
    let fd;
    try {
      const body = JSON.stringify({...record, version: 1, key});
      if (Buffer.byteLength(body) > 6 * 1024 * 1024) throw new E7Error('cache_too_large');
      fd = fs.openSync(tmp, 'wx', 0o600); fs.writeFileSync(fd, body); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
      fs.renameSync(tmp, file);
    } catch (error) {throw error instanceof E7Error ? error : new E7Error('cache_write_failed');}
    finally {if (fd !== undefined) fs.closeSync(fd); try {fs.unlinkSync(tmp);} catch (e) {if (e.code !== 'ENOENT') throw e;}}
  }
}
