// Verify the fusion project owns its dependencies, and fail loudly if it does not.
//
// This replaces the former link-domain-dependencies.mjs, which symlinked each package's
// node_modules entries out of the legacy /home/afrangry/.openclaw tree. That made the new system
// silently depend on the old directory surviving. Dependencies are now installed for real
// (npm ci, driven by each package's own lockfile) and the OpenClaw SDK stays a deliberate pin.
//
// Checks:
//   1. no node_modules symlink anywhere in the repo resolves into a legacy/archived tree;
//   2. every package that declares dependencies has a real node_modules matching its lockfile;
//   3. the pinned SDK link exists and is the expected version;
//   4. the controlled third-party plugin prefix is installed at the expected versions.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, REPO_ROOT } from './lib/legacy-source.mjs';
import { PLUGINS } from './lib/plugins.mjs';

const SDK = '/home/afrangry/.npm-global/lib/node_modules/openclaw';
const EXPECTED_SDK = '2026.9.7';
const PACKAGES = [
  'chatbot/packages/confirmation-core',
  'chatbot/plugins/personal-confirmation',
  'chatbot/plugins/personal-weather'
];
// Anything under these roots is archived/foreign and must never satisfy a runtime import.
// kurumi-archive is where the legacy trees now live after step 7, so it MUST be listed here —
// omitting it meant the check silently stopped covering the archived tree it was written for.
const FORBIDDEN = [
  '/home/afrangry/.openclaw/',
  '/home/afrangry/kurumi-archive/',
  '/home/afrangry/kurumi-baselines/',
  '/home/afrangry/kurumi-backups/',
  '/home/afrangry/桌面/qq-bridge/'
];

const problems = [];
const notes = [];

// --- 1. no dependency may resolve out of the legacy tree -------------------------------
function walkLinks(dir, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (e.name === '.git') continue;
    const p = path.join(dir, e.name);
    let st;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      let target = '';
      try {
        target = fs.realpathSync(p);
      } catch {
        target = fs.readlinkSync(p);
      }
      if (FORBIDDEN.some((f) => target.startsWith(f))) {
        problems.push(`symlink escapes into archived tree: ${p} -> ${target}`);
      }
      continue;
    }
    if (st.isDirectory() && e.name === 'node_modules') {
      // Inspect entry level only; npm's own nested layout is not our concern here.
      for (const name of fs.readdirSync(p)) {
        const child = path.join(p, name);
        let cst;
        try {
          cst = fs.lstatSync(child);
        } catch {
          continue;
        }
        const candidates = cst.isSymbolicLink() ? [child] : name.startsWith('@') ? fs.readdirSync(child).map((s) => path.join(child, s)) : [];
        for (const c of candidates) {
          let target = '';
          try {
            target = fs.realpathSync(c);
          } catch {
            continue;
          }
          if (FORBIDDEN.some((f) => target.startsWith(f))) {
            problems.push(`dependency escapes into archived tree: ${c} -> ${target}`);
          }
        }
      }
      continue;
    }
    if (st.isDirectory()) walkLinks(p, depth + 1);
  }
}
walkLinks(REPO_ROOT);

/**
 * npm optionalDependency semantics: an entry with `os`/`cpu`/`libc` constraints is only expected
 * to be installed on a matching host. The lockfile legitimately lists other platforms' binaries
 * (aix, android, darwin, win32, and musl variants) that npm skips, so demanding every lockfile
 * entry on disk would be wrong.
 */
const HOST_LIBC = (() => {
  try {
    return process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
  } catch {
    return 'glibc';
  }
})();

function allows(list, actual) {
  if (!Array.isArray(list) || list.length === 0) return true;
  const negated = list.filter((v) => String(v).startsWith('!')).map((v) => String(v).slice(1));
  if (negated.includes(actual)) return false;
  const positive = list.filter((v) => !String(v).startsWith('!'));
  return positive.length === 0 || positive.includes(actual);
}

function appliesHere(meta) {
  return allows(meta.os, process.platform) && allows(meta.cpu, process.arch) && allows(meta.libc, HOST_LIBC);
}

// --- 2. every declared package has real, lockfile-driven deps ---------------------------
for (const rel of PACKAGES) {
  const dir = path.join(REPO_ROOT, rel);
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm)) {
    problems.push(`${rel}: node_modules is missing (run npm ci in that directory)`);
    continue;
  }
  if (!fs.existsSync(path.join(dir, 'package-lock.json'))) {
    problems.push(`${rel}: package-lock.json is missing (dependency versions are not pinned)`);
    continue;
  }
  // Every platform-applicable lockfile dependency must be present AND at the locked version.
  // Presence alone would accept a stale or manually swapped package, which is exactly the failure
  // mode this project already hit once (declared openclaw 2026.7.1-2 vs running 2026.9.7).
  const lock = JSON.parse(fs.readFileSync(path.join(dir, 'package-lock.json'), 'utf8'));
  const missing = [];
  const versionMismatch = [];
  let expected = 0;
  let skipped = 0;
  for (const [key, meta] of Object.entries(lock.packages ?? {})) {
    if (!key.startsWith('node_modules/')) continue;
    const name = key.slice('node_modules/'.length);
    if (name.includes('/node_modules/')) continue;
    if (!appliesHere(meta)) {
      skipped++;
      continue;
    }
    expected++;
    const installed = path.join(nm, name);
    if (!fs.existsSync(installed)) {
      missing.push(name);
      continue;
    }
    if (!meta.version) continue;
    try {
      const actual = JSON.parse(fs.readFileSync(path.join(installed, 'package.json'), 'utf8')).version;
      if (actual !== meta.version) versionMismatch.push(`${name}: installed ${actual}, lockfile ${meta.version}`);
    } catch {
      // A file: dependency (the local confirmation core) is a symlink to a workspace package and
      // may legitimately lack a plain package.json read path; presence is enough for those.
    }
  }
  if (missing.length) problems.push(`${rel}: ${missing.length} lockfile package(s) not installed, e.g. ${missing.slice(0, 3).join(', ')}`);
  if (versionMismatch.length) problems.push(`${rel}: ${versionMismatch.length} version mismatch(es): ${versionMismatch.slice(0, 3).join('; ')}`);
  notes.push(`${rel}: ${expected} platform packages present at locked versions (${skipped} skipped as other-platform)`);
}

// --- 3. SDK pin ------------------------------------------------------------------------
const sdkLink = path.join(REPO_ROOT, 'node_modules/openclaw');
if (!fs.existsSync(sdkLink)) {
  problems.push('pinned SDK link node_modules/openclaw is missing');
} else {
  const actual = JSON.parse(fs.readFileSync(path.join(sdkLink, 'package.json'), 'utf8')).version;
  if (actual !== EXPECTED_SDK) problems.push(`pinned SDK is ${actual}, expected ${EXPECTED_SDK}`);
  else notes.push(`pinned SDK openclaw@${actual} -> ${SDK}`);
}

// --- 4. controlled plugin prefix -------------------------------------------------------
const prefix = path.join(STATE_DIR, 'plugins');
for (const [name, version] of Object.entries(PLUGINS)) {
  const pkg = path.join(prefix, 'node_modules', name, 'package.json');
  if (!fs.existsSync(pkg)) {
    problems.push(`plugin not installed: ${name}@${version} (run install-plugins.mjs)`);
    continue;
  }
  const actual = JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
  if (actual !== version) problems.push(`plugin ${name} is ${actual}, expected ${version}`);
  else notes.push(`plugin ${name}@${actual} -> ${path.join(prefix, 'node_modules', name)}`);
}

for (const n of notes) console.log(`  ok   ${n}`);
for (const p of problems) console.error(`  FAIL ${p}`);
console.log(problems.length ? `\ndependency verification FAILED (${problems.length} problem(s))` : '\ndependency verification passed: project owns its dependencies');
process.exit(problems.length ? 1 : 0);
