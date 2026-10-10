// Operator-owned project registry maintenance: add or remove one entry in
// ${STATE_DIR}/projects.json, with the same validation the runtime applies when it loads the
// registry. The repository has no source for this file, so it is edited here rather than by hand
// or by re-running the one-shot configure-projects.mjs initializer.
//
// Why this exists: docs/10 used to send new projects at configure-projects.mjs (a first-run
// bootstrap that only appends when the id is absent, and also rewrites the copy's AGENTS.md and the
// live openclaw.json) or at direct edits of projects.json. Neither is a reviewable maintenance path.
//
// Scope: this script writes ONLY ${STATE_DIR}/projects.json. It never touches openclaw.json,
// config/runtime.config.json, project workspaces, or any database.
//
// Accepted input shapes for --check/--add (all three, so a draft can be lifted straight out of the
// live file or written as a bare entry):
//   * a bare project entry object            { id, agentId, root, checks, ... }
//   * an array of entries                    [ {...}, {...} ]
//   * a whole registry object                { version: 1, projects: [ {...} ] }
//
// Validation mirrors the runtime (projects.js + protected-roots.js) AND the sandbox
// (sandbox.js), so "passes maintenance validation" means "will not be rejected at load or at run":
//   * id / agentId / duplicate / canonical root / own .git / checks / fixture target
//   * protected roots (shared module, includes kurumi-archive)
//   * readOnlyDependencies must sit inside the installed package tree, which is the only path
//     sandboxArguments will mount read-only
//
// Usage:
//   node scripts/fusion/register-project.mjs --list
//   node scripts/fusion/register-project.mjs --check <file>
//   node scripts/fusion/register-project.mjs --add <file> [--apply]
//   node scripts/fusion/register-project.mjs --remove <id> [--apply]
//
// --state-dir <dir> overrides where projects.json lives. It exists so the offline regression can
// run against a temp directory; STATE_DIR itself is a compile-time constant. Use it only in tests:
// maintaining the real registry is the default on purpose.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './lib/legacy-source.mjs';
import { assertNotProtectedRoot, RUNTIME_STATE } from '../../chatbot/plugins/kurumi-tasks/protected-roots.js';

const STATE = STATE_DIR;

// The sandbox only mounts read-only dependencies from inside the installed package tree; anything
// else makes sandboxArguments throw at run time. Mirrored here so the CLI cannot bless a registry
// entry the sandbox would reject.
const ALLOWED_DEPENDENCY_PREFIX = '/home/afrangry/.npm-global/lib/node_modules/';
const SUPPORTED_REGISTRY_VERSION = 1;

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes('--apply');
const STATE_OVERRIDE = arg('--state-dir');
if (STATE_OVERRIDE !== undefined) {
  if (!path.isAbsolute(STATE_OVERRIDE)) fail(`--state-dir must be an absolute path, got ${STATE_OVERRIDE}`);
  if (!fs.existsSync(STATE_OVERRIDE)) fail(`--state-dir does not exist: ${STATE_OVERRIDE}`);
}
const REGISTRY_DIR = STATE_OVERRIDE ?? STATE;

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

const REGISTRY = path.join(REGISTRY_DIR, 'projects.json');

function readRegistry() {
  if (!fs.existsSync(REGISTRY)) return { version: SUPPORTED_REGISTRY_VERSION, projects: [] };
  const stat = fs.lstatSync(REGISTRY);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${REGISTRY} is not a regular file`);
  const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  if (parsed.version !== SUPPORTED_REGISTRY_VERSION || !Array.isArray(parsed.projects)) {
    fail(`unsupported project registry shape (expected version ${SUPPORTED_REGISTRY_VERSION} with a projects array)`);
  }
  return parsed;
}

/**
 * Normalise any accepted input shape into { version, projects, source }.
 * `kind` is used in messages so a caller knows what was read.
 */
function readDraft(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed)) return { version: SUPPORTED_REGISTRY_VERSION, projects: parsed, kind: 'entry array' };
  if (parsed && typeof parsed === 'object' && Array.isArray(parsed.projects)) {
    if (parsed.version !== SUPPORTED_REGISTRY_VERSION) {
      fail(`draft registry declares version ${JSON.stringify(parsed.version)}; only version ${SUPPORTED_REGISTRY_VERSION} is supported`);
    }
    return { version: parsed.version, projects: parsed.projects, kind: 'registry object' };
  }
  if (parsed && typeof parsed === 'object' && typeof parsed.id === 'string') {
    return { version: SUPPORTED_REGISTRY_VERSION, projects: [parsed], kind: 'single entry' };
  }
  fail('draft must be a single project entry, an array of entries, or a registry object with a projects array');
}

/** Same rules the plugin applies at load time, so a saved entry cannot fail later. */
function validateEntry(project, { all }) {
  const where = `project "${project?.id ?? '(missing id)'}"`;
  if (!project || typeof project !== 'object' || Array.isArray(project)) fail(`${where}: entry must be an object`);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(project.id ?? '')) fail(`${where}: id must match ^[a-z][a-z0-9-]{0,39}$`);
  if (project.agentId !== `project-${project.id}`) fail(`${where}: agentId must be project-${project.id}`);
  if (all.filter((p) => p.id === project.id).length > 1) fail(`${where}: duplicate id in registry`);
  if (typeof project.root !== 'string' || !path.isAbsolute(project.root)) fail(`${where}: root must be an absolute path`);
  if (!fs.existsSync(project.root)) fail(`${where}: root does not exist: ${project.root}`);
  const real = fs.realpathSync(project.root);
  if (real !== project.root) fail(`${where}: root must be canonical (realpath is ${real})`);
  try {
    assertNotProtectedRoot(real);
  } catch (error) {
    fail(`${where}: ${error.message}`);
  }
  if (!fs.lstatSync(path.join(real, '.git')).isDirectory()) fail(`${where}: root needs its own .git directory`);
  if (!Array.isArray(project.checks) || !project.checks.length) fail(`${where}: at least one check is required`);
  for (const check of project.checks) {
    if (typeof check?.name !== 'string' || !check.name) fail(`${where}: every check needs a name`);
    if (!Array.isArray(check.argv) || !check.argv.length || check.argv.some((a) => typeof a !== 'string' || a.includes('\0'))) {
      fail(`${where}: check "${check.name}" needs a string argv`);
    }
    if (check.timeoutMs !== undefined && !(Number.isInteger(check.timeoutMs) && check.timeoutMs > 0)) {
      fail(`${where}: check "${check.name}" timeoutMs must be a positive integer`);
    }
  }
  for (const dep of project.readOnlyDependencies ?? []) {
    if (typeof dep !== 'string' || !path.isAbsolute(dep)) fail(`${where}: readOnlyDependencies must be absolute paths`);
    if (!fs.existsSync(dep)) fail(`${where}: readOnlyDependency does not exist: ${dep}`);
    const canonical = fs.realpathSync(dep);
    if (!canonical.startsWith(ALLOWED_DEPENDENCY_PREFIX)) {
      fail(`${where}: readOnlyDependency must live under ${ALLOWED_DEPENDENCY_PREFIX} (the sandbox refuses other mounts): ${dep}`);
    }
  }
  for (const fixture of project.fixtures ?? []) {
    if (typeof fixture?.source !== 'string' || !fs.existsSync(fixture.source)) fail(`${where}: fixture source missing`);
    if (!/^\/checks\/[a-zA-Z0-9_.-]+$/.test(fixture.target ?? '')) fail(`${where}: fixture target must be /checks/<file>`);
  }
  return project;
}

const label = (p) => `${p.id} (agent ${p.agentId}, root ${p.root}, ${p.checks.length} check(s))`;

if (argv.includes('--list') || argv.length === 0) {
  const registry = readRegistry();
  console.log(`registry: ${REGISTRY}`);
  if (!registry.projects.length) console.log('  (no projects registered)');
  for (const project of registry.projects) console.log(`  - ${label(project)}`);
  if (!argv.length) {
    console.log('\nusage: --list | --check <file> | --add <file> [--apply] | --remove <id> [--apply]');
    console.log('input may be a single entry, an entry array, or a registry object');
  }
} else if (arg('--check')) {
  const draft = readDraft(arg('--check'));
  draft.projects.forEach((p) => validateEntry(p, { all: draft.projects }));
  console.log(`ok: ${draft.projects.length} project entr(ies) from a ${draft.kind} satisfy the runtime registry rules`);
  console.log(`note: this covers registry shape, roots, protected paths, checks and sandbox-allowed dependencies (runtime state dir ${RUNTIME_STATE}).`);
} else if (arg('--add')) {
  const draft = readDraft(arg('--add'));
  if (draft.projects.length !== 1) fail(`--add expects exactly one entry, got ${draft.projects.length}`);
  const entry = draft.projects[0];
  const registry = readRegistry();
  validateEntry(entry, { all: [...registry.projects.filter((p) => p.id !== entry.id), entry] });
  const clash = registry.projects.find((p) => p.id === entry.id);
  if (clash && JSON.stringify(clash) === JSON.stringify(entry)) {
    console.log(`no change: ${entry.id} is already registered with identical content`);
    process.exit(0);
  }
  console.log(clash ? `would replace:\n  - ${label(clash)}\nwith:\n  + ${label(entry)}` : `would add:\n  + ${label(entry)}`);
  if (APPLY) {
    const next = clash
      ? registry.projects.map((p) => (p.id === entry.id ? entry : p))
      : [...registry.projects, entry];
    fs.writeFileSync(REGISTRY, JSON.stringify({ ...registry, projects: next }, null, 2), { mode: 0o600 });
    console.log(`applied: ${REGISTRY} now has ${next.length} project entr(ies)`);
    console.log('note: the matching agents.entries.<id> entry lives in config/runtime.config.json; apply it with sync-config.mjs --apply and restart the service.');
  }
} else if (arg('--remove')) {
  const id = arg('--remove');
  const registry = readRegistry();
  const hit = registry.projects.find((p) => p.id === id);
  if (!hit) fail(`no project with id "${id}"`);
  console.log(`would remove:\n  - ${label(hit)}`);
  if (APPLY) {
    const next = registry.projects.filter((p) => p.id !== id);
    fs.writeFileSync(REGISTRY, JSON.stringify({ ...registry, projects: next }, null, 2), { mode: 0o600 });
    console.log(`applied: ${REGISTRY} now has ${next.length} project entr(ies)`);
    console.log('note: remove its agents.entries.<id> from config/runtime.config.json too, or the agent remains without a project.');
  }
} else {
  fail('unknown arguments; see usage with no arguments');
}
