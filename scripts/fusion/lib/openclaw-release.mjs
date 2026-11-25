// The approved host release. Changing this requires the isolated upgrade contracts.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
export const OPENCLAW_RELEASE = Object.freeze(JSON.parse(fs.readFileSync(new URL('../../../config/openclaw-release.json', import.meta.url))));
if (!/^2026\.\d+\.\d+(?:-[\w.]+)?$/.test(OPENCLAW_RELEASE.version)) throw Error('Invalid approved OpenClaw release');
export const SDK_ROOT = '/home/afrangry/.npm-global/lib/node_modules/openclaw';

const DISPATCH_ABORT_PATCH = Object.freeze({
  version: '2026.11.8',
  file: 'dist/dispatch-from-config-CIEmLnTP.mjs',
  original: '1b55ea787bd2b02ec38aa5a934345c5cea4314be4389147e4e0c1b92cf0b5549',
  patched: '6dfdf8625c20c9d53d3612e75dfb5817f12be8569e2fa0566f0a9f7ff82ee7d1',
});
export const openClawDigest = source => createHash('sha256').update(source).digest('hex');

export function readOpenClawPatch(root, release = OPENCLAW_RELEASE) {
  const {name,version} = JSON.parse(fs.readFileSync(path.join(root,'package.json')));
  if (name !== 'openclaw' || version !== release.version) {
    throw Error(`Pinned SDK is ${name}@${version}, expected openclaw@${release.version}`);
  }
  if (version !== DISPATCH_ABORT_PATCH.version) return;
  const file = path.join(fs.realpathSync(root),DISPATCH_ABORT_PATCH.file);
  if (!fs.lstatSync(file).isFile() || fs.realpathSync(file) !== file) throw Error('OpenClaw patch target must be a regular file in the SDK');
  const source = fs.readFileSync(file,'utf8');
  return {...DISPATCH_ABORT_PATCH,file,source,digest:openClawDigest(source)};
}

export function assertOpenClawRelease(root, release = OPENCLAW_RELEASE) {
  const patch = readOpenClawPatch(root,release);
  if (patch && patch.digest !== patch.patched) {
    throw Error('OpenClaw 2026.11.8 dispatch cancellation patch missing or altered; verify the approved SDK artifact');
  }
}
