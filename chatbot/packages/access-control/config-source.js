// Fixed operator-selected checkout. Neither source is read from the running state directory.
import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {AccessError, validatePolicy} from './index.js';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

function openSource(sourceRoot, basename, validate) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)
    || path.resolve(sourceRoot) !== sourceRoot || fs.realpathSync(sourceRoot) !== sourceRoot) {
    throw new AccessError('access_source_root_invalid');
  }
  const directory = path.join(sourceRoot, 'config');
  const file = path.join(directory, basename);

  function read() {
    if (fs.realpathSync(directory) !== directory) throw new AccessError('access_source_path_invalid');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new AccessError('access_source_file_invalid');
      const bytes = fs.readFileSync(fd);
      const policy = validate(JSON.parse(bytes.toString('utf8')));
      return {policy, hash: sha256(bytes), mode: stat.mode & 0o777};
    } finally {
      fs.closeSync(fd);
    }
  }

  return {read, write(expected, content) {
    const temp = path.join(directory, '.' + basename + '.' + randomUUID() + '.tmp');
    if (fs.realpathSync(directory) !== directory) throw new AccessError('access_source_path_invalid');
    const fd = fs.openSync(temp, 'wx', 0o600);
    let replaced = false;
    try {
      try {
        fs.writeFileSync(fd, content);
        fs.fchmodSync(fd, expected.mode);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      if (read().hash !== expected.hash) throw new AccessError('access_policy_changed');
      fs.renameSync(temp, file);
      replaced = true;
      const dir = fs.openSync(directory, 'r');
      try { fs.fsyncSync(dir); } finally { fs.closeSync(dir); }
    } finally {
      if (!replaced) fs.rmSync(temp, {force: true});
    }
  }};
}

export const openPolicySource = root => openSource(root, 'access-control.json', validatePolicy);
export const openRuntimeSource = root => openSource(root, 'runtime.config.json', policy => {
  if (!policy || typeof policy !== 'object' || Array.isArray(policy)) throw new AccessError('access_runtime_source_invalid');
  return policy;
});
