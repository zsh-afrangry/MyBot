// Sync the versioned runtime intent (config/runtime.config.json) into the live runtime config.
//
// Contract (see config/README.md):
//   1. This script writes ONLY ${STATE_DIR}/openclaw.json. It never opens, moves or deletes
//      state/, channel/, agents/, workspace/, media/ or any database or session file, so it
//      cannot overwrite memory, reminders or chat history.
//   2. The canonical file declares which top-level keys the REPOSITORY fully owns via `_managed`.
//      Managed keys are replaced wholesale, so removing a plugin entry, a model provider or a tool
//      from the repo actually removes it from the runtime. Keys NOT listed as managed are treated
//      as host-maintained and are preserved untouched.
//
//      This split exists because "preserve every runtime-only key" silently made deletions
//      impossible: a key deleted from the repo lived on forever in the runtime, and --check still
//      reported success. Preserving is only correct for fields the host itself maintains.
//   3. Every --apply leaves a timestamped openclaw.json.bak.<stamp> behind first.
//   4. --check exits non-zero when the runtime has drifted from the repo, including when a managed
//      key exists in the runtime but was deleted from the repo.
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
const show = (v) => JSON.stringify(v);

/** Deep-compare, collecting differences in both directions under `managed` subtrees. */
function compare(canonical, live, base, managed, twoWay) {
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
      const sub = compare(cv, lv, p, managed, twoWay);
      changed.push(...sub.changed);
      onlyRuntime.push(...sub.onlyRuntime);
    } else if (JSON.stringify(cv) !== JSON.stringify(lv)) {
      changed.push({ path: p, kind: 'differs', want: cv, got: lv });
    }
  }
  for (const k of Object.keys(live)) {
    if (k in canonical) continue;
    const p = base ? `${base}.${k}` : k;
    // Inside a managed subtree an extra runtime key is drift the repo wants removed.
    if (twoWay) changed.push({ path: p, kind: 'extra', got: live[k] });
    else onlyRuntime.push(p);
  }
  return { changed, onlyRuntime };
}

/** Replace managed keys wholesale; keep unmanaged (host-maintained) keys as they are. */
function merge(canonical, live, managed) {
  const out = structuredClone(live);
  // A managed key that the repository no longer declares must be REMOVED, not preserved.
  // Without this, dropping a whole block (e.g. all of `tools`) from the repo left the runtime
  // copy in place forever and --check still reported "in sync".
  for (const k of Object.keys(out)) {
    if (managed.has(k) && !(k in canonical)) delete out[k];
  }
  for (const [k, cv] of Object.entries(canonical)) {
    if (managed.has(k)) out[k] = structuredClone(cv);
    else out[k] = isObj(cv) && isObj(live[k]) ? merge(cv, live[k], managed) : structuredClone(cv);
  }
  return out;
}

/** Detect keys that live only in the runtime, splitting them into drift vs host-maintained. */
function detectDeletions(canonical, live, managed, changed) {
  const deletions = [];
  for (const key of managed) {
    if (!(key in canonical)) {
      // The whole managed block was deleted from the repository.
      if (key in live) deletions.push({ path: key, kind: 'extra', got: live[key] });
      continue;
    }
    if (!isObj(canonical[key]) || !isObj(live[key])) continue;
    const sub = compare(canonical[key], live[key], key, managed, true);
    for (const c of sub.changed) {
      if (c.kind === 'extra' && !changed.some((x) => x.path === c.path)) deletions.push(c);
    }
  }
  return deletions;
}

// --- self test ------------------------------------------------------------------------
// Regression coverage for the deletion semantics. Runs against in-memory objects only; it never
// reads or writes the live config. Invoked with --selftest.
if (argv.has('--selftest')) {
  const cases = [
    {
      name: 'whole managed block deleted from repo',
      canonical: { _managed: ['tools'], agents: { a: 1 } },
      live: { tools: { deny: ['exec'] }, agents: { a: 1 } },
      expectChanged: 0,
      expectDeleted: ['tools']
    },
    {
      name: 'subkey deleted inside a managed block',
      canonical: { _managed: ['tools'], tools: { deny: ['exec'] } },
      live: { tools: { deny: ['exec'], web: {} } },
      expectChanged: 0,
      expectDeleted: ['tools.web']
    },
    {
      name: 'managed block differs',
      canonical: { _managed: ['tools'], tools: { deny: ['exec'] } },
      live: { tools: { deny: [] } },
      expectChanged: 1,
      expectDeleted: []
    },
    {
      name: 'in sync',
      canonical: { _managed: ['tools'], tools: { web: {} } },
      live: { tools: { web: {} } },
      expectChanged: 0,
      expectDeleted: []
    }
  ];
  let bad = 0;
  for (const c of cases) {
    const managed = new Set(c.canonical._managed);
    const canonical = structuredClone(c.canonical);
    delete canonical._managed;
    const { changed } = compare(canonical, c.live, '', managed, false);
    const deletions = detectDeletions(canonical, c.live, managed, changed);
    const gotDeleted = deletions.map((d) => d.path).sort();
    const wantDeleted = [...c.expectDeleted].sort();
    const merged = merge(canonical, c.live, managed);
    const removedInMerge = JSON.stringify(merged) !== JSON.stringify(c.live);
    const ok =
      changed.length === c.expectChanged &&
      JSON.stringify(gotDeleted) === JSON.stringify(wantDeleted) &&
      (c.expectDeleted.length === 0 || removedInMerge);
    if (!ok) bad++;
    console.log(
      `  ${ok ? 'PASS' : 'FAIL'}  ${c.name}  (changed=${changed.length} want=${c.expectChanged}, deleted=[${gotDeleted}] want=[${wantDeleted}])`
    );
  }
  // A host-maintained key must survive a merge untouched.
  const managed = new Set(['tools']);
  const merged = merge({ tools: { web: {} } }, { tools: { web: {} }, hostCache: { seen: 1 } }, managed);
  const hostKept = JSON.stringify(merged.hostCache) === JSON.stringify({ seen: 1 });
  if (!hostKept) bad++;
  console.log(`  ${hostKept ? 'PASS' : 'FAIL'}  host-maintained key preserved`);
  console.log(bad ? `\nselftest FAILED (${bad})` : '\nselftest passed');
  process.exit(bad ? 1 : 0);
}

if (!fs.existsSync(CANONICAL)) throw new Error(`Missing canonical config: ${CANONICAL}`);
if (!fs.existsSync(LIVE)) throw new Error(`Missing runtime config: ${LIVE} (is the fusion runtime initialised?)`);

const rawCanonical = JSON.parse(fs.readFileSync(CANONICAL, 'utf8'));
const managedList = rawCanonical._managed;
if (!Array.isArray(managedList) || !managedList.length) {
  throw new Error(`${CANONICAL} must declare "_managed": [<top-level keys the repository owns>]`);
}
const managed = new Set(managedList);
const canonical = structuredClone(rawCanonical);
delete canonical._managed;

// Report unmanaged keys actually present so the split stays visible rather than implicit.
const live = JSON.parse(fs.readFileSync(LIVE, 'utf8'));
const hostMaintained = Object.keys(live).filter((k) => !managed.has(k));

const { changed, onlyRuntime } = compare(canonical, live, '', managed, false);
// Managed keys use two-way comparison so deletions inside a managed subtree are detected, and a
// whole managed block missing from the repository is treated as a deletion too.
const deletions = detectDeletions(canonical, live, managed, changed);

if (DIFF) {
  for (const c of changed) {
    console.log(`  ${c.kind.toUpperCase().padEnd(8)} ${c.path}`);
    console.log(`            repo    : ${show(c.want)}`);
    if (c.kind === 'differs') console.log(`            runtime : ${show(c.got)}`);
  }
  for (const c of deletions) {
    console.log(`  DELETED  ${c.path}`);
    console.log(`            runtime : ${show(c.got)}   (removed from repo -> --apply removes it)`);
  }
  for (const p of onlyRuntime) console.log(`  RUNTIME-ONLY ${p}  (preserved)`);
  console.log(`\n  repo-managed top-level keys : ${[...managed].join(', ')}`);
  console.log(`  host-maintained keys kept   : ${hostMaintained.length ? hostMaintained.join(', ') : '(none)'}`);
}

if (!changed.length && !deletions.length) {
  console.log(`config in sync with ${CANONICAL} (${managed.size} managed key(s), ${hostMaintained.length} host-maintained kept)`);
  process.exit(0);
}

if (!APPLY) {
  console.error(`\nconfig DRIFT: ${changed.length} changed, ${deletions.length} deleted-in-repo key(s)`);
  console.error('Run with --diff to inspect, or --apply to write the repo intent into the runtime.');
  process.exit(1);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backup = `${LIVE}.bak.${stamp}`;
fs.copyFileSync(LIVE, backup);
fs.chmodSync(backup, 0o600);
fs.writeFileSync(LIVE, JSON.stringify(merge(canonical, live, managed), null, 2) + '\n', { mode: 0o600 });
console.log(`applied: ${changed.length} changed, ${deletions.length} removed`);
console.log(`  backup          : ${backup}`);
console.log(`  managed keys    : ${managed.size} replaced from repo`);
console.log(`  host-maintained : ${hostMaintained.length} key(s) kept as-is`);
console.log('  state untouched : state/, channel/, agents/, workspace/, media/ were not opened');
