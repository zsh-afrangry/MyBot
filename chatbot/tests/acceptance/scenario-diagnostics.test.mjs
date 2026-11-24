// Isolated gateway and synthetic fault only; no real QQ, model or production writes.
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {fileURLToPath} from 'node:url';

const repo = fileURLToPath(new URL('../../../', import.meta.url));

test('a failed isolated scenario exposes a runnable, isolated log query and cleanup status', {timeout: 100000}, t => {
  if (!existsSync(join(repo, 'node_modules/openclaw/openclaw.mjs'))
    || !existsSync('/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run')) {
    t.skip('Isolated gateway dependencies are unavailable');
    return;
  }
  const outputRoot = join(repo, 'test-output');
  mkdirSync(outputRoot, {recursive: true});
  const outputDir = mkdtempSync(join(outputRoot, 'scenario-diagnostics-test-'));
  let fixtureRoot;
  t.after(() => {
    if (fixtureRoot?.startsWith(join(tmpdir(), 'kurumi-host-admin-host-'))) rmSync(fixtureRoot, {recursive: true, force: true});
    rmSync(outputDir, {recursive: true, force: true});
  });
  const out = join(outputDir, 'report.json');
  const result = spawnSync(process.execPath, [join(repo, 'chatbot/scripts/scenario-acceptance.mjs'),
    '--target', 'isolated', '--scenario', 'host-admin', '--diagnostic-fault', 'host-fixture', '--out', out],
  {cwd: repo, encoding: 'utf8', timeout: 90000});
  assert.equal(result.status, 1, result.stderr);
  const report = JSON.parse(readFileSync(out, 'utf8'));
  const scenario = report.scenarios[0], {failure} = scenario;
  fixtureRoot = failure.reference.diagnosticsRoot;
  assert.equal(failure.step, 'fixture diagnostic failure');
  assert.equal(failure.diagnostic.error, 'synthetic host fixture failure');
  assert.deepEqual(scenario.cleanup, {gateway: 'stopped', fixture: 'retained'});
  assert.equal(failure.reference.scope, 'retained_fixture');
  const log = spawnSync(failure.reference.command, failure.reference.args, {cwd: repo, encoding: 'utf8', timeout: 10000});
  assert.equal(log.status, 0, log.stderr);
  const sourceStatus = JSON.parse(log.stdout).sourceStatus;
  assert(sourceStatus.some(row => row.source === 'openclaw-runtime' && row.status === 'available'));
  assert(!sourceStatus.some(row => row.source === 'snowluma'));
});
