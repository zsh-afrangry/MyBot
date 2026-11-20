// Local installer for the standalone Web UI. Writes its user service and release
// files; starts/restarts kurumi-admin-web.service only. No Fusion runtime changes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {setTimeout as wait} from 'node:timers/promises';

const repo = path.resolve(fileURLToPath(new URL('../..', import.meta.url)));
const home = os.homedir();
const settings = {
  '--source': path.join(home, 'kurumi-fusion'),
  '--runtime': path.join(home, '.openclaw-fusion'),
  '--port': '3085',
};
for (let i = 2; i < process.argv.length; i += 2) {
  const flag = process.argv[i], value = process.argv[i + 1];
  if (!Object.hasOwn(settings, flag) || !value || value.startsWith('--')) {
    throw Error('Usage: install-admin-web.mjs [--source <repository>] [--runtime <runtime-root>] [--port <number>]');
  }
  settings[flag] = value;
}
const root = key => {
  const dir = path.resolve(settings[key]);
  if (dir !== fs.realpathSync(dir) || !fs.statSync(dir).isDirectory()) throw Error('Expected a real directory: ' + key);
  return dir;
};
const source = root('--source'), runtime = root('--runtime'), port = Number(settings['--port']);
const nested = (a, b) => a === b || b.startsWith(a + path.sep);
if (nested(source, runtime) || nested(runtime, source)) throw Error('Source and runtime must be separate');
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('Expected an unprivileged TCP port');
if (!fs.existsSync(path.join(source, 'config/access-control.json'))) throw Error('The selected directory is not a Fusion checkout');

const deployRoot = path.join(home, '.local/share/kurumi-admin-web');
const state = path.join(home, '.local/state/kurumi-admin-web');
const userUnits = path.join(home, '.config/systemd/user');
const files = [
  'chatbot/admin-web/common.mjs', 'chatbot/admin-web/changes.mjs', 'chatbot/admin-web/inventory.mjs',
  'chatbot/admin-web/observations.mjs', 'chatbot/admin-web/logs.mjs', 'chatbot/admin-web/git.mjs',
  'chatbot/admin-web/server.mjs', 'chatbot/admin-web/package.json',
  'chatbot/admin-web/public/index.html', 'chatbot/admin-web/public/mark.svg', 'chatbot/admin-web/public/app.js',
  'chatbot/admin-web/public/pages.js', 'chatbot/admin-web/public/components.js', 'chatbot/admin-web/public/styles.css',
  'docs/33_Fusion后端Web界面.md',
].map(relative => [relative, fs.readFileSync(path.join(repo, relative))]);
const hash = createHash('sha256');
for (const [name, value] of files) hash.update(name + '\0' + value.length + '\0').update(value);
const release = path.join(deployRoot, hash.digest('hex').slice(0, 16));
if (!fs.existsSync(release)) {
  fs.mkdirSync(deployRoot, {recursive: true, mode: 0o700});
  const staging = fs.mkdtempSync(path.join(deployRoot, '.new-'));
  try {
    for (const [name, value] of files) {
      const target = path.join(staging, name);
      fs.mkdirSync(path.dirname(target), {recursive: true, mode: 0o700});
      fs.writeFileSync(target, value, {flag: 'wx', mode: 0o600});
    }
    fs.renameSync(staging, release);
  } finally {
    fs.rmSync(staging, {recursive: true, force: true});
  }
}
const quote = arg => {
  if (/[\x00-\x1f\x7f]/u.test(arg)) throw Error('Control characters are not allowed in unit arguments');
  return '"' + arg.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', '$$') + '"';
};
const startup = [
  path.join(release, 'chatbot/admin-web/server.mjs'), '--source', source, '--runtime', runtime,
  '--state', state, '--docs', release, '--port', String(port),
].map(quote).join(' ');
const unit = '[Unit]\nDescription=Kurumi Fusion local Web administration\nAfter=network.target\n\n' +
  '[Service]\nType=simple\nUMask=0077\nNoNewPrivileges=yes\n' +
  'ExecStart=/usr/bin/node ' + startup + '\nRestart=on-failure\nRestartSec=3\n\n' +
  '[Install]\nWantedBy=default.target\n';
const name = 'kurumi-admin-web.service';
const unitFile = path.join(userUnits, name);
const previous = fs.existsSync(unitFile) ? fs.readFileSync(unitFile, 'utf8') : null;
if (previous && !previous.includes('Description=Kurumi Fusion local Web administration\n')) throw Error('Service name already used');
fs.mkdirSync(userUnits, {recursive: true});
if (previous !== unit) {
  const work = fs.mkdtempSync(path.join(userUnits, '.kurumi-web-'));
  try {
    const candidate = path.join(work, name);
    fs.writeFileSync(candidate, unit, {mode: 0o600, flag: 'wx'});
    fs.renameSync(candidate, unitFile);
  } finally {fs.rmSync(work, {recursive: true, force: true});}
}
const ctl = (...args) => execFileSync('/usr/bin/systemctl', ['--user', ...args], {stdio: 'inherit', timeout: 12000});
ctl('daemon-reload');
ctl('enable', name);
ctl(previous !== unit ? 'restart' : 'start', name);
const url = 'http://127.0.0.1:' + port + '/';
let ready = false;
for (let attempt = 0; attempt < 12 && !ready; attempt++) {
  try {
    const response = await fetch(url + 'api/session', {signal: AbortSignal.timeout(450), redirect: 'error'});
    ready = response.ok && (await response.json()).app === 'kurumi-admin-web';
  } catch {}
  if (!ready) await wait(250);
}
if (!ready) throw Error('Management service is not responding. Check kurumi-admin-web.service.');
ctl('is-active', name);
console.log('Kurumi admin Web UI: ' + url);
