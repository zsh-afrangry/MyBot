// Explicit operator setup; imports only the selected provider's named credentials.
// No network/model/QQ call. CLI paths only. Private values never enter output. Contract: docs/22.
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {credentialIdsForProfile} from '../plugins/kurumi-papers/profiles.js';

const arg = name => {const i = process.argv.indexOf('--'+name);return i < 0 ? undefined : process.argv[i+1];};
const source = arg('source'), destination = arg('destination'), provider = arg('provider') ?? 'openai';
if (!['openai','deepseek'].includes(provider)) throw Error('Unsupported credential provider');
if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) throw Error('Explicit absolute --source and --destination are required');
const ids = credentialIdsForProfile({provider});
const allIds = [...credentialIdsForProfile(), ...credentialIdsForProfile({provider:'deepseek'})];
const privateJson = file => {try {return JSON.parse(fs.readFileSync(file, 'utf8'));} catch {throw Error('Invalid private credential JSON');}};
let keys = {};
let stat;
try {stat = fs.lstatSync(destination);} catch (error) {if (error.code !== 'ENOENT') throw error;}
if (stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077) throw Error('Credential destination must be owner-only and regular');
  if (!process.argv.includes('--replace')) throw Error('Credential destination exists; review before using --replace');
  const existing = privateJson(destination);
  if (!existing || Array.isArray(existing) || typeof existing !== 'object' || Object.keys(existing).some(id => !allIds.includes(id))) throw Error('Unexpected existing credential fields; refusing to discard data');
  keys = {...existing};
}
if (provider === 'deepseek') {
  // Explicit copy from the operator-selected flat runtime-env JSON, not access from a model tool.
  const raw = privateJson(source);
  if (typeof raw?.DEEPSEEK_API_KEY !== 'string' || !raw.DEEPSEEK_API_KEY.trim()) throw Error('Missing named credential: DEEPSEEK_API_KEY');
  keys.DEEPSEEK_API_KEY = raw.DEEPSEEK_API_KEY.trim();
} else {
  const content = fs.readFileSync(source, 'utf8'), start = content.indexOf('#中转-GPT');
  if (start < 0) throw Error('Expected GPT credential section was not found');
  const section = content.slice(start).split(/\n\s*#(?!中转-GPT)/, 1)[0];
  for (const id of ids) {
    const match = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?'+id+'\\s*[:=：]\\s*["\x27]?([^\\s"\x27#]+)').exec(section);
    if (!match) throw Error('Missing named credential: '+id);
    keys[id] = match[1];
  }
}
fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
const temp = destination + '.tmp-' + randomUUID();
try {
  fs.writeFileSync(temp, JSON.stringify(keys), {mode: 0o600, flag: 'wx'});
  if (process.argv.includes('--replace')) fs.renameSync(temp, destination);
  else {fs.linkSync(temp, destination); fs.unlinkSync(temp);}
} finally {fs.rmSync(temp, {force: true});}
console.log(JSON.stringify({ok: true, provider, importedIds: ids, retainedIds: Object.keys(keys).filter(id => !ids.includes(id)), secretsExposed: false}));
