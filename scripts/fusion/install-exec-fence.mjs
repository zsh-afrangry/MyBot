// Import a complete, hash-pinned BSD dependency, including its license, without changing DSH.
// Default is read-only. --apply installs into Fusion's private tools; it does not sync configuration.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {FENCE_ROOT, LEGACY_FENCE_ROOT, FENCE_RELEASE, verifyExecFence} from './lib/exec-fence.mjs';
const args = process.argv.slice(2);
if (args.some(a => !['--apply', '--source'].includes(a) && args[args.indexOf(a) - 1] !== '--source')) throw Error('Usage: install-exec-fence.mjs [--apply] [--source <canonical complete package>]');
const source = args.includes('--source') ? args[args.indexOf('--source') + 1] : LEGACY_FENCE_ROOT;
if (fs.existsSync(FENCE_ROOT)) {
  const probe = verifyExecFence();
  console.log(JSON.stringify({ok: true, installed: FENCE_ROOT, version: FENCE_RELEASE.version, probe}));
} else if (!args.includes('--apply')) {
  console.log(JSON.stringify({ok: false, installRequired: true, target: FENCE_ROOT, source, version: FENCE_RELEASE.version}));
  process.exitCode = 1;
} else {
  verifyExecFence(source);
  const parent = path.dirname(FENCE_ROOT);
  fs.mkdirSync(parent, {recursive: true, mode: 0o700});
  if (fs.realpathSync(parent) !== parent) throw Error('Fusion tools parent must be canonical');
  const staged = path.join(parent, '.exec-fence-' + randomUUID());
  try {
    fs.cpSync(source, staged, {recursive: true, preserveTimestamps: true, verbatimSymlinks: true, errorOnExist: true});
    verifyExecFence(staged);
    fs.renameSync(staged, FENCE_ROOT);
    console.log(JSON.stringify({ok: true, installed: FENCE_ROOT, version: FENCE_RELEASE.version, probe: verifyExecFence()}));
  } finally {fs.rmSync(staged, {recursive: true, force: true});}
}
