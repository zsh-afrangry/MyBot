// Fusion owns this small native dependency; the DSH installation is only an optional import source.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {treeHash, EXEC_FENCE_ROOT, LEGACY_EXEC_FENCE_ROOT} from './backup-layout.mjs';
import {probeWriteFence} from '../../../chatbot/packages/coding-runtime/write-fence.js';
export const FENCE_ROOT = EXEC_FENCE_ROOT;
export const LEGACY_FENCE_ROOT = LEGACY_EXEC_FENCE_ROOT;
export const FENCE_RELEASE = JSON.parse(fs.readFileSync(fileURLToPath(new URL('../../../config/exec-fence-release.json', import.meta.url))));

export function verifyExecFence(root = FENCE_ROOT) {
  if (process.platform !== FENCE_RELEASE.platform || process.arch !== FENCE_RELEASE.arch) throw Error('Execution fence platform mismatch');
  if (fs.realpathSync(root) !== root || !fs.lstatSync(root).isDirectory()) throw Error('Execution fence must be an independent canonical directory');
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'package.json')));
  if (manifest.name !== FENCE_RELEASE.name || manifest.version !== FENCE_RELEASE.version || manifest.license !== FENCE_RELEASE.license
    || treeHash(root) !== FENCE_RELEASE.treeHash) throw Error('Execution fence dependency differs from approved release');
  return probeWriteFence({root: '/tmp', launcher: path.join(root, 'bin/landlock-run')});
}
