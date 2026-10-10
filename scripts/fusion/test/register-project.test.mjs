// Regression for the project-registry maintenance path (docs/10) and the shared protected-root rule.
//
// Why this exists: the 2026-10-10 second re-verification (V01/V02) found that
//   * the CLI's own protected list omitted /home/afrangry/kurumi-archive, so an archived legacy tree
//     could be registered as a worker workspace;
//   * `--check` rejected a single-entry draft even though the docs told operators to use one, and it
//     accepted an unsupported registry version;
//   * readOnlyDependencies outside the installed package tree were accepted although the sandbox
//     refuses to mount them.
// These cases are cheap to assert offline, so they run here instead of being re-checked by hand.
//
// Every case works on temp directories and temp registries only: no live registry, no worker, no
// sandbox spawn, no service.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {assertNotProtectedRoot, PROTECTED_ROOTS} from '../../../chatbot/plugins/kurumi-tasks/protected-roots.js';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const CLI = path.join(REPO, 'scripts/fusion/register-project.mjs');

function tmpdir(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/**
 * Run the CLI against a temp state dir. `--state-dir` is mandatory here on purpose: STATE_DIR is a
 * compile-time constant, so without it the CLI would rewrite the LIVE registry. An earlier version of
 * this test did exactly that and appended a probe entry to the real projects.json.
 */
function runCli(args, {state} = {}) {
  assert.ok(state, 'runCli requires an explicit temp state dir');
  assert.ok(state.startsWith(os.tmpdir()), `state dir must be a temp dir, got ${state}`);
  return spawnSync('/usr/bin/node', [CLI, ...args, '--state-dir', state], {encoding: 'utf8'});
}

/** Guard: the live registry must be byte-identical before and after the whole file runs. */
const LIVE_REGISTRY = '/home/afrangry/.openclaw-fusion/projects.json';
const liveBefore = fs.existsSync(LIVE_REGISTRY) ? fs.readFileSync(LIVE_REGISTRY) : null;
test.after(() => {
  const liveAfter = fs.existsSync(LIVE_REGISTRY) ? fs.readFileSync(LIVE_REGISTRY) : null;
  assert.deepEqual(liveAfter, liveBefore, 'these tests must never modify the live registry');
});

/** Build a minimal valid project checkout in a temp directory. */
function makeProject(dir) {
  fs.mkdirSync(path.join(dir, '.git'), {recursive: true});
  return dir;
}

function writeDraft(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
  return file;
}

function entryFor(root, overrides = {}) {
  return {
    id: 'probe',
    name: 'probe',
    agentId: 'project-probe',
    root,
    checks: [{name: 'probe-check', argv: ['/usr/bin/node', '--version'], timeoutMs: 5000}],
    ...overrides,
  };
}

test('protected roots cover the archive and every preserved original', () => {
  for (const expected of [
    '/home/afrangry/kurumi-archive',
    '/home/afrangry/kurumi-backups',
    '/home/afrangry/kurumi-baselines',
    '/home/afrangry/.openclaw',
    '/home/afrangry/kurumi-fusion',
    '/home/afrangry/.npm-global',
  ]) {
    assert.ok(PROTECTED_ROOTS.includes(expected), `${expected} must stay protected`);
  }
});

test('the archived legacy trees are rejected as worker roots', () => {
  for (const root of [
    '/home/afrangry/kurumi-archive/legacy-openclaw',
    '/home/afrangry/kurumi-archive/qq-bridge',
    '/home/afrangry/kurumi-archive',
    '/home/afrangry/kurumi-archive/legacy-units',
  ]) {
    assert.throws(() => assertNotProtectedRoot(root), /Preserved original/, `${root} must be rejected`);
  }
});

test('runtime state is rejected except the projects workspace', () => {
  assert.throws(() => assertNotProtectedRoot('/home/afrangry/.openclaw-fusion'), /runtime state/);
  assert.throws(() => assertNotProtectedRoot('/home/afrangry/.openclaw-fusion/state'), /runtime state/);
  assert.doesNotThrow(() => assertNotProtectedRoot('/home/afrangry/.openclaw-fusion/projects/probe'));
});

test('KURUMI_PROTECTED_ROOTS extends the shared rule', () => {
  const extra = tmpdir('extra-root-');
  assert.doesNotThrow(() => assertNotProtectedRoot(extra));
  assert.throws(() => assertNotProtectedRoot(extra, {KURUMI_PROTECTED_ROOTS: extra}), /Preserved original/);
});

test('register-project --check accepts all three documented input shapes', () => {
  const state = tmpdir('registry-state-');
  const root = makeProject(tmpdir('proj-'));
  const entry = entryFor(root);
  const files = {
    'single entry': writeDraft(path.join(state, 'single.json'), entry),
    'entry array': writeDraft(path.join(state, 'array.json'), [entry]),
    'registry object': writeDraft(path.join(state, 'registry.json'), {version: 1, projects: [entry]}),
  };
  for (const [shape, file] of Object.entries(files)) {
    const r = runCli(['--check', file], {state});
    assert.equal(r.status, 0, `${shape} should pass --check, got: ${r.stderr}`);
    assert.match(r.stdout, /satisfy the runtime registry rules/);
  }
});

test('register-project --check rejects an unsupported registry version', () => {
  const state = tmpdir('registry-state-');
  const root = makeProject(tmpdir('proj-'));
  const file = writeDraft(path.join(state, 'bad-version.json'), {version: 999, projects: [entryFor(root)]});
  const r = runCli(['--check', file], {state});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /version 999|only version 1/);
});

test('register-project --check rejects the archived legacy trees (V01 regression)', () => {
  const state = tmpdir('registry-state-');
  for (const archived of ['/home/afrangry/kurumi-archive/legacy-openclaw', '/home/afrangry/kurumi-archive/qq-bridge']) {
    const file = writeDraft(path.join(state, `arch-${path.basename(archived)}.json`), entryFor(archived));
    const r = runCli(['--check', file], {state});
    assert.equal(r.status, 1, `${archived} must be rejected`);
    assert.match(r.stderr, /Preserved original cannot be a project worker root/);
  }
});

test('register-project --check rejects dependencies the sandbox cannot mount', () => {
  const state = tmpdir('registry-state-');
  const root = makeProject(tmpdir('proj-'));
  const outside = tmpdir('not-a-package-');
  const file = writeDraft(path.join(state, 'bad-dep.json'), entryFor(root, {readOnlyDependencies: [outside]}));
  const r = runCli(['--check', file], {state});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /must live under \/home\/afrangry\/\.npm-global\/lib\/node_modules\//);
});

test('register-project --check rejects the runtime state directory as a root', () => {
  const state = tmpdir('registry-state-');
  const file = writeDraft(path.join(state, 'state-root.json'), entryFor('/home/afrangry/.openclaw-fusion/state'));
  const r = runCli(['--check', file], {state});
  assert.equal(r.status, 1);
  assert.match(r.stderr, /runtime state cannot be a project worker root/i);
});

test('register-project --add without --apply never writes the registry', () => {
  const state = tmpdir('registry-state-');
  const root = makeProject(tmpdir('proj-'));
  const registry = path.join(state, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify({version: 1, projects: []}, null, 2));
  const before = fs.readFileSync(registry, 'utf8');
  const file = writeDraft(path.join(state, 'entry.json'), entryFor(root));
  const r = runCli(['--add', file], {state});
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /would add/);
  assert.equal(fs.readFileSync(registry, 'utf8'), before, 'preview must not modify the registry');
});

test('register-project --add --apply writes exactly the validated entry', () => {
  const state = tmpdir('registry-state-');
  const root = makeProject(tmpdir('proj-'));
  const registry = path.join(state, 'projects.json');
  fs.writeFileSync(registry, JSON.stringify({version: 1, projects: []}, null, 2));
  const file = writeDraft(path.join(state, 'entry.json'), entryFor(root));
  const r = runCli(['--add', file, '--apply'], {state});
  assert.equal(r.status, 0, r.stderr);
  const saved = JSON.parse(fs.readFileSync(registry, 'utf8'));
  assert.equal(saved.version, 1);
  assert.equal(saved.projects.length, 1);
  assert.equal(saved.projects[0].root, root);
});

test('the live runtime and the CLI share one protected-root rule', () => {
  // Both modules import the same table; reading it through the plugin must see the archive too.
  const pluginSource = fs.readFileSync(path.join(REPO, 'chatbot/plugins/kurumi-tasks/projects.js'), 'utf8');
  assert.match(pluginSource, /assertNotProtectedRoot/, 'runtime must use the shared rule');
  assert.doesNotMatch(pluginSource, /PROTECTED_ROOTS\s*=\s*\[/, 'runtime must not keep its own copy');
});

test('a registry created by --apply is written mode 600', () => {
  const state = tmpdir('registry-state-');
  const root = makeProject(tmpdir('proj-'));
  const registry = path.join(state, 'projects.json');
  // No pre-existing registry: this is the case where writeFileSync's mode applies.
  const file = writeDraft(path.join(state, 'entry.json'), entryFor(root));
  const r = runCli(['--add', file, '--apply'], {state});
  assert.equal(r.status, 0, r.stderr);
  assert.equal(fs.statSync(registry).mode & 0o777, 0o600, 'new registry must be private');
});
