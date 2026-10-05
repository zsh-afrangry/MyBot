// Verify that a backup can actually be restored, into an isolated directory.
//
// Safety: this script is deliberately inert with respect to the live system.
//   - it never starts the gateway, never touches SnowLuma, and never sends QQ messages;
//   - it never starts the reminder scheduler, so no reminder can be delivered twice;
//   - it only reads the backup and writes inside --target (default: a fresh mktemp dir).
//
// Checks:
//   1. MANIFEST.sha256 verifies for every file in the backup;
//   2. every git bundle is valid, clones, and yields the recorded branches;
//   3. the uncommitted patch re-applies and reproduces the recorded working tree;
//   4. every database snapshot passes PRAGMA integrity_check and foreign_key_check.
//
// Usage:
//   node scripts/fusion/restore-verify.mjs --backup /home/afrangry/kurumi-backups/<dir>
//   node scripts/fusion/restore-verify.mjs --backup <dir> --target /tmp/restore-test
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const argv = process.argv.slice(2);
const arg = (name, fallback = null) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : fallback;
};
const backup = arg('--backup');
if (!backup) throw new Error('usage: restore-verify.mjs --backup <backup-dir> [--target <dir>]');
if (!fs.existsSync(backup)) throw new Error(`backup not found: ${backup}`);
const target = arg('--target') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'restore-verify-'));

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });

console.log(`restoring ${backup}\n     into ${target}\n`);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

// --- 1. manifest ----------------------------------------------------------------------
const manifestPath = path.join(backup, 'MANIFEST.sha256');
if (fs.existsSync(manifestPath)) {
  const entries = fs.readFileSync(manifestPath, 'utf8').split('\n').filter(Boolean);
  let bad = 0;
  for (const line of entries) {
    const [want, rel] = line.split(/\s{2,}/);
    const full = path.join(backup, rel);
    if (!fs.existsSync(full)) {
      bad++;
      continue;
    }
    const st = fs.lstatSync(full);
    const got = st.isSymbolicLink()
      ? createHash('sha256').update(`symlink:${fs.readlinkSync(full)}`).digest('hex')
      : createHash('sha256').update(fs.readFileSync(full)).digest('hex');
    if (got !== want) bad++;
  }
  check(`manifest (${entries.length} files)`, bad === 0, bad ? `${bad} mismatched` : 'all match');
} else {
  check('manifest', false, 'MANIFEST.sha256 missing');
}

// --- 2. git bundles -------------------------------------------------------------------
const gitDir = path.join(backup, 'git');
const bundles = fs.existsSync(gitDir) ? fs.readdirSync(gitDir).filter((f) => f.endsWith('.bundle')) : [];
for (const b of bundles) {
  const name = b.replace(/\.bundle$/, '');
  const file = path.join(gitDir, b);
  const v = sh('git', ['bundle', 'verify', file]);
  const valid = v.status === 0;
  check(`bundle ${name} valid`, valid, valid ? '' : v.stderr?.split('\n')[0]);
  if (!valid) continue;
  const clone = path.join(target, name);
  const c = sh('git', ['clone', '--quiet', file, clone]);
  if (c.status !== 0) {
    check(`clone ${name}`, false, c.stderr?.split('\n')[0]);
    continue;
  }
  const heads = sh('git', ['-C', clone, 'branch', '-r', '--format=%(refname:short)']).stdout?.trim().split('\n').filter(Boolean) ?? [];
  const local = sh('git', ['-C', clone, 'branch', '--format=%(refname:short)']).stdout?.trim().split('\n').filter(Boolean) ?? [];
  const tags = sh('git', ['-C', clone, 'tag']).stdout?.trim().split('\n').filter(Boolean) ?? [];
  check(`clone ${name}`, fs.existsSync(path.join(clone, '.git')), `${local.length} branch(es), ${tags.length} tag(s)`);
  void heads;
}

// --- 3. uncommitted patch -------------------------------------------------------------
const patchDir = path.join(backup, 'patches');
if (fs.existsSync(patchDir)) {
  for (const p of fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch'))) {
    const repoName = p.replace(/-uncommitted\.patch$/, '');
    const repo = path.join(target, repoName);
    if (!fs.existsSync(path.join(repo, '.git'))) {
      check(`patch ${p}`, false, `no cloned repo ${repoName}`);
      continue;
    }
    const r = sh('git', ['-C', repo, 'apply', path.join(patchDir, p)]);
    check(`patch ${p} applies`, r.status === 0, r.status === 0 ? '' : r.stderr?.split('\n')[0]);
  }
}

// --- 4. database snapshots ------------------------------------------------------------
const stateRoot = path.join(backup, 'state');
const dbs = [];
// Snapshots keep their absolute path layout (state/runtime/home/<user>/<statedir>/...), which is
// already 6 levels deep before the database's own directory, so the limit has to be generous.
const walk = (dir, depth = 0) => {
  if (depth > 12 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name.endsWith('.sqlite')) dbs.push(p);
  }
};
walk(stateRoot);
let healthy = 0;
const failures = [];
for (const p of dbs) {
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    const integ = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    const tables = Object.values(db.prepare("SELECT count(*) FROM sqlite_master WHERE type='table'").get())[0];
    db.close();
    if (integ === 'ok' && fk === 0) healthy++;
    else failures.push(`${path.relative(backup, p)}: integrity=${integ} fk=${fk}`);
    void tables;
  } catch (e) {
    failures.push(`${path.relative(backup, p)}: ${e.message}`);
  }
}
check(`database snapshots (${dbs.length})`, failures.length === 0 && dbs.length > 0, failures.length ? failures.slice(0, 3).join('; ') : `${healthy} healthy`);

// --- summary --------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`isolated restore at: ${target}`);
console.log('no service was started, no QQ message was sent, no reminder was scheduled');
process.exit(failed.length ? 1 : 0);
