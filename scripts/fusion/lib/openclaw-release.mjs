// The approved host release. Changing this requires the isolated upgrade contracts.
import fs from 'node:fs';
export const OPENCLAW_RELEASE = Object.freeze(JSON.parse(fs.readFileSync(new URL('../../../config/openclaw-release.json', import.meta.url))));
if (!/^2026\.\d+\.\d+(?:-[\w.]+)?$/.test(OPENCLAW_RELEASE.version)) throw Error('Invalid approved OpenClaw release');
export const SDK_ROOT = '/home/afrangry/.npm-global/lib/node_modules/openclaw';
