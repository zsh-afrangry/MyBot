// Real local processes/Git/SQLite, synthetic tasks only. No model, QQ, shared-service or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {setTimeout as delay} from 'node:timers/promises';
import {fixture} from './fixtures.mjs';
import {CodingService} from '../../plugins/kurumi-coding/service.js';
import {git, targetState} from '../../plugins/kurumi-coding/workspaces.js';
import {processIdentity, sameProcess, descendants} from '../../packages/coding-runtime/acp-client.js';
import {inspectOwnedRuntime, stopOwnedRuntime} from '../../packages/coding-runtime/reconciliation.js';

async function ready(t) {
  const f = await fixture(t), task = await f.run({action: 'start', projectId: 'fixture', task: 'synthetic verified change'});
  await f.settle(task.id);
  return {f, task: f.service.store.get(task.id)};
}
async function restart(t, f) {
  await f.service.stop();
  const service = new CodingService(f.pluginConfig, {authorize: f.service.authorize, clientFactory: f.service.clientFactory});
  service.start(); t.after(() => service.stop()); return service;
}
async function runtime(t, cwd) {
  const marker = path.join(cwd, 'restart-heartbeat');
  const code = `const{spawn}=require('node:child_process');spawn(process.execPath,['-e',"setInterval(()=>require('node:fs').appendFileSync(process.argv[1],'x'),25)",process.argv[1]],{stdio:'ignore'});setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, ['-e', code, marker], {cwd, detached: true, stdio: 'ignore'});
  for (let i = 0; i < 100 && !fs.existsSync(marker); i++) await delay(20);
  assert.ok(fs.existsSync(marker));
  const identity = processIdentity(child.pid), known = descendants(child.pid);
  t.after(async () => {
    await stopOwnedRuntime(identity, known, cwd);
    // The fixture's earlier cleanup may already have unlinked cwd. Test-owned
    // ChildProcess handles remain our cleanup authority; production never uses this fallback.
    for (const p of known.toReversed()) if (sameProcess(p)) try {process.kill(p.pid, 'SIGKILL');} catch (e) {if (e.code !== 'ESRCH') throw e;}
  });
  return {child, identity, known, marker};
}

test('restart reconciliation observes the real owned tree, never replays it, and cancellation leaves another task alive', async t => {
  const {f, task} = await ready(t), owned = await runtime(t, task.cwd);
  const otherDir = path.join(f.root, 'other-task'); fs.mkdirSync(otherDir);
  const other = await runtime(t, otherDir), source = targetState({root: f.source});
  f.service.store.save({...task, state: 'running', runtimeIdentity: owned.identity, runtimeProcesses: owned.known});
  const service = await restart(t, f), count = f.calls.filter(c => c.method === 'prompt').length;
  const observed = service.reconcile(task.id, task.requester);
  assert.equal(observed.state, 'needs_reconciliation'); assert.equal(observed.reconciliation.verified, true);
  assert.equal(observed.reconciliation.stopped, false); assert.ok(observed.reconciliation.processCount >= 2);
  assert.equal(f.calls.filter(c => c.method === 'prompt').length, count);
  assert.throws(() => service.continue(task.id, 'no duplicate', task.requester, 'a'.repeat(64)), /original_runtime_still_running/);
  const result = await service.cancel(task.id, task.requester); assert.equal(result.state, 'cancelled');
  assert.equal(sameProcess(owned.identity), false); assert.ok(sameProcess(other.identity));
  const size = fs.statSync(owned.marker).size; await delay(100); assert.equal(fs.statSync(owned.marker).size, size);
  assert.deepEqual(targetState({root: f.source}), source);
});

test('a recorded live group member anchors an orphan; an unanchored numeric group cannot be killed', async t => {
  const {task} = await ready(t), owned = await runtime(t, task.cwd);
  const exited = once(owned.child, 'exit'); owned.child.kill('SIGKILL'); await exited;
  assert.equal(sameProcess(owned.identity), false);
  const unknown = inspectOwnedRuntime(owned.identity, [], task.cwd);
  assert.equal(unknown.verified, false); assert.equal(unknown.reason, 'runtime_group_unverified');
  const refused = await stopOwnedRuntime(owned.identity, [], task.cwd); assert.equal(refused.stopped, false);
  const before = fs.statSync(owned.marker).size; await delay(100); assert.ok(fs.statSync(owned.marker).size > before);
  const verified = inspectOwnedRuntime(owned.identity, owned.known, task.cwd); assert.equal(verified.verified, true);
  assert.equal((await stopOwnedRuntime(owned.identity, owned.known, task.cwd)).stopped, true);
});

test('reused PID identity and changed cwd fail without signalling a live process', async t => {
  const {task} = await ready(t), owned = await runtime(t, task.cwd);
  for (const [identity, cwd, reason] of [[{...owned.identity, start: '0'}, task.cwd, 'runtime_pid_reused'],
    [owned.identity, path.dirname(task.cwd), 'runtime_ownership_changed']]) {
    const state = await stopOwnedRuntime(identity, owned.known, cwd);
    assert.equal(state.verified, false); assert.equal(state.reason, reason); assert.ok(sameProcess(owned.identity));
  }
});

test('a stopped interrupted task is snapshotted without model replay or notification and resumes only on explicit continue', async t => {
  const {f, task} = await ready(t);
  fs.writeFileSync(path.join(task.cwd, 'unfinished.txt'), 'retain incomplete work');
  f.service.store.save({...task, state: 'running'});
  const service = await restart(t, f), count = f.calls.filter(c => c.method === 'prompt').length;
  assert.equal(service.reconcile(task.id, task.requester).state, 'interrupted');
  const saved = service.store.get(task.id); assert.ok(fs.existsSync(path.join(saved.snapshotPath, 'untracked.json')));
  assert.equal(f.calls.filter(c => c.method === 'prompt').length, count); assert.equal(f.deliveries.length, 1);
  service.continue(task.id, 'explicit continuation', task.requester, 'b'.repeat(64)); await service.idle(task.id);
  assert.equal(service.status(task.id, task.requester).state, 'ready');
  assert.equal(service.store.get(task.id).externalSessionId, task.externalSessionId);
  assert.equal(f.calls.filter(c => c.method === 'prompt').length, count + 1);
});

for (const applied of [false, true]) test(`interrupted merge is reconciled by exact frozen candidate facts (applied=${applied})`, async t => {
  const {f, task} = await ready(t);
  const preview = await f.run({action: 'preview', taskId: task.id}); f.approve(preview);
  const {confirmationScope} = await import('../../plugins/kurumi-coding/inbound.js');
  const payload = f.service.store.claimMerge(task, preview.proposalId, confirmationScope(f.context));
  if (applied) git(f.source, 'merge', '--ff-only', payload.candidate);
  const before = targetState({root: f.source}), count = f.calls.length, service = await restart(t, f);
  const reconciled = service.reconcile(task.id, task.requester);
  assert.equal(reconciled.state, applied ? 'merged' : 'ready');
  assert.deepEqual(targetState({root: f.source}), before); assert.equal(f.calls.length, count);
  if (!applied) await assert.rejects(service.merge(task.id, preview.proposalId, task.requester, confirmationScope(f.context), () => {}));
});
