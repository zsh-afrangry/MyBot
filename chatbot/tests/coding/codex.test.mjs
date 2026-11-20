import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as delay} from 'node:timers/promises';
import {createBackendClient} from '../../plugins/kurumi-coding/backends.js';
import {inspectOwnedRuntime} from '../../packages/coding-runtime/reconciliation.js';
import {fixture} from './fixtures.mjs';

const script = fileURLToPath(new URL('./codex-peer.mjs', import.meta.url));
const backend = 'codex-app-server';
const quote = text => "'" + text.replaceAll("'", "'\\''") + "'";
async function codexFixture(t, {mode} = {}) {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-codex-fixture-bin-'));
  const command = path.join(bin, 'codex');
  t.after(() => fs.rmSync(bin, {recursive: true, force: true}));
  return fixture(t, {configure(config) {
    const protectedFile = path.join(config.projects[0].root, 'value.mjs');
    const parts = [process.execPath, script, protectedFile, mode ?? ''];
    fs.writeFileSync(command, `#!/bin/bash\nif [ "$1" = sandbox ]; then exit ${mode === 'no-sandbox' ? 1 : 0}; fi\nexec ${parts.map(quote).join(' ')}\n`, {mode: 0o700});
    config.codex = {command};
    fs.mkdirSync(path.join(config.root, 'backend', 'codex-home'), {recursive: true, mode: 0o700});
  }, clientFactory: createBackendClient});
}
const start = (f, task) => f.run({action: 'start', projectId: 'fixture', backend, task});

test('Codex must be enabled by the operator; legacy DSH tasks cannot be switched or replayed', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.run({action: 'list'})).backends, ['dsh-acp']);
  await assert.rejects(start(f, 'work'), {code: 'coding_backend_not_enabled'});
  assert.deepEqual(f.service.store.list(), []);
  const task = await f.run({action: 'start', projectId: 'fixture', task: 'Default backend'});
  const settled = await f.settle(task.id);
  f.service.store.save({...f.service.store.get(task.id), backend: undefined});
  await assert.rejects(f.run({action: 'continue', taskId: task.id, backend, task: 'change backend'}), {code: 'coding_backend_only_for_start'});
  await f.run({action: 'continue', taskId: task.id, task: 'resume the original'});
  const resumed = await f.settle(task.id);
  assert.equal(resumed.backend, 'dsh-acp');
  assert.equal(resumed.externalSessionId, settled.externalSessionId);
});

test('Codex uses a persisted original thread, independent checks and round-specific output behind the filesystem fence', async t => {
  const f = await codexFixture(t);
  assert.deepEqual((await f.run({action: 'list'})).backends, ['dsh-acp', backend]);
  const {id} = await start(f, 'Update the fixture');
  const first = await f.settle(id);
  assert.equal(first.state, 'ready');
  assert.equal(first.backend, backend);
  assert.equal(first.checks.ok, true);
  assert.deepEqual(first.executionBoundary.writeRoots, [path.join(f.pluginConfig.root, 'backend', 'codex-home'), first.cwd]);
  const one = (await f.run({action: 'result', taskId: id})).result;
  assert.equal(one.page.source, 'codex_command_execution_results');
  assert.match(one.page.text, /fixture actual stdout 2/);
  assert.doesNotMatch(one.page.text, /private reasoning|unrelated turn output|fixture model report/);
  const agentReport = (await f.run({action: 'result', taskId: id, section: 'agent_report'})).result;
  assert.equal(agentReport.page.text, 'fixture model report');
  await f.run({action: 'continue', taskId: id, task: 'Update the fixture again'});
  const second = await f.settle(id), two = (await f.run({action: 'result', taskId: id})).result;
  assert.equal(second.state, 'ready');
  assert.equal(second.externalSessionId, first.externalSessionId);
  assert.notEqual(two.externalTurnId, one.externalTurnId);
  assert.match(two.page.text, /fixture actual stdout 3/);
  assert.equal((await f.run({action: 'result', taskId: id, roundId: one.roundId})).result.page.text, one.page.text);
  assert.equal(fs.readFileSync(path.join(f.source, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
  assert.equal(f.deliveries.length, 2);
});

test('Codex permission callback is denied and reports blocked rather than cancelled', async t => {
  const f = await codexFixture(t);
  const {id} = await start(f, 'FIXTURE_APPROVAL');
  const done = await f.settle(id);
  assert.equal(done.state, 'needs_permission');
  assert.equal(done.permissionSummary.rejected, 1);
  assert.equal(done.checks, undefined);
  const recorded = JSON.parse(fs.readFileSync(done.permissionSummary.privateAuditFile, 'utf8'));
  assert.equal(recorded.externalSessionId, done.externalSessionId);
  assert.equal(recorded.correlated, true);
  assert.equal(done.delivery.state, 'platform_accepted');
});

test('Codex cannot create a backend session if its native sandbox probe fails', async t => {
  const f = await codexFixture(t, {mode: 'no-sandbox'});
  const {id} = await start(f, 'Do not run without the sandbox');
  const done = await f.settle(id);
  assert.equal(done.state, 'failed');
  assert.equal(done.reason, 'codex_sandbox_unavailable');
  assert.equal(done.externalSessionId, undefined);
  assert.equal(done.checks, undefined);
  assert.equal(fs.readFileSync(path.join(done.cwd, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
});

test('Codex cancellation stops its owned command before reporting cancelled', async t => {
  const f = await codexFixture(t);
  const {id, cwd} = await start(f, 'FIXTURE_WAIT');
  const heartbeat = path.join(cwd, 'heartbeat');
  for (let i = 0; i < 100 && !fs.existsSync(heartbeat); i++) await delay(30);
  assert(fs.existsSync(heartbeat));
  await f.run({action: 'cancel', taskId: id});
  const done = await f.settle(id);
  assert.equal(done.state, 'cancelled');
  const facts = f.service.store.get(id);
  assert.equal(inspectOwnedRuntime(facts.runtimeIdentity, facts.runtimeProcesses, cwd).stopped, true);
  const size = fs.statSync(heartbeat).size;
  await delay(100);
  assert.equal(fs.statSync(heartbeat).size, size);
});

for (const mode of ['wrong-policy', 'wrong-thread']) {
  test(`Codex refuses an unexpected ${mode === 'wrong-policy' ? 'effective policy' : 'resumed thread'} before sending the prompt`, async t => {
    const f = await codexFixture(t, {mode});
    const {id} = await start(f, 'Write only after binding');
    const first = await f.settle(id);
    if (mode === 'wrong-policy') {
      assert.equal(first.state, 'failed');
      assert.equal(first.reason, 'codex_policy_mismatch');
      assert.equal(first.externalSessionId, undefined);
      assert.equal(fs.readFileSync(path.join(first.cwd, 'value.mjs'), 'utf8'), 'export const value = 1;\n');
    } else {
      assert.equal(first.state, 'ready');
      await f.run({action: 'continue', taskId: id, task: 'Do not switch threads'});
      const second = await f.settle(id);
      assert.equal(second.state, 'failed');
      assert.equal(second.reason, 'codex_thread_mismatch');
      assert.equal(second.externalSessionId, first.externalSessionId);
      assert.equal(fs.readFileSync(path.join(first.cwd, 'value.mjs'), 'utf8'), 'export const value = 2;\n');
    }
  });
}
