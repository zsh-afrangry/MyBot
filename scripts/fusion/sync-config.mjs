// Sync the versioned runtime intent (config/runtime.config.json) into the live runtime config.
//
// Contract (see config/README.md):
//   1. This script writes ONLY ${STATE_DIR}/openclaw.json. It never opens, moves or deletes
//      state/, channel/, agents/, workspace/, media/ or any database or session file, so it
//      cannot overwrite memory, reminders or chat history.
//   2. --apply merges: keys present in the repo win; keys that exist only in the runtime
//      (written by OpenClaw itself) are preserved and reported, so drift stays visible.
//   3. Every --apply leaves a timestamped openclaw.json.bak.<stamp> behind first.
//   4. --check exits non-zero when the runtime has drifted from the repo.
//
// Usage:
//   node scripts/fusion/sync-config.mjs            # check only (default)
//   node scripts/fusion/sync-config.mjs --diff     # show per-key differences
//   node scripts/fusion/sync-config.mjs --apply    # write the repo intent into the runtime
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR, REPO_ROOT } from './lib/legacy-source.mjs';

const CANONICAL = path.join(REPO_ROOT, 'config/runtime.config.json');
const LIVE = path.join(STATE_DIR, 'openclaw.json');

const argv = new Set(process.argv.slice(2));
const APPLY = argv.has('--apply');
const DIFF = argv.has('--diff') || APPLY;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const show = (v) => (typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v));

/** Deep-compare canonical intent against runtime. Returns changed paths and runtime-only paths. */
function compare(canonical, live, base = '') {
  const changed = [];
  const onlyRuntime = [];
  for (const [k, cv] of Object.entries(canonical)) {
    const p = base ? `${base}.${k}` : k;
    if (!(k in live)) {
      changed.push({ path: p, kind: 'missing', want: cv });
      continue;
    }
    const lv = live[k];
    if (isObj(cv) && isObj(lv)) {
      const sub = compare(cv, lv, p);
      changed.push(...sub.changed);
      onlyRuntime.push(...sub.onlyRuntime);
    } else if (JSON.stringify(cv) !== JSON.stringify(lv)) {
      changed.push({ path: p, kind: 'differs', want: cv, got: lv });
    }
  }
  for (const k of Object.keys(live)) {
    if (!(k in canonical)) onlyRuntime.push(base ? `${base}.${k}` : k);
  }
  return { changed, onlyRuntime };
}

/** Merge canonical over a copy of live, preserving runtime-only keys. */
function merge(canonical, live) {
  if (!isObj(canonical) || !isObj(live)) return structuredClone(canonical);
  const out = structuredClone(live);
  for (const [k, cv] of Object.entries(canonical)) {
    out[k] = isObj(cv) && isObj(live[k]) ? merge(cv, live[k]) : structuredClone(cv);
  }
  return out;
}

if (!fs.existsSync(CANONICAL)) throw new Error(`Missing canonical config: ${CANONICAL}`);
if (!fs.existsSync(LIVE)) throw new Error(`Missing runtime config: ${LIVE} (is the fusion runtime initialised?)`);

const canonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
const { changed, onlyRuntime } = compare(canonical, live);

if (DIFF) {
  for (const c of changed) {
    console.log(`  ${c.kind === 'missing' ? 'MISSING ' : 'DIFFERS '} ${c.path}`);
    console.log(`            repo    : ${show(c.want)}`);
    if (c.kind === 'differs') console.log(`            runtime : ${show(c.got)}`);
  }
  for (const p of onlyRuntime) console.log(`  RUNTIME-ONLY ${p}  (kept as-is by --apply)`);
}

if (!changed.length) {
  console.log(`config in sync with ${CANONICAL}${onlyRuntime.length ? ` (${onlyRuntime.length} runtime-only key(s) preserved)` : ''}`);
  process.exit(0);
}

if (!APPLY) {
  console.error(`\nconfig DRIFT: ${changed.length} key(s) differ from ${CANONICAL}`);
  console.error('Run with --diff to inspect, or --apply to write the repo intent into the runtime.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${LIVE}.bak.${stamp}`;
fs.copyFileSync(LIVE, backup);
fs.chmodSync(backup, 0o600);
fs.writeFileSync(LIVE, JSON.stringify(merge(canonical, live), null, 2) + '\n', { mode: 0o600 });
console.log(`applied ${changed.length} key(s) from ${CANONICAL}`);
console.log(`  backup          : ${backup}`);
console.log(`  runtime-only    : ${onlyRuntime.length} key(s) preserved`);
console.log('  state untouched : state/, channel/, agents/, workspace/, media/ were not opened');
