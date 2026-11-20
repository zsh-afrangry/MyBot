import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {pathToFileURL} from 'node:url';

export class Problem extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const bad = message => new Problem(400, message);
export const conflict = () => new Problem(409, '源文件已改变，请重新读取并预览。');
export const isRecord = value => value !== null && typeof value === 'object' && !Array.isArray(value);
export const sha = data => createHash('sha256').update(data).digest('hex');
export const own = (value, key) => Object.hasOwn(value, key);
export const loadModule = (root, file) => import(pathToFileURL(path.join(root, file)));
export const optional = fn => { try { return fn(); } catch { return null; } };

export function fields(value, allowed) {
  if (!isRecord(value) || !Object.keys(value).every(key => allowed.includes(key))) throw bad('请求字段不符合此操作。');
}

export function realDirectory(value) {
  const root = path.resolve(value);
  if (fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory()) throw Error('Expected a real directory');
  return root;
}

export function readFile(root, relative, maxBytes = 1024 * 1024, {source = false} = {}) {
  if (path.isAbsolute(relative) || relative.split('/').some(part => !part || part === '.' || part === '..')) {
    throw Error('Invalid relative file');
  }
  const file = path.join(root, relative);
  realDirectory(path.dirname(file));
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || (source && stat.nlink !== 1) || stat.size > maxBytes) throw Error('Invalid file');
    // Cap the read even if another process extends an open file.
    const buffer = Buffer.alloc(stat.size + 1);
    const size = fs.readSync(fd, buffer, 0, buffer.length);
    if (size !== stat.size) throw Error('File changed while reading');
    const bytes = buffer.subarray(0, size);
    return {file, text: new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes), hash: sha(bytes), mode: stat.mode & 0o777};
  } finally {
    fs.closeSync(fd);
  }
}

export const jsonFile = (root, relative, maxBytes) => JSON.parse(readFile(root, relative, maxBytes).text);

export function replaceSource(root, relative, expectedHash, content, maxBytes) {
  const read = () => readFile(root, relative, maxBytes, {source: true});
  const current = read();
  if (current.hash !== expectedHash) throw conflict();
  const dir = path.dirname(current.file);
  const temp = path.join(dir, '.kurumi-web-' + randomUUID() + '.tmp');
  const fd = fs.openSync(temp, 'wx', 0o600);
  let replaced = false;
  try {
    try {
      fs.writeFileSync(fd, content, 'utf8');
      fs.fchmodSync(fd, current.mode);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (read().hash !== expectedHash) throw conflict();
    fs.renameSync(temp, current.file);
    replaced = true;
    const dirFd = fs.openSync(dir, 'r');
    try { fs.fsyncSync(dirFd); } finally { fs.closeSync(dirFd); }
  } finally {
    if (!replaced) fs.rmSync(temp, {force: true});
  }
}
