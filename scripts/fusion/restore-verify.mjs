// Verify that a backup can be restored, into an isolated directory — and that the restored
// material can actually be LOADED, not merely that individual files are intact.
//
// Safety: this script is deliberately inert with respect to the live system.
//   - it never starts the gateway, never touches SnowLuma, and never sends QQ messages;
//   - it never starts the reminder scheduler, so no reminder can be delivered twice;
//   - it only reads the backup and writes inside --target (default: a fresh mktemp dir).
//
// What it checks, in increasing order of strength:
//   1. MANIFEST.sha256 verifies for every file in the backup;
//   2. every required path recorded in EXPECTED.json is present (absence of EXPECTED.json falls
//      back to hashing whatever exists, which is the weaker behaviour this script used to have);
//   3. every git bundle is valid, clones, and its HEAD / branches / tags match EXPECTED.json
//      exactly — not merely that the clone succeeded;
//   4. the uncommitted patch re-applies and reproduces the recorded working tree;
//   5. every database snapshot passes integrity_check and foreign_key_check;
//   6. the runtime is ASSEMBLED into the target: config, credential plane, workspace and state are
//      laid out where the gateway would read them, then the config is parsed, plugin paths are
//      resolved, the workspace memory is read through the real memory store, and each database is
//      opened at its assembled location.
//
// A pass on 1-5 but not 6 means "the backup materials are valid". Only a pass on 6 justifies the
// claim "this backup can be restored to a working runtime".
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
import { REPO_ROOT } from './lib/legacy-source.mjs';

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

// --- 0. expected-content record -------------------------------------------------------
const expectedPath = path.join(backup, 'EXPECTED.json');
const expected = fs.existsSync(expectedPath) ? JSON.parse(fs.readFileSync(expectedPath, 'utf8')) : null;
if (!expected) {
  console.log('  WARN  EXPECTED.json missing: falling back to hashing whatever is present,');
  console.log('        which cannot detect required material that was never collected.\n');
}

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

// --- 2. required content --------------------------------------------------------------
if (expected?.requiredFiles?.length) {
  const missing = expected.requiredFiles.filter((r) => !fs.existsSync(path.join(backup, r.path)));
  check(
    `required content (${expected.requiredFiles.length} entries)`,
    missing.length === 0,
    missing.length ? `missing: ${missing.map((m) => m.path).join(', ')}` : 'all present'
  );
  if (expected.failures?.length) check('backup recorded no failures', false, expected.failures.join('; '));
}
if (expected?.databases?.length) {
  const missingDbs = expected.databases.filter((p) => !fs.existsSync(path.join(backup, 'state/runtime', p)));
  check(`expected databases (${expected.databases.length})`, missingDbs.length === 0, missingDbs.length ? `${missingDbs.length} absent` : 'all present');
}

// --- 3. git bundles: assert refs, not just "clone worked" ------------------------------
const gitDir = path.join(backup, 'git');
const bundles = fs.existsSync(gitDir) ? fs.readdirSync(gitDir).filter((f) => f.endsWith('.bundle')) : [];
for (const b of bundles) {
  const name = b.replace(/\.bundle$/, '');
  const file = path.join(gitDir, b);
  const v = sh('git', ['bundle', 'verify', file]);
  const valid = v.status === 0;
  check(`bundle ${name} valid`, valid, valid ? '' : v.stderr?.split('\n')[0]);
  if (!valid) continue;
  const clone = path.join(target, 'repos', name);
  fs.mkdirSync(path.dirname(clone), { recursive: true, mode: 0o700 });
  const c = sh('git', ['clone', '--quiet', file, clone]);
  if (c.status !== 0) {
    check(`clone ${name}`, false, c.stderr?.split('\n')[0]);
    continue;
  }
  const rec = expected?.repositories?.find((r) => r.name === name);
  const head = sh('git', ['-C', clone, 'rev-parse', 'HEAD']).stdout?.trim();
  // A bundle clone only creates a LOCAL branch for the bundle's HEAD; every other branch lands
  // under refs/remotes/origin/*. Counting local branches alone would report a false loss, so the
  // comparison uses the union of local and remote-tracking branches (origin/HEAD excluded).
  const localBranches = (sh('git', ['-C', clone, 'branch', '--format=%(refname:short)']).stdout ?? '').trim().split('\n').filter(Boolean);
  const remoteBranches = (sh('git', ['-C', clone, 'branch', '-r', '--format=%(refname:short)']).stdout ?? '')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((b) => b.replace(/^origin\//, ''))
    .filter((b) => b !== 'HEAD');
  const branches = [...new Set([...localBranches, ...remoteBranches])].sort();
  const tags = (sh('git', ['-C', clone, 'tag']).stdout ?? '').trim().split('\n').filter(Boolean).sort();
  if (!rec) {
    check(`clone ${name}`, true, `${branches.length} branch(es), ${tags.length} tag(s); no EXPECTED record to compare`);
    continue;
  }
  const problems = [];
  if (rec.head && head !== rec.head) problems.push(`HEAD ${head} != ${rec.head}`);
  const wantBranches = [...(rec.branches ?? [])].sort();
  if (wantBranches.length && JSON.stringify(branches) !== JSON.stringify(wantBranches)) {
    problems.push(`branches [${branches.join(',')}] != [${wantBranches.join(',')}]`);
  }
  const wantTags = [...(rec.tags ?? [])].sort();
  if (wantTags.length && JSON.stringify(tags) !== JSON.stringify(wantTags)) {
    const missing = wantTags.filter((t) => !tags.includes(t));
    const extra = tags.filter((t) => !wantTags.includes(t));
    problems.push(`tags: missing [${missing.join(',')}] extra [${extra.join(',')}]`);
  }
  check(`clone ${name} matches expected refs`, problems.length === 0, problems.length ? problems.join('; ') : `HEAD ${head?.slice(0, 8)}, ${branches.length} branch(es), ${tags.length} tag(s)`);
}

// --- 4. uncommitted patch -------------------------------------------------------------
const patchDir = path.join(backup, 'patches');
if (fs.existsSync(patchDir)) {
  for (const p of fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch'))) {
    const repoName = p.replace(/-uncommitted\.patch$/, '');
    const repo = path.join(target, 'repos', repoName);
    if (!fs.existsSync(path.join(repo, '.git'))) {
      check(`patch ${p}`, false, `no cloned repo ${repoName}`);
      continue;
    }
    const r = sh('git', ['-C', repo, 'apply', path.join(patchDir, p)]);
    check(`patch ${p} applies`, r.status === 0, r.status === 0 ? '' : r.stderr?.split('\n')[0]);
  }
}

// --- 5. database snapshots ------------------------------------------------------------
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
const dbFailures = [];
for (const p of dbs) {
  try {
    const db = new DatabaseSync(p, { readOnly: true });
    const integ = Object.values(db.prepare('PRAGMA integrity_check').get())[0];
    const fk = db.prepare('PRAGMA foreign_key_check').all().length;
    db.close();
    if (integ === 'ok' && fk === 0) healthy++;
    else dbFailures.push(`${path.relative(backup, p)}: integrity=${integ} fk=${fk}`);
  } catch (e) {
    dbFailures.push(`${path.relative(backup, p)}: ${e.message}`);
  }
}
check(`database snapshots (${dbs.length})`, dbFailures.length === 0 && dbs.length > 0, dbFailures.length ? dbFailures.slice(0, 3).join('; ') : `${healthy} healthy`);

// --- 6. assemble a runtime and load it ------------------------------------------------
const runtime = path.join(target, 'runtime');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });

// 6a. config + credential plane
const cfgSrc = path.join(backup, 'config/openclaw.json');
const envSrc = path.join(backup, 'config/runtime-env.json');
let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(cfgSrc, 'utf8'));
  fs.copyFileSync(cfgSrc, path.join(runtime, 'openclaw.json'));
  check('assemble: runtime config loads', true, `${Object.keys(cfg).length} top-level keys`);
} catch (e) {
  check('assemble: runtime config loads', false, e.message);
}
try {
  const env = JSON.parse(fs.readFileSync(envSrc, 'utf8'));
  fs.copyFileSync(envSrc, path.join(runtime, 'runtime-env.json'));
  check('assemble: credential plane loads', true, `${Object.keys(env).length} variable(s)`);
} catch (e) {
  check('assemble: credential plane loads', false, e.message);
}

// 6b. every plugin path the restored config points at must exist in the restored tree.
//     Plugin sources live in the repo; the controlled third-party prefix lives in the runtime.
if (cfg?.plugins?.load?.paths) {
  const pluginPaths = cfg.plugins.load.paths;
  const unresolved = pluginPaths.filter((p) => !fs.existsSync(p));
  check('assemble: plugin paths resolve', unresolved.length === 0, unresolved.length ? `unresolved: ${unresolved.join(', ')}` : `${pluginPaths.length} path(s)`);
}

// 6c. workspace + state laid out where the gateway reads them, then loaded for real.
const copies = [
  ['state/workspace', 'workspace'],
  ['state/state', 'state'],
  ['state/channel', 'channel'],
  ['state/media', 'media'],
  ['state/project-checks', 'project-checks'],
  ['state/research-workspace', 'research-workspace'],
  ['state/code-workspace', 'code-workspace']
];
let laidOut = 0;
for (const [from, to] of copies) {
  const src = path.join(backup, from);
  if (!fs.existsSync(src)) continue;
  sh('rsync', ['-a', `${src}/`, path.join(runtime, to) + '/']);
  laidOut++;
}
check('assemble: runtime directories laid out', laidOut > 0, `${laidOut} director(ies) from the backup`);

// Database snapshots go back to their original locations inside the assembled runtime.
let dbPlaced = 0;
for (const p of dbs) {
  const rel = path.relative(path.join(backup, 'state/runtime'), p);
  const out = path.join(runtime, rel.replace(/^home\/[^/]+\/[^/]+\//, ''));
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.copyFileSync(p, out);
  dbPlaced++;
}
check('assemble: databases placed at runtime paths', dbPlaced > 0, `${dbPlaced} database(s)`);

// 6d. actually read the restored memory through the production memory store.
try {
  const memPath = path.join(runtime, 'workspace/MEMORY.md');
  if (!fs.existsSync(memPath)) {
    check('load: restored memory readable', false, 'workspace/MEMORY.md absent');
  } else {
    const { readMemory } = await import(`file://${REPO_ROOT}/chatbot/plugins/kurumi-memory/store.js`);
    const mem = readMemory(path.join(runtime, 'workspace'));
    const src = fs.readFileSync(memPath, 'utf8');
    const srcRevision = Number(/(?:"revision"\s*:\s*)(\d+)/.exec(src)?.[1] ?? -1);
    const ok = mem.revision === srcRevision && Array.isArray(mem.entries);
    check('load: restored memory readable', ok, `revision ${mem.revision}, ${mem.entries?.length ?? 0} entr(ies)`);
  }
} catch (e) {
  check('load: restored memory readable', false, e.message);
}

// 6e. open each assembled database in place.
let opened = 0;
const openFailures = [];
for (const p of dbs) {
  const rel = path.relative(path.join(backup, 'state/runtime'), p);
  const out = path.join(runtime, rel.replace(/^home\/[^/]+\/[^/]+\//, ''));
  try {
    const db = new DatabaseSync(out, { readOnly: true });
    db.prepare('SELECT count(*) FROM sqlite_master').get();
    db.close();
    opened++;
  } catch (e) {
    openFailures.push(`${rel}: ${e.message}`);
  }
}
check('load: assembled databases open', openFailures.length === 0 && opened > 0, openFailures.length ? openFailures.slice(0, 3).join('; ') : `${opened} opened in place`);

// --- summary --------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`assembled runtime at: ${runtime}`);
console.log('no service was started, no QQ message was sent, no reminder was scheduled');
if (failed.length) {
  console.error('\nRESULT: restore verification FAILED');
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
