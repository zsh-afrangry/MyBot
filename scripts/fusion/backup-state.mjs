// Consistent backup of the fusion system into /home/afrangry/kurumi-backups/<stamp>-<label>.
//
// Why VACUUM INTO rather than copying files:
//   the runtime keeps SQLite databases open in WAL mode while the gateway runs. Copying a live
//   database can capture a torn snapshot. `VACUUM INTO` reads one consistent transaction, so the
//   backup is valid without stopping the service.
//
// What is captured:
//   git/     bundles of every branch and tag (source history, including uncommitted-free refs)
//   patches/ uncommitted tracked changes, so the backup is not silently lossy
//   config/  runtime config + credential plane + systemd units (mode 600)
//   state/   consistent snapshots of every runtime database + channel/agent JSON state
//   meta/    git state, service state, versions, sizes
//   MANIFEST.sha256 over everything
//
// Usage:
//   node scripts/fusion/backup-state.mjs                 # labelled "manual"
//   node scripts/fusion/backup-state.mjs --label pre-x   # labelled "pre-x"
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { REPO_ROOT, STATE_DIR } from './lib/legacy-source.mjs';

const BACKUP_ROOT = '/home/afrangry/kurumi-backups';
const argv = process.argv.slice(2);
const labelIdx = argv.indexOf('--label');
const label = (labelIdx >= 0 ? argv[labelIdx + 1] : 'manual') || 'manual';
const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
const dest = path.join(BACKUP_ROOT, `${stamp}-${label}`);

if (fs.existsSync(dest)) throw new Error(`Backup already exists, refusing to overwrite: ${dest}`);
for (const d of ['git', 'patches', 'config', 'state', 'meta', 'tools']) {
  fs.mkdirSync(path.join(dest, d), { recursive: true, mode: 0o700 });
}
const log = (m) => console.log(`  ${m}`);
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

// ---------------------------------------------------------------- git bundles
// The legacy trees were moved out of their active locations in step 7; look in the archive first
// and fall back to the old paths so this script keeps working on either layout.
const ARCHIVE = '/home/afrangry/kurumi-archive';
const firstExisting = (...candidates) => candidates.find((p) => fs.existsSync(path.join(p, '.git'))) ?? null;
const REPOS = [
  ['kurumi-fusion', REPO_ROOT],
  ['legacy-openclaw', firstExisting(`${ARCHIVE}/legacy-openclaw`, '/home/afrangry/.openclaw')],
  ['qq-bridge', firstExisting(`${ARCHIVE}/qq-bridge`, '/home/afrangry/桌面/qq-bridge')]
].filter(([, dir]) => dir);
for (const [name, dir] of REPOS) {
  const out = path.join(dest, 'git', `${name}.bundle`);
  const r = sh('git', ['-C', dir, 'bundle', 'create', out, '--all']);
  if (r.status !== 0) {
    log(`FAILED bundle ${name}: ${r.stderr?.trim()}`);
    continue;
  }
  fs.chmodSync(out, 0o600);
  log(`bundle ${name}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MiB  (${dir})`);
  // Uncommitted tracked work is part of "the state", so record it as a patch.
  const d = sh('git', ['-C', dir, 'diff', 'HEAD']);
  if (d.status === 0 && d.stdout.trim()) {
    fs.writeFileSync(path.join(dest, 'patches', `${name}-uncommitted.patch`), d.stdout, { mode: 0o600 });
    log(`patch  ${name}: ${d.stdout.split('\n').length} lines uncommitted`);
  }
}
for (const [name, dir] of [['legacy-openclaw', `${ARCHIVE}/legacy-openclaw`], ['qq-bridge', `${ARCHIVE}/qq-bridge`]]) {
  if (fs.existsSync(dir)) log(`archive ${name}: present at ${dir}`);
}

// ---------------------------------------------------------------- config plane
const CFG = path.join(dest, 'config');
const copies = [
  [`${STATE_DIR}/openclaw.json`, 'openclaw.json'],
  [`${STATE_DIR}/runtime-env.json`, 'runtime-env.json'],
  [`${STATE_DIR}/http-token`, 'http-token'],
  [`${STATE_DIR}/ws-token`, 'ws-token'],
  [`${STATE_DIR}/config-journal-fingerprint.key`, 'config-journal-fingerprint.key'],
  [`${STATE_DIR}/projects.json`, 'projects.json'],
  [`${STATE_DIR}/plugins/package.json`, 'plugins.package.json'],
  [`${STATE_DIR}/plugins/package-lock.json`, 'plugins.package-lock.json'],
  [`${REPO_ROOT}/config/runtime.config.json`, 'repo-runtime.config.json']
];
for (const [src, name] of copies) {
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(CFG, name));
    fs.chmodSync(path.join(CFG, name), 0o600);
  }
}
const unitDir = path.join(CFG, 'systemd');
fs.mkdirSync(unitDir, { recursive: true, mode: 0o700 });
for (const src of [
  ...(fs.existsSync('/home/afrangry/.config/systemd/user') ? fs.readdirSync('/home/afrangry/.config/systemd/user').filter((f) => f.endsWith('.service')).map((f) => `/home/afrangry/.config/systemd/user/${f}`) : []),
  '/etc/systemd/system/dsh-web.service'
]) {
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(unitDir, path.basename(src)));
}
log(`config: ${fs.readdirSync(CFG).length} entries + ${fs.readdirSync(unitDir).length} unit(s)`);

// ---------------------------------------------------------------- consistent DBs
const STATE_OUT = path.join(dest, 'state', 'runtime');
let dbs = [];
const walk = (dir, depth = 0) => {
  if (depth > 4) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (e.name === 'tmp') continue;
      walk(p, depth + 1);
    } else if (e.name.endsWith('.sqlite')) dbs.push(p);
  }
};
walk(STATE_DIR);
dbs = [...new Set(dbs)].sort();
let ok = 0;
for (const src of dbs) {
  const out = path.join(STATE_OUT, src.replace(/^\//, ''));
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  try {
    const db = new DatabaseSync(src, { readOnly: true });
    db.exec(`VACUUM INTO '${out.replace(/'/g, "''")}'`);
    db.close();
    ok++;
  } catch (e) {
    log(`FAILED snapshot ${src}: ${e.message}`);
  }
}
log(`databases: ${ok}/${dbs.length} consistent snapshots`);

// Small non-database runtime state (channel ledger, stickers, receipts, agent sessions).
for (const sub of ['channel', 'agents', 'migration', 'projects']) {
  const src = path.join(STATE_DIR, sub);
  if (!fs.existsSync(src)) continue;
  sh('rsync', ['-a', '--exclude=*.sqlite*', '--exclude=*.log', `${src}/`, path.join(STATE_OUT.replace(/\/runtime$/, ''), sub) + '/']);
}
log('channel/agent JSON state copied (databases excluded, snapshotted above)');

// ---------------------------------------------------------------- metadata + manifest
const meta = [];
meta.push(`# Fusion backup ${stamp}-${label}`);
meta.push(`# host ${sh('hostname').stdout?.trim()}  node ${process.version}`);
for (const [name, dir] of REPOS) {
  if (!fs.existsSync(path.join(dir, '.git'))) continue;
  meta.push(`\n## ${name} (${dir})`);
  meta.push(`HEAD      ${sh('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout?.trim()}`);
  meta.push(`branch    ${sh('git', ['-C', dir, 'rev-parse', '--abbrev-ref', 'HEAD']).stdout?.trim()}`);
  meta.push(`branches  ${sh('git', ['-C', dir, 'branch', '--format=%(refname:short)']).stdout?.trim().split('\n').join(' ')}`);
  meta.push(`remotes   ${sh('git', ['-C', dir, 'remote', '-v']).stdout?.trim().split('\n').join(' | ')}`);
  meta.push(`status    ${sh('git', ['-C', dir, 'status', '--porcelain=v1']).stdout?.trim() || '(clean)'}`);
}
for (const u of ['kurumi-fusion', 'snowluma', 'snowluma-qq', 'qq-bridge', 'openclaw-gateway']) {
  meta.push(`service ${u}: active=${sh('systemctl', ['--user', 'is-active', u]).stdout?.trim()} enabled=${sh('systemctl', ['--user', 'is-enabled', u]).stdout?.trim()}`);
}
meta.push(`\nsqlite snapshots: ${ok}/${dbs.length}`);
fs.writeFileSync(path.join(dest, 'meta', 'backup-meta.txt'), meta.join('\n') + '\n', { mode: 0o600 });

const files = [];
const collect = (dir, base = '') => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const p = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    // A symlink to a directory reports isDirectory() === false here; record it as a link rather
    // than trying to read it as a file.
    if (e.isSymbolicLink()) {
      files.push(rel);
      continue;
    }
    if (e.isDirectory()) collect(p, rel);
    else if (e.name !== 'MANIFEST.sha256') files.push(rel);
  }
};
collect(dest);
const lines = files.map((rel) => {
  const full = path.join(dest, rel);
  const st = fs.lstatSync(full);
  const h = st.isSymbolicLink()
    ? createHash('sha256').update(`symlink:${fs.readlinkSync(full)}`).digest('hex')
    : createHash('sha256').update(fs.readFileSync(full)).digest('hex');
  return `${h}  ${rel}`;
});
fs.writeFileSync(path.join(dest, 'MANIFEST.sha256'), lines.join('\n') + '\n', { mode: 0o600 });

console.log(JSON.stringify({ backup: dest, files: files.length, databases: `${ok}/${dbs.length}`, manifest: true }, null, 2));
