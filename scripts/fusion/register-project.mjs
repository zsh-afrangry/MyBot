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
// Usage:
//   node scripts/fusion/register-project.mjs --list
//   node scripts/fusion/register-project.mjs --check <registry.json>     # validate a draft file
//   node scripts/fusion/register-project.mjs --add <entry.json> [--apply]
//   node scripts/fusion/register-project.mjs --remove <id> [--apply]
//
// Without --apply, --add/--remove only print what would change. The agent entry that pairs with a
// project lives in the repository (config/runtime.config.json -> agents.entries) and is applied by
// sync-config.mjs; see docs/10.
import fs from 'node:fs';
import path from 'node:path';
import { STATE_DIR } from './lib/legacy-source.mjs';

const STATE = STATE_DIR;
const REGISTRY = path.join(STATE, 'projects.json');

const argv = process.argv.slice(2);
const arg = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const APPLY = argv.includes('--apply');

// Mirrors chatbot/plugins/kurumi-tasks/projects.js: a bad entry must not be able to point a worker
// at runtime state, the recovery backups, a retained original component, or the live source tree.
const PROTECTED_ROOTS = [
  '/home/afrangry/.openclaw',
  '/home/afrangry/kurumi-backups',
  '/home/afrangry/kurumi-baselines',
  '/home/afrangry/snowluma',
  '/home/afrangry/桌面/qq-bridge',
  '/home/afrangry/.npm-global',
  '/home/afrangry/kurumi-fusion',
];

function fail(message) {
  console.error(`error: ${message}`);
  process.exit(1);
}

function readRegistry() {
  if (!fs.existsSync(REGISTRY)) return { version: 1, projects: [] };
  const stat = fs.lstatSync(REGISTRY);
  if (!stat.isFile() || stat.isSymbolicLink()) fail(`${REGISTRY} is not a regular file`);
  const parsed = JSON.parse(fs.readFileSync(REGISTRY, 'utf8'));
  if (parsed.version !== 1 || !Array.isArray(parsed.projects)) fail('unsupported project registry shape');
  return parsed;
}

/** Same rules the plugin applies at load time, so a saved entry cannot fail later. */
function validateEntry(project, { all }) {
  const where = `project "${project?.id ?? '(missing id)'}"`;
  if (!project || typeof project !== 'object') fail(`${where}: entry must be an object`);
  if (!/^[a-z][a-z0-9-]{0,39}$/.test(project.id ?? '')) fail(`${where}: id must match ^[a-z][a-z0-9-]{0,39}$`);
  if (project.agentId !== `project-${project.id}`) fail(`${where}: agentId must be project-${project.id}`);
  const others = all.filter((p) => p.id === project.id).length;
  if (others > 1) fail(`${where}: duplicate id in registry`);
  if (typeof project.root !== 'string' || !path.isAbsolute(project.root)) fail(`${where}: root must be an absolute path`);
  if (!fs.existsSync(project.root)) fail(`${where}: root does not exist: ${project.root}`);
  const real = fs.realpathSync(project.root);
  if (real !== project.root) fail(`${where}: root must be canonical (realpath is ${real})`);
  for (const original of PROTECTED_ROOTS) {
    if (real === original || real.startsWith(`${original}/`)) fail(`${where}: preserved original cannot be a worker root`);
  }
  if ((real === STATE || real.startsWith(`${STATE}/`)) && !real.startsWith(`${STATE}/projects/`)) {
    fail(`${where}: fusion runtime state cannot be a worker root`);
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
  if (!argv.length) console.log('\nusage: --list | --check <file> | --add <entry.json> [--apply] | --remove <id> [--apply]');
} else if (arg('--check')) {
  const draft = JSON.parse(fs.readFileSync(arg('--check'), 'utf8'));
  const projects = Array.isArray(draft) ? draft : draft.projects;
  if (!Array.isArray(projects)) fail('draft must be a registry object or a project array');
  projects.forEach((p) => validateEntry(p, { all: projects }));
  console.log(`ok: ${projects.length} project entr(ies) satisfy the runtime registry rules`);
} else if (arg('--add')) {
  const entry = validateEntry(JSON.parse(fs.readFileSync(arg('--add'), 'utf8')), { all: [] });
  const registry = readRegistry();
  const clash = registry.projects.find((p) => p.id === entry.id);
  validateEntry(entry, { all: [...registry.projects.filter((p) => p.id !== entry.id), entry] });
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
