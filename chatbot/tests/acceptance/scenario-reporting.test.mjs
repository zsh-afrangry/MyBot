import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {test} from 'node:test';
import {classifyHealth, deploymentFailures, failureDiagnostic, fixtureCleanup, fixtureReference} from './scenario-reporting.mjs';

test('production health separates historical Cron failures without hiding either failure', () => {
  const cronFailure = 'Cron job fixture last run failed';
  const healthy = {ok: true, issues: [], cron: {jobs: []}};
  assert.deepEqual(classifyHealth(healthy), {base: {ok: true, issues: 0}, cron: {ok: true, available: true, issues: 0}});
  assert.deepEqual(classifyHealth({ok: false, issues: ['QQ channel is disconnected', cronFailure],
    cronFailures: [cronFailure], cron: {jobs: []}}),
  {base: {ok: false, issues: 1}, cron: {ok: false, available: true, issues: 1}});
  assert.deepEqual(classifyHealth({ok: false, issues: ['Cron state is unavailable']}),
    {base: {ok: true, issues: 0}, cron: {ok: false, available: false, issues: 0}});
  assert.throws(() => classifyHealth({ok: true, issues: [cronFailure], cron: {jobs: []}}), /invalid_health_report/);
  assert.deepEqual(deploymentFailures({checks: [{name: 'gateway', status: 'passed'},
    {name: 'semantic-health-cron', status: 'failed'}]}), ['semantic-health-cron']);
});

test('retained gateway logs are scoped to temporary fixtures and preserve nested roots', t => {
  const root = mkdtempSync(join(tmpdir(), 'kurumi-report-test-'));
  t.after(() => rmSync(root, {recursive: true, force: true}));
  for (const child of ['enabled', 'disabled']) {
    mkdirSync(join(root, child));
    writeFileSync(join(root, child, 'openclaw.json'), '{}');
  }
  const ref = fixtureReference({diagnosticsRoot: root}, '/fixture-repository');
  assert.equal(ref.runtimeRoot, join(root, 'enabled'));
  assert.equal(ref.alternatives[0].runtimeRoot, join(root, 'disabled'));
  assert.deepEqual(ref.args.slice(1, 5), ['--runtime-root', join(root, 'enabled'), '--snowluma-root', join(root, 'enabled')]);
  assert(ref.args.includes('openclaw-session'));
  assert(!ref.args.includes('snowluma'));
  assert.equal(fixtureReference({diagnosticsRoot: '/home'}, '/fixture-repository'), undefined);
  symlinkSync('/home', join(root, 'outside'));
  assert.equal(fixtureReference({diagnosticsRoot: join(root, 'outside')}, '/fixture-repository'), undefined);
});

test('diagnostics distinguish a retained fixture from an unclean gateway shutdown', () => {
  assert.deepEqual(fixtureCleanup({gatewayStopped: true, fixtureCleaned: false, knowledgeMapStopped: true}),
    {gateway: 'stopped', fixture: 'retained', knowledgeMap: 'stopped'});
  assert.deepEqual(fixtureCleanup({gatewayStopped: false, fixtureRemoved: true}),
    {gateway: 'forced_or_failed', fixture: 'removed'});
  assert.deepEqual(fixtureCleanup({}), {gateway: 'unknown', fixture: 'unknown'});
  assert.deepEqual(failureDiagnostic({error: 'Failure Bearer abcdefghijk token=private\nprivate stack'}),
    {error: 'Failure Bearer [REDACTED] token=[REDACTED]'});
});
