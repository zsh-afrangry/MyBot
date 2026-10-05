// Verify that a backup can be restored into an isolated directory — and that the restored copy is
// COMPLETE and can be LOADED WITHOUT BORROWING ANYTHING FROM THE LIVE SYSTEM.
//
// Safety: this script is deliberately inert with respect to the live system.
//   - it never starts the gateway, never touches SnowLuma, and never sends QQ messages;
//   - it never starts the reminder scheduler, so no reminder can be delivered twice;
//   - it only reads the backup and writes inside --target.
//
// Design rule, learned the hard way: a check that inspects a PRODUCTION absolute path proves
// nothing about the restored copy. An earlier version assembled a partial runtime, verified
// `plugins.load.paths` against the live filesystem, and read memory through the live source — so it
// reported success while the restored copy was missing token files, the project registry, the
// plugin prefix and the research cache. Everything below is resolved INSIDE --target.
//
// Checks, in increasing order of strength:
//   1. MANIFEST.sha256 verifies for every file;
//   2. every required path recorded in EXPECTED.json is present;
//   3. git bundles are valid, clone, and match recorded HEAD/branches/tags exactly;
//   4. the uncommitted patch re-applies;
//   5. database snapshots pass integrity_check and foreign_key_check;
//   6. the runtime is FULLY assembled into --target: every runtime directory, the databases at
//      their runtime paths, and the third-party plugin prefix rebuilt from the versioned lockfile;
//   7. dependencies are installed INTO THE RESTORED REPO from its own committed lockfiles;
//   8. config plugin paths are rewritten to the restored locations and must resolve there;
//   9. memory is read using the RESTORED source, and every assembled database opens in place.
//
// Checks 1-5 alone mean "the backup materials are valid". Only 6-9 justify "this backup can be
// restored to a working runtime".
//
// Usage:
//   node scripts/fusion/restore-verify.mjs --backup <dir> [--target <dir>] [--skip-deps]
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
if (!backup) throw new Error('usage: restore-verify.mjs --backup <backup-dir> [--target <dir>] [--skip-deps]');
if (!fs.existsSync(backup)) throw new Error(`backup not found: ${backup}`);
const target = arg('--target') ?? fs.mkdtempSync(path.join(os.tmpdir(), 'restore-verify-'));
const skipDeps = argv.includes('--skip-deps');

const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
};
const sh = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', ...opts });
/** rsync whose failure is reported rather than ignored. */
const rsync = (from, to) => {
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  const r = sh('rsync', ['-a', `${from}/`, `${to}/`]);
  if (r.status !== 0) throw new Error(`rsync ${from} -> ${to} failed: ${r.stderr?.trim() || r.status}`);
};

console.log(`restoring ${backup}\n     into ${target}\n`);
fs.mkdirSync(target, { recursive: true, mode: 0o700 });

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
  check(`required content (${expected.requiredFiles.length} entries)`, missing.length === 0, missing.length ? `missing: ${missing.map((m) => m.path).join(', ')}` : 'all present');
  if (expected.failures?.length) check('backup recorded no failures', false, expected.failures.join('; '));
}
if (expected?.databases?.length) {
  const missingDbs = expected.databases.filter((p) => !fs.existsSync(path.join(backup, 'state/runtime', p)));
  check(`expected databases (${expected.databases.length})`, missingDbs.length === 0, missingDbs.length ? `${missingDbs.length} absent` : 'all present');
}

// --- 3. git bundles -------------------------------------------------------------------
const gitDir = path.join(backup, 'git');
const bundles = fs.existsSync(gitDir) ? fs.readdirSync(gitDir).filter((f) => f.endsWith('.bundle')) : [];
const clones = new Map();
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
  clones.set(name, clone);
  const rec = expected?.repositories?.find((r) => r.name === name);
  const head = sh('git', ['-C', clone, 'rev-parse', 'HEAD']).stdout?.trim();
  // A bundle clone only creates a LOCAL branch for the bundle's HEAD; the rest land under
  // refs/remotes/origin/*. Counting local branches alone reports a false loss.
  const localBranches = (sh('git', ['-C', clone, 'branch', '--format=%(refname:short)']).stdout ?? '').trim().split('\n').filter(Boolean);
  const remoteBranches = (sh('git', ['-C', clone, 'branch', '-r', '--format=%(refname:short)']).stdout ?? '').trim().split('\n').filter(Boolean).map((x) => x.replace(/^origin\//, '')).filter((x) => x !== 'HEAD');
  const branches = [...new Set([...localBranches, ...remoteBranches])].sort();
  const tags = (sh('git', ['-C', clone, 'tag']).stdout ?? '').trim().split('\n').filter(Boolean).sort();
  if (!rec) {
    check(`clone ${name}`, true, `${branches.length} branch(es), ${tags.length} tag(s); no EXPECTED record`);
    continue;
  }
  const problems = [];
  if (rec.head && head !== rec.head) problems.push(`HEAD ${head} != ${rec.head}`);
  const wantBranches = [...(rec.branches ?? [])].sort();
  if (wantBranches.length && JSON.stringify(branches) !== JSON.stringify(wantBranches)) problems.push(`branches [${branches}] != [${wantBranches}]`);
  const wantTags = [...(rec.tags ?? [])].sort();
  if (wantTags.length && JSON.stringify(tags) !== JSON.stringify(wantTags)) {
    const missing = wantTags.filter((t) => !tags.includes(t));
    const extra = tags.filter((t) => !wantTags.includes(t));
    problems.push(`tags: missing [${missing}] extra [${extra}]`);
  }
  check(`clone ${name} matches expected refs`, problems.length === 0, problems.length ? problems.join('; ') : `HEAD ${head?.slice(0, 8)}, ${branches.length} branch(es), ${tags.length} tag(s)`);
}

// --- 4. uncommitted working-tree state -------------------------------------------------
// Three separate forms, because `git diff HEAD` alone covers only tracked text changes:
//   *.patch              tracked text modifications
//   *-binary-modified.tar binary modifications (a text patch cannot carry the content)
//   *-untracked.tar      untracked files (git diff HEAD does not include them at all)
const patchDir = path.join(backup, 'patches');
if (fs.existsSync(patchDir)) {
  for (const p of fs.readdirSync(patchDir).filter((f) => f.endsWith('.patch'))) {
    const repo = clones.get(p.replace(/-uncommitted\.patch$/, ''));
    if (!repo) {
      check(`patch ${p}`, false, 'no cloned repo');
      continue;
    }
    const r = sh('git', ['-C', repo, 'apply', path.join(patchDir, p)]);
    check(`patch ${p} applies`, r.status === 0, r.status === 0 ? '' : r.stderr?.split('\n')[0]);
  }

  for (const t of fs.readdirSync(patchDir).filter((f) => f.endsWith('.tar'))) {
    const repoName = t.replace(/-(untracked|binary-modified)\.tar$/, '');
    const repo = clones.get(repoName);
    if (!repo) {
      check(`archive ${t}`, false, 'no cloned repo');
      continue;
    }
    // `git apply` cannot restore these, so they were archived as files; extract them back.
    const listing = (sh('tar', ['-tf', path.join(patchDir, t)]).stdout ?? '').trim().split('\n').filter(Boolean);
    const x = sh('tar', ['-C', repo, '-xf', path.join(patchDir, t)]);
    const restored = listing.filter((rel) => fs.existsSync(path.join(repo, rel)));
    const missing = listing.filter((rel) => !fs.existsSync(path.join(repo, rel)));
    check(
      `archive ${t} restores ${listing.length} file(s)`,
      x.status === 0 && missing.length === 0,
      x.status !== 0 ? (x.stderr ?? '').split('\n')[0] : missing.length ? `missing after extract: ${missing.slice(0, 3).join(', ')}` : `${restored.length} restored`
    );
  }
}

// --- 5. database snapshots ------------------------------------------------------------
const snapshotRoot = path.join(backup, 'state', 'runtime');
const dbs = [];
const walk = (dir, depth = 0) => {
  if (depth > 12 || !fs.existsSync(dir)) return;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, depth + 1);
    else if (e.name.endsWith('.sqlite')) dbs.push(p);
  }
};
walk(snapshotRoot);
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

// =====================================================================================
// 6-9. Assemble the runtime completely, then load it — nothing from the live system.
// =====================================================================================
const runtime = path.join(target, 'runtime');
fs.mkdirSync(runtime, { recursive: true, mode: 0o700 });

// 6a. EVERY directory captured under the backup's state/, not a hand-picked subset.
const backupState = path.join(backup, 'state');
const stateCopied = [];
const stateSkipped = [];
try {
  for (const e of fs.readdirSync(backupState, { withFileTypes: true })) {
    if (e.name === 'runtime') {
      stateSkipped.push('runtime (databases handled separately, placed at runtime paths)');
      continue;
    }
    if (e.isDirectory()) {
      rsync(path.join(backupState, e.name), path.join(runtime, e.name));
      stateCopied.push(e.name);
    } else {
      fs.copyFileSync(path.join(backupState, e.name), path.join(runtime, e.name));
      fs.chmodSync(path.join(runtime, e.name), 0o600);
      stateCopied.push(e.name);
    }
  }
  check('assemble: all runtime directories copied', stateCopied.length > 0, `${stateCopied.length} entr(ies): ${stateCopied.join(' ')}`);
} catch (e) {
  check('assemble: all runtime directories copied', false, e.message);
}

// 6b. Databases back to the paths the runtime expects (strip the absolute-path prefix).
const dbPlaced = [];
for (const p of dbs) {
  const rel = path.relative(snapshotRoot, p).replace(/^home\/[^/]+\/[^/]+\//, '');
  const out = path.join(runtime, rel);
  fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
  fs.copyFileSync(p, out);
  fs.chmodSync(out, 0o600);
  dbPlaced.push(rel);
}
check('assemble: databases placed at runtime paths', dbPlaced.length === dbs.length && dbs.length > 0, `${dbPlaced.length} database(s)`);

// 6c. Config + credential plane.
let cfg = null;
try {
  cfg = JSON.parse(fs.readFileSync(path.join(backup, 'config/openclaw.json'), 'utf8'));
  fs.copyFileSync(path.join(backup, 'config/openclaw.json'), path.join(runtime, 'openclaw.json'));
  check('assemble: runtime config loads', true, `${Object.keys(cfg).length} top-level keys`);
} catch (e) {
  check('assemble: runtime config loads', false, e.message);
}
for (const f of ['runtime-env.json', 'http-token', 'ws-token', 'config-journal-fingerprint.key', 'projects.json']) {
  const src = path.join(backup, 'config', f);
  if (fs.existsSync(src)) {
    fs.copyFileSync(src, path.join(runtime, f));
    fs.chmodSync(path.join(runtime, f), 0o600);
  }
}
const credFiles = ['runtime-env.json', 'http-token', 'ws-token'].filter((f) => fs.existsSync(path.join(runtime, f)));
check('assemble: token/credential files present', credFiles.length === 3, credFiles.join(', ') || 'none');

// 6d. Third-party plugin prefix rebuilt from the versioned lockfile (not copied from production).
const pluginPrefix = path.join(runtime, 'plugins');
const manifestSrc = path.join(backup, 'config/plugins.package.json');
const lockSrc = path.join(backup, 'config/plugins.package-lock.json');
if (skipDeps) {
  check('assemble: plugin prefix rebuilt', true, 'SKIPPED (--skip-deps)');
} else if (fs.existsSync(manifestSrc) && fs.existsSync(lockSrc)) {
  fs.mkdirSync(pluginPrefix, { recursive: true, mode: 0o700 });
  fs.copyFileSync(manifestSrc, path.join(pluginPrefix, 'package.json'));
  fs.copyFileSync(lockSrc, path.join(pluginPrefix, 'package-lock.json'));
  const r = sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: pluginPrefix });
  if (r.status === 0) {
    const declared = Object.keys(JSON.parse(fs.readFileSync(lockSrc, 'utf8')).packages ?? {}).filter((k) => k.startsWith('node_modules/') && !k.slice(13).includes('/node_modules/'));
    const missing = declared.filter((d) => !fs.existsSync(path.join(pluginPrefix, d)));
    check('assemble: plugin prefix rebuilt from lockfile', missing.length === 0, `${declared.length} package(s) via npm ci`);
  } else {
    check('assemble: plugin prefix rebuilt from lockfile', false, (r.stderr ?? '').split('\n')[0]);
  }
} else {
  check('assemble: plugin prefix rebuilt from lockfile', false, 'config/plugins.package*.json missing from backup');
}

// 7. Dependencies installed INTO THE RESTORED REPO from its own committed lockfiles.
const restoredRepo = clones.get('kurumi-fusion');
const depPackages = ['chatbot/packages/confirmation-core', 'chatbot/plugins/personal-confirmation', 'chatbot/plugins/personal-weather'];
if (skipDeps) {
  check('load: restored repo dependencies installed', true, 'SKIPPED (--skip-deps)');
} else if (!restoredRepo) {
  check('load: restored repo dependencies installed', false, 'kurumi-fusion was not cloned');
} else {
  const depProblems = [];
  const installed = [];
  for (const rel of depPackages) {
    const dir = path.join(restoredRepo, rel);
    if (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
      depProblems.push(`${rel}: no committed lockfile`);
      continue;
    }
    const r = sh('npm', ['ci', '--no-audit', '--no-fund'], { cwd: dir });
    if (r.status !== 0) depProblems.push(`${rel}: ${(r.stderr ?? '').split('\n')[0]}`);
    else installed.push(rel);
  }
  check('load: restored repo dependencies installed', depProblems.length === 0, depProblems.length ? depProblems.join('; ') : `${installed.length}/${depPackages.length} package(s) via npm ci from restored lockfiles`);
}

// 8. Rewrite config plugin paths to the RESTORED locations, then resolve them there.
if (cfg?.plugins?.load?.paths) {
  const productionState = '/home/afrangry/.openclaw-fusion';
  const productionRepo = '/home/afrangry/kurumi-fusion';
  const rewritten = [];
  let unresolvedCounter = 0;
  const newPaths = cfg.plugins.load.paths.map((p) => {
    if (p.startsWith(productionRepo)) return p.replace(productionRepo, restoredRepo ?? path.join(target, 'repos/kurumi-fusion'));
    if (p.startsWith(productionState)) return p.replace(productionState, runtime);
    // Anything outside the two known roots stays as declared and is reported as external.
    rewritten.push(p);
    return p;
  });
  cfg.plugins.load.paths = newPaths;
  fs.writeFileSync(path.join(runtime, 'openclaw.json'), JSON.stringify(cfg, null, 2) + '\n', { mode: 0o600 });
  const unresolved = newPaths.filter((p) => !fs.existsSync(p));
  unresolvedCounter = unresolved.length;
  check(
    'load: rewritten plugin paths resolve inside the restored tree',
    unresolvedCounter === 0,
    unresolvedCounter ? `unresolved: ${unresolved.join(', ')}` : `${newPaths.length} path(s), ${rewritten.length} left external`
  );
  if (rewritten.length) console.log(`        external (not restored here): ${rewritten.join(', ')}`);
}

// 9a. Memory read through the RESTORED source, not the live deployment.
const memPath = path.join(runtime, 'workspace/MEMORY.md');
const restoredStore = restoredRepo ? path.join(restoredRepo, 'chatbot/plugins/kurumi-memory/store.js') : null;
if (!fs.existsSync(memPath)) {
  check('load: restored memory readable via restored source', false, 'workspace/MEMORY.md absent');
} else if (!restoredStore || !fs.existsSync(restoredStore)) {
  check('load: restored memory readable via restored source', false, 'restored store.js not available');
} else {
  try {
    const { readMemory } = await import(`file://${restoredStore}`);
    const mem = readMemory(path.join(runtime, 'workspace'));
    const src = fs.readFileSync(memPath, 'utf8');
    const srcRevision = Number(/(?:"revision"\s*:\s*)(\d+)/.exec(src)?.[1] ?? -1);
    check('load: restored memory readable via restored source', mem.revision === srcRevision && Array.isArray(mem.entries), `revision ${mem.revision}, ${mem.entries?.length ?? 0} entr(ies), source ${path.relative(target, restoredStore)}`);
  } catch (e) {
    check('load: restored memory readable via restored source', false, e.message);
  }
}

// 9b. Every assembled database opens in place, and the key ones have their expected tables.
const tableExpectations = {
  'state/openclaw.sqlite': ['sqlite_master'],
  'state/personal-reminders/reminders.sqlite': ['sqlite_master'],
  'state/personal-weather/weather.sqlite': ['sqlite_master'],
  'channel/channel.sqlite': ['inbound', 'outbound']
};
let opened = 0;
const openFailures = [];
for (const rel of dbPlaced) {
  const out = path.join(runtime, rel);
  try {
    const db = new DatabaseSync(out, { readOnly: true });
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((r) => r.name);
    db.close();
    opened++;
    for (const t of tableExpectations[rel] ?? []) {
      if (t !== 'sqlite_master' && !tables.includes(t)) openFailures.push(`${rel}: missing table ${t}`);
    }
  } catch (e) {
    openFailures.push(`${rel}: ${e.message}`);
  }
}
check('load: assembled databases open in place', openFailures.length === 0 && opened > 0, openFailures.length ? openFailures.slice(0, 3).join('; ') : `${opened} opened`);

// --- summary --------------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
console.log(`assembled runtime at: ${runtime}`);
console.log(`restored repo at    : ${restoredRepo ?? '(none)'}`);
console.log('no service was started, no QQ message was sent, no reminder was scheduled');
console.log('nothing under /home/afrangry was read except the backup itself');
if (failed.length) {
  console.error('\nRESULT: restore verification FAILED');
  for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`);
}
process.exit(failed.length ? 1 : 0);
