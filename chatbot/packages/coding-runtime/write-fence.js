// Operator-owned Linux filesystem write boundary. No model-selected grants or fallback execution.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const failure = code => Object.assign(Error(code), {code});
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
export function validateWriteFence(boundary) {
  if (!boundary || typeof boundary.root !== 'string' || !path.isAbsolute(boundary.root)
    || path.resolve(boundary.root) !== boundary.root || boundary.root === '/'
    || fs.realpathSync(boundary.root) !== boundary.root || !fs.statSync(boundary.root).isDirectory()
    || typeof boundary.launcher !== 'string' || !path.isAbsolute(boundary.launcher)
    || !fs.statSync(boundary.launcher).isFile() || inside(fs.realpathSync(boundary.launcher), boundary.root)) throw failure('invalid_coding_write_boundary');
}
export function probeWriteFence(boundary) {
  validateWriteFence(boundary);
  const result = spawnSync(boundary.launcher, ['--probe'], {encoding: 'utf8', timeout: 5000});
  if (result.status !== 0 || !/^landlock: (fully|partially) enforced/m.test(result.stdout ?? '')) throw failure('coding_write_boundary_unavailable');
  return {backend: 'landlock', enforcement: /partially enforced/.test(result.stdout) ? 'partial' : 'full', writeRoot: boundary.root};
}
export function confinedProcess(boundary, command, args, cwd) {
  validateWriteFence(boundary);
  if (!inside(fs.realpathSync(cwd), boundary.root)) throw failure('coding_cwd_outside_write_boundary');
  const temporary = path.join(boundary.root, 'state', 'tmp');
  fs.mkdirSync(temporary, {recursive: true, mode: 0o700});
  if (fs.realpathSync(temporary) !== temporary) throw failure('invalid_coding_write_boundary');
  // Reads retain the existing on-demand information policy. /dev/null is the only device write grant.
  return {command: boundary.launcher, args: ['--ro', '/', '--rw', '/dev/null', '--rw', boundary.root, '--', command, ...args],
    env: {TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_CACHE_HOME: path.join(boundary.root, 'state', 'cache')}};
}
