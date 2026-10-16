// Explicit operator setup: copies ONLY three named GPT credentials to private runtime JSON.
// No network/model/QQ call. Source and destination are CLI-only, never model tool parameters.
// Requirement and handling rules: docs/22_论文PDF翻译与文件投递.md.
import fs from 'node:fs';
import path from 'node:path';
const arg = name => {const i = process.argv.indexOf('--'+name);return i < 0 ? undefined : process.argv[i+1];};
const source = arg('source'), destination = arg('destination');
if (!source || !destination || !path.isAbsolute(source) || !path.isAbsolute(destination)) throw Error('Explicit absolute --source and --destination are required');
if (fs.existsSync(destination) && !process.argv.includes('--replace')) throw Error('Credential destination exists; review before using --replace');
const content = fs.readFileSync(source, 'utf8');
const start = content.indexOf('#中转-GPT');
if (start < 0) throw Error('Expected GPT credential section was not found');
const section = content.slice(start).split(/\n\s*#(?!中转-GPT)/, 1)[0];
const keys = {};
for (const id of ['OPENAI_API_KEY1_014','OPENAI_API_KEY2_030','OPENAI_API_KEY3_040']) {
  const match = new RegExp('(?:^|\\n)\\s*(?:export\\s+)?'+id+'\\s*[:=：]\\s*[\"\x27]?([^\\s\"\x27#]+)').exec(section);
  if (!match) throw Error('Missing named credential: '+id);
  keys[id] = match[1];
}
fs.mkdirSync(path.dirname(destination), {recursive: true, mode: 0o700});
fs.writeFileSync(destination, JSON.stringify(keys), {mode: 0o600, flag: process.argv.includes('--replace') ? 'w' : 'wx'});
fs.chmodSync(destination, 0o600);
console.log(JSON.stringify({ok: true, importedIds: Object.keys(keys), secretsExposed: false}));
