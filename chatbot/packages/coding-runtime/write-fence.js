// Operator-owned Linux filesystem write boundary. No model-selected grants or fallback execution.
import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';

const failure = code => Object.assign(Error(code), {code});
const inside = (file, root) => file === root || file.startsWith(root + path.sep);
// The primary root owns runtime scratch data. Extra roots are operator grants,
// never tool arguments; coding configurations continue to use one root.
export function writeFenceRoots(boundary) {
  const extra = boundary?.additionalRoots === undefined ? [] : boundary.additionalRoots;
  if (!Array.isArray(extra) || extra.length > 16) throw failure('invalid_coding_write_boundary');
  return [boundary?.root, ...extra];
}
export function validateWriteFence(boundary) {
  const roots = writeFenceRoots(boundary);
  if (typeof boundary?.launcher !== 'string' || !path.isAbsolute(boundary.launcher)
    || !fs.statSync(boundary.launcher).isFile()) throw failure('invalid_coding_write_boundary');
  const launcher = fs.realpathSync(boundary.launcher);
  for (const [index, root] of roots.entries()) {
    if (typeof root !== 'string' || !path.isAbsolute(root) || path.resolve(root) !== root || root === '/'
      || fs.realpathSync(root) !== root || !fs.statSync(root).isDirectory() || inside(launcher, root)
      || roots.slice(0, index).some(other => inside(root, other) || inside(other, root))) throw failure('invalid_coding_write_boundary');
  }
}
export function probeWriteFence(boundary) {
  validateWriteFence(boundary);
  const result = spawnSync(boundary.launcher, ['--probe'], {encoding: 'utf8', timeout: 5000});
  if (result.status !== 0 || !/^landlock: (fully|partially) enforced/m.test(result.stdout ?? '')) throw failure('coding_write_boundary_unavailable');
  return {backend: 'landlock', enforcement: /partially enforced/.test(result.stdout) ? 'partial' : 'full', writeRoot: boundary.root, writeRoots: writeFenceRoots(boundary)};
}
// Prepare runtime directories inside the same kernel fence: a writable parent may have
// been replaced by a symlink since the previous call. Never mkdir through it as the host.
export function fencedDirectory(boundary, relative) {
  validateWriteFence(boundary);
  const target = path.resolve(boundary.root, relative);
  if (target === boundary.root || !inside(target, boundary.root)) throw failure('invalid_coding_write_boundary');
  const result = spawnSync(boundary.launcher, ['--ro', '/', '--rw', '/dev/null', '--rw', boundary.root, '--', '/bin/mkdir', '-p', '-m', '700', target], {timeout: 5000, stdio: 'ignore'});
  if (result.status !== 0 || fs.realpathSync(target) !== target) throw failure('invalid_coding_write_boundary');
  return target;
}
export function confinedProcess(boundary, command, args, cwd) {
  validateWriteFence(boundary);
  const roots = writeFenceRoots(boundary);
  if (!roots.some(root => inside(fs.realpathSync(cwd), root))) throw failure('coding_cwd_outside_write_boundary');
  const temporary = fencedDirectory(boundary, 'state/tmp');
  // Reads retain the existing on-demand information policy. /dev/null is the only device write grant.
  return {command: boundary.launcher, args: ['--ro', '/', '--rw', '/dev/null', ...roots.flatMap(root => ['--rw', root]), '--', command, ...args],
    env: {TMPDIR: temporary, TMP: temporary, TEMP: temporary, XDG_CACHE_HOME: path.join(boundary.root, 'state', 'cache')}};
}
