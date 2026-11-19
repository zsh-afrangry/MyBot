// Fixed operator-selected checkout. This module never opens the running config.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {AccessError, validatePolicy} from '../../packages/access-control/index.js';
import {sha256} from './policy.js';

export function openPolicySource(sourceRoot) {
  if (typeof sourceRoot !== 'string' || !path.isAbsolute(sourceRoot)
    || path.resolve(sourceRoot) !== sourceRoot || fs.realpathSync(sourceRoot) !== sourceRoot) {
    throw new AccessError('access_source_root_invalid');
  }
  const directory = path.join(sourceRoot, 'config');
  const file = path.join(directory, 'access-control.json');

  function read() {
    if (fs.realpathSync(directory) !== directory) throw new AccessError('access_source_path_invalid');
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw new AccessError('access_source_file_invalid');
      const bytes = fs.readFileSync(fd);
      const policy = validatePolicy(JSON.parse(bytes.toString('utf8')));
      return {policy, hash: sha256(bytes), mode: stat.mode & 0o777};
    } finally {
      fs.closeSync(fd);
    }
  }

  return {read, write(expected, content) {
    const temp = path.join(directory, '.access-control.' + randomUUID() + '.tmp');
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
