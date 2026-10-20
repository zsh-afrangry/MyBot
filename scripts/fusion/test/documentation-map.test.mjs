// Documentation ownership and generated-index regression (docs/16).
// All mutations stay in a temporary repository; no runtime imports, services, APIs or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {loadDocumentationMap, ownerFor, discoverMaintenanceSources, walkFiles} from '../lib/documentation-map.mjs';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

test('suite ownership prefers exact files and longer directories; evidence rejects overlap', () => {
  const rules = [{prefix: 'tests/', documents: ['base']}, {prefix: 'tests/mail/', documents: ['mail']}, {path: 'tests/mail/one.js', documents: ['one']}];
  assert.equal(ownerFor('tests/mail/one.js', rules).documents[0], 'one');
  assert.equal(ownerFor('tests/mail/two.js', rules).documents[0], 'mail');
  assert.equal(ownerFor('tests/other.js', rules).documents[0], 'base');
  assert.equal(ownerFor('unknown.js', rules), null);
  assert.throws(() => ownerFor('tests/mail/one.js', rules, {exclusive: true}), /Overlapping/);
});

test('discovery includes nested helpers and misplaced scripts, excludes dependency/build trees', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-doc-discovery-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const files = ['chatbot/x/test/helpers/local.js', 'chatbot/x/src/nested/one.test.ts', 'chatbot/x/src/test-fixtures.ts', 'loose.cjs', 'docs/verification/bad.sh', 'chatbot/x/src/normal.js', 'node_modules/ignored.mjs', 'chatbot/x/dist/ignored.py'];
  for (const rel of files) {
    fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
    fs.writeFileSync(path.join(root, rel), '// fixture\n');
  }
  assert.deepEqual(discoverMaintenanceSources(root), files.slice(0, 5).sort());
});

test('CLI verifies ownership and saved Markdown without touching the real repository', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fusion-doc-index-'));
  t.after(() => fs.rmSync(root, {recursive: true, force: true}));
  const map = loadDocumentationMap(ROOT);
  const copy = (rel) => {
    fs.mkdirSync(path.dirname(path.join(root, rel)), {recursive: true});
    fs.copyFileSync(path.join(ROOT, rel), path.join(root, rel));
  };
  for (const rel of discoverMaintenanceSources(ROOT)) copy(rel);
  // Source extraction resolves directory references to README only when that file exists. Keep the
  // same report shape in the fixture so this check compares like-for-like generated evidence links.
  for (const rel of walkFiles(path.join(ROOT, 'docs/verification')).filter((r) => r.endsWith('/README.md'))) {
    copy(`docs/verification/${rel}`);
  }
  for (const section of ['scriptOwners', 'runtimeSources', 'archivedScripts', 'evidenceOwners']) {
    for (const rule of map[section]) {
      for (const ref of [...rule.documents, ...(rule.evidence ?? [])]) copy(ref);
      const base = section === 'evidenceOwners' ? 'docs/verification/' : '';
      if (rule.prefix) fs.mkdirSync(path.join(root, base + rule.prefix), {recursive: true});
      else copy(base + rule.path);
    }
  }
  copy('scripts/fusion/documentation-map.json');
  const run = (script, ...args) => spawnSync(process.execPath, [`scripts/fusion/${script}.mjs`, ...args], {cwd: root, encoding: 'utf8'});
  const index = (...args) => run('evidence-index', ...args);
  const mapFile = path.join(root, 'scripts/fusion/documentation-map.json');
  const writeMap = (value) => fs.writeFileSync(mapFile, JSON.stringify(value));

  await t.test('saved table and both P2 evidence overrides survive generation', () => {
    const result = index('--check-markdown');
    assert.equal(result.status, 0, result.stderr);
    const rows = JSON.parse(index('--json').stdout);
    for (const name of ['memory.test.mjs', 'memory-continuity-host.mjs']) {
      assert.ok(rows.find((r) => r.path === `chatbot/tests/persona/${name}`).evidence.includes('docs/verification/persona-memory-2026-10-19/p2/README.md'));
    }
  });
  await t.test('unknown source fails even inside a known suite', () => {
    const file = path.join(root, 'chatbot/tests/persona/unregistered.mjs');
    fs.writeFileSync(file, '// fixture\n');
    const result = index('--json');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /unclassified file: chatbot\/tests\/persona\/unregistered/);
    fs.unlinkSync(file);
  });
  await t.test('missing document and invalid/duplicate selectors fail', () => {
    const bad = structuredClone(map);
    bad.scriptOwners[0].documents = ['docs/missing.md'];
    writeMap(bad);
    assert.match(index('--json').stderr, /Missing documentation\/evidence target/);
    bad.scriptOwners[0].documents = ['../outside.md'];
    writeMap(bad);
    assert.match(index('--json').stderr, /Invalid repository-relative path/);
    bad.scriptOwners[0] = map.scriptOwners[0];
    bad.scriptOwners.push(map.scriptOwners[0]);
    writeMap(bad);
    assert.match(index('--json').stderr, /Duplicate ownership selector/);
    writeMap(map);
  });
  await t.test('an existing classified script without a document owner fails', () => {
    const bad = structuredClone(map);
    bad.scriptOwners = bad.scriptOwners.filter((r) => !(r.path ?? r.prefix).startsWith('chatbot/tests/persona/'));
    writeMap(bad);
    const result = index('--json');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /No document ownership for script/);
    writeMap(map);
  });
  await t.test('stale generated table or reversed markers fail', () => {
    const file = path.join(root, 'docs/verification/SCRIPTS.md');
    const before = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, before.replace('| 脚本 |', '| 过期脚本 |'));
    assert.equal(index('--check-markdown').status, 1);
    fs.writeFileSync(file, before.replace('BEGIN GENERATED SCRIPT INDEX', 'TEMP GENERATED SCRIPT INDEX')
      .replace('END GENERATED SCRIPT INDEX', 'BEGIN GENERATED SCRIPT INDEX')
      .replace('TEMP GENERATED SCRIPT INDEX', 'END GENERATED SCRIPT INDEX'));
    assert.equal(index('--check-markdown').status, 1);
    fs.writeFileSync(file, before);
  });
  await t.test('new receipts inherit a named suite; unknown evidence directory fails', () => {
    const known = path.join(root, 'docs/verification/documentation-2026-10-21/fixture.json');
    fs.writeFileSync(known, '{}\n');
    assert.equal(run('evidence-coverage').status, 0);
    const dir = path.join(root, 'docs/verification/unregistered');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'fixture.json'), '{}\n');
    assert.equal(run('evidence-coverage').status, 1);
  });
});
