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

// Every failure is recorded and turns into a non-zero exit at the end. A backup that silently
// skipped a database or a repository used to still finish "successfully", which is worse than
// failing loudly: the recovery point would look valid while missing material.
// Declared BEFORE the quiesce block below, which needs to report a failed stop.
const failures = [];
const fail = (what, detail) => {
  failures.push(`${what}: ${detail}`);
  console.error(`  FAIL ${what}: ${detail}`);
};
// Recorded in EXPECTED.json so a restore can tell what non-git working-tree state was captured.
const binaryCaptured = [];

// --- cross-database consistency -------------------------------------------------------
// VACUUM INTO makes each database internally consistent, but the reminder store, the scheduler
// state and the outbound delivery ledger are separate files snapshotted one after another — so
// they can represent slightly different moments. For a rollback point that reminders will be
// reconciled against, quiescing the writer first removes that skew.
//
//   --quiesce : stop kurumi-fusion for the duration of the snapshot, then start it again.
//
// Failure handling, which the first version got wrong:
//   * the pre-existing service state is remembered, and ONLY a service that was running is
//     restarted (a service that was already stopped must stay stopped);
//   * the restart is guaranteed by a finally block, so an unexpected throw cannot leave the
//     assistant down;
//   * a failed restart is a hard failure (non-zero exit), not just a printed line;
//   * quiescing only counts as successful if the stop actually took effect.
const QUIESCE = argv.includes('--quiesce');
const SERVICE = 'kurumi-fusion.service';
const isActive = () => spawnSync('systemctl', ['--user', 'is-active', SERVICE], { encoding: 'utf8' }).stdout?.trim() === 'active';
const wasRunning = QUIESCE ? isActive() : false;
let serviceStopped = false;

const restoreService = () => {
  if (!serviceStopped) return;
  if (!wasRunning) {
    log(`${SERVICE} was already stopped before this run; leaving it stopped`);
    serviceStopped = false;
    return;
  }
  const r = spawnSync('systemctl', ['--user', 'start', SERVICE], { encoding: 'utf8' });
  serviceStopped = false;
  if (r.status !== 0) fail('quiesce restore', `could not restart ${SERVICE}: ${r.stderr?.trim() || r.status}`);
  else log(`restarted ${SERVICE} after quiesced snapshot`);
};

// Guarantee the restart even on an unexpected throw. spawnSync is synchronous, so the 'exit'
// handler can still complete the start before the process dies. restoreService() is idempotent.
process.on('exit', () => restoreService());
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, (err) => {
    restoreService();
    console.error(`  FAIL unexpected ${ev}: ${err?.stack || err}`);
    process.exit(1);
  });
}

if (QUIESCE) {
  if (!wasRunning) {
    log(`${SERVICE} was not running; nothing to quiesce (snapshot will be taken as-is)`);
  } else {
    const stop = spawnSync('systemctl', ['--user', 'stop', SERVICE], { encoding: 'utf8' });
    if (stop.status !== 0) {
      fail('quiesce', `could not stop ${SERVICE}: ${stop.stderr?.trim() || stop.status}`);
    } else {
      serviceStopped = true;
      // Wait until the gateway is really gone so no writer is mid-transaction.
      for (let i = 0; i < 40 && isActive(); i++) spawnSync('sleep', ['0.5']);
      if (isActive()) {
        fail('quiesce', `${SERVICE} still active after stop; snapshot would NOT be quiesced`);
      } else {
        log(`quiesced: ${SERVICE} stopped for a consistent cross-database snapshot`);
      }
    }
  }
}
const untrackedCaptured = [];

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
    fail(`git bundle ${name}`, r.stderr?.trim() || `git exit ${r.status}`);
    continue;
  }
  fs.chmodSync(out, 0o600);
  log(`bundle ${name}: ${(fs.statSync(out).size / 1048576).toFixed(1)} MiB  (${dir})`);

  // Uncommitted work is part of "the state". `git diff HEAD` alone only covers TRACKED changes:
  // it silently omits untracked files and reduces binary modifications to "Binary files differ".
  // Capture all three forms separately so nothing is quietly dropped.
  const d = sh('git', ['-C', dir, 'diff', 'HEAD']);
  if (d.status === 0 && d.stdout.trim()) {
    fs.writeFileSync(path.join(dest, 'patches', `${name}-uncommitted.patch`), d.stdout, { mode: 0o600 });
    log(`patch  ${name}: ${d.stdout.split('\n').length} lines uncommitted (tracked, text)`);
  }
  // NUL-separated output is required: without -z git QUOTES non-ASCII paths (e.g. Chinese
  // filenames become "\346\265\213..."), and tar then fails to stat a path that never existed.
  const numstat = sh('git', ['-C', dir, 'diff', 'HEAD', '--numstat', '-z']).stdout ?? '';
  const binary = numstat
    .split('\0')
    .filter(Boolean)
    .map((rec) => rec.split('\t'))
    .filter((f) => f.length >= 3 && f[0] === '-' && f[1] === '-')
    .map((f) => f[2])
    .filter(Boolean);
  if (binary.length) {
    // A text patch cannot carry these; tar the actual files so content is preserved.
    const tarOut = path.join(dest, 'patches', `${name}-binary-modified.tar`);
    const t = sh('tar', ['-C', dir, '-cf', tarOut, '--null', '-T', '-'], { input: binary.join('\0') + '\0' });
    if (t.status !== 0) fail(`binary capture ${name}`, t.stderr?.trim() || `tar exit ${t.status}`);
    else {
      fs.chmodSync(tarOut, 0o600);
      binaryCaptured.push(...binary.map((f) => `${name}:${f}`));
      log(`binary ${name}: ${binary.length} modified file(s) archived (text patch cannot carry them)`);
    }
  }
  const untracked = (sh('git', ['-C', dir, 'ls-files', '-z', '--others', '--exclude-standard']).stdout ?? '')
    .split('\0')
    .filter(Boolean);
  if (untracked.length) {
    const tarOut = path.join(dest, 'patches', `${name}-untracked.tar`);
    const t = sh('tar', ['-C', dir, '-cf', tarOut, '--null', '-T', '-'], { input: untracked.join('\0') + '\0' });
    if (t.status !== 0) fail(`untracked capture ${name}`, t.stderr?.trim() || `tar exit ${t.status}`);
    else {
      fs.chmodSync(tarOut, 0o600);
      untrackedCaptured.push(...untracked.map((f) => `${name}:${f}`));
      log(`untracked ${name}: ${untracked.length} file(s) archived (git diff HEAD does not include these)`);
    }
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
    // A failed snapshot is a hard failure: the backup would silently lack a database.
    fail(`sqlite snapshot ${src}`, e.message);
  }
}
if (!dbs.length) fail('sqlite snapshot', 'no databases found under the runtime directory');
log(`databases: ${ok}/${dbs.length} consistent snapshots`);

// ------------------------------------------------- non-database runtime state
//
// This used to be an allowlist of four directories (channel, agents, migration, projects), which
// silently dropped live material: workspace/ (MEMORY.md, SOUL.md, USER.md, IDENTITY.md, AGENTS.md),
// project-checks/, research-workspace/, research-cache/, source-snapshots/, code-workspace/,
// media/ and plugin-skills/. An allowlist fails open — anything new is omitted without a word.
//
// It is now the inverse: copy EVERY top-level entry except an explicit, justified skip list, so a
// newly added runtime directory is captured by default. Databases are excluded here because they
// are snapshotted consistently above.
const SKIP_TOP_LEVEL = new Set([
  'tmp', // transient work area
  'plugins', // node_modules tree; its package.json + lockfile are captured under config/
  'gateway.log', 'runtime.log', // logs; regenerated
  'gateway-pid.json' // stale pid, meaningless after restore
]);
const stateCopyRoot = STATE_OUT.replace(/\/runtime$/, '');
const copied = [];
for (const e of fs.readdirSync(STATE_DIR, { withFileTypes: true })) {
  if (SKIP_TOP_LEVEL.has(e.name)) continue;
  // Host-specific credential material lives under config/ instead.
  if (['openclaw.json', 'runtime-env.json', 'http-token', 'ws-token', 'config-journal-fingerprint.key'].includes(e.name)) continue;
  const src = path.join(STATE_DIR, e.name);
  const rel = e.name;
  const out = path.join(stateCopyRoot, rel) + (e.isDirectory() ? '/' : '');
  if (e.isDirectory()) {
    const r = sh('rsync', ['-a', '--exclude=*.sqlite*', '--exclude=*.log', '--exclude=node_modules', `${src}/`, out]);
    if (r.status !== 0) fail(`state copy ${rel}`, r.stderr?.trim() || `rsync exit ${r.status}`);
    else copied.push(rel);
  } else if (e.name.endsWith('.sqlite')) {
    continue; // already snapshotted
  } else {
    try {
      fs.copyFileSync(src, path.join(stateCopyRoot, rel));
      fs.chmodSync(path.join(stateCopyRoot, rel), 0o600);
      copied.push(rel);
    } catch (err) {
      fail(`state copy ${rel}`, err.message);
    }
  }
}
log(`runtime state copied (fail-safe, everything except skips): ${copied.sort().join(' ')}`);
for (const skipped of SKIP_TOP_LEVEL) if (fs.existsSync(path.join(STATE_DIR, skipped))) log(`  skipped by design: ${skipped}`);

// Material that must exist for a restore to be usable. Missing entries are hard failures.
// Paths are relative to the backup root: database snapshots keep their absolute layout under
// state/runtime/, while copied runtime directories sit directly under state/.
const REQUIRED = [
  ['state/runtime/home/afrangry/.openclaw-fusion/state/openclaw.sqlite', 'core state database'],
  ['state/runtime/home/afrangry/.openclaw-fusion/state/personal-reminders/reminders.sqlite', 'reminders database'],
  ['state/runtime/home/afrangry/.openclaw-fusion/state/personal-weather/weather.sqlite', 'weather/Profile database'],
  ['state/runtime/home/afrangry/.openclaw-fusion/channel/channel.sqlite', 'channel ledger'],
  ['state/runtime/home/afrangry/.openclaw-fusion/agents/main/agent/openclaw-agent.sqlite', 'main agent database'],
  ['state/workspace/MEMORY.md', 'long-term memory'],
  ['state/workspace/SOUL.md', 'persona'],
  ['state/workspace/AGENTS.md', 'behaviour rules'],
  ['state/workspace/IDENTITY.md', 'role identity'],
  ['state/workspace/USER.md', 'owner profile'],
  ['state/project-checks/fusion-memory-revision.mjs', 'project check fixture required by projects.json'],
  ['state/channel/stickers.json', 'sticker catalogue'],
  ['config/openclaw.json', 'runtime config'],
  ['config/runtime-env.json', 'credential plane']
];
for (const [rel, why] of REQUIRED) {
  if (!fs.existsSync(path.join(dest, rel))) fail(`required ${rel}`, `${why} missing from backup`);
}
log(`required-content check: ${REQUIRED.length} entries`);

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

// Expected-content record: what this backup is REQUIRED to contain, written independently of what
// was actually collected. The verifier compares against this instead of just hashing whatever
// happens to be present, so a missing required item cannot pass as "all files verified".
const expected = {
  label,
  stamp,
  createdAt: new Date().toISOString(),
  repositories: REPOS.map(([name, dir]) => {
    const head = sh('git', ['-C', dir, 'rev-parse', 'HEAD']).stdout?.trim();
    const branches = (sh('git', ['-C', dir, 'branch', '--format=%(refname:short)']).stdout ?? '').trim().split('\n').filter(Boolean);
    const tags = (sh('git', ['-C', dir, 'tag']).stdout ?? '').trim().split('\n').filter(Boolean);
    return { name, dir, head, branches, tags };
  }),
  databases: dbs.map((p) => p.replace(/^\//, '')),
  requiredFiles: REQUIRED.map(([rel, why]) => ({ path: rel, why })),
  collectedTopLevel: copied.sort(),
  skippedByDesign: [...SKIP_TOP_LEVEL],
  sqliteSnapshots: { ok, total: dbs.length },
  // Cross-database consistency: per-database snapshots are each internally consistent, but
  // successive VACUUM INTO calls do not share one instant. `quiesced` records whether the writer
  // WAS ACTUALLY stopped for this backup, which is what a reminder-reconciliation rollback point
  // needs. (`serviceStopped` is still true here: restoreService() runs after EXPECTED.json.)
  quiesced: QUIESCE && serviceStopped === true,
  quiescedRequested: QUIESCE,
  // Non-git working-tree state that `git diff HEAD` alone would have dropped.
  untrackedCaptured,
  binaryCaptured,
  failures
};
fs.writeFileSync(path.join(dest, 'EXPECTED.json'), JSON.stringify(expected, null, 2) + '\n', { mode: 0o600 });
// EXPECTED.json is written after the manifest; add it so the manifest stays complete.
const expectedHash = createHash('sha256').update(fs.readFileSync(path.join(dest, 'EXPECTED.json'))).digest('hex');
fs.appendFileSync(path.join(dest, 'MANIFEST.sha256'), `${expectedHash}  EXPECTED.json\n`);

restoreService();

if (failures.length) {
  console.error(`\nbackup FAILED: ${failures.length} problem(s); this backup is NOT a valid recovery point`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `backup ok: every required item present (cross-database consistency: ${QUIESCE ? 'quiesced' : 'concurrent — snapshots are per-database consistent only'})`
);
process.exit(0);
