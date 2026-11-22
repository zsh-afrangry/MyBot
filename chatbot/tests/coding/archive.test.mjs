// Offline archive regression: aggregation fields, historical read across stale session keys, and binding invariants; no model, QQ or production writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import {fixture, owner} from './fixtures.mjs';

const start = f => f.run({action: 'start', projectId: 'fixture', task: 'Run the requested synthetic experiment.'});
const canonical = {subjectId: owner, sessionKey: `agent:main:kurumi-qq:direct:${owner}`, to: `user:${owner}`};

test('archive aggregates one task and lists historical tasks', async t => {
  const f = await fixture(t);
  const task = await start(f);
  const ready = await f.settle(task.id);
  const list = await f.run({action: 'archive'});
  assert.equal(list.length, 1);
  assert.equal(list[0].id, task.id);
  assert.equal(list[0].projectId, 'fixture');
  assert.equal(list[0].state, 'ready');
  assert.equal(list[0].title, null);
  const full = await f.run({action: 'archive', taskId: task.id});
  assert.equal(full.id, task.id);
  assert.equal(full.state, 'ready');
  assert.equal(full.executionRoundId, ready.executionRoundId);
  assert.equal(full.rounds.length, 1);
  assert.equal(full.rounds[0].roundId, ready.executionRoundId);
  assert.equal(full.rounds[0].state, 'ready');
  assert.equal(full.rounds[0].hostChecks.ok, true);
  assert.equal(full.rounds[0].delivery.state, 'platform_accepted');
  assert.ok(full.rounds[0].verifiedCommit);
  assert.ok(full.createdAt);
});

test('archive reads historical tasks with a stale session key; binding stays for writes', async t => {
  const f = await fixture(t);
  const task = await start(f);
  await f.settle(task.id);
  const stored = f.service.store.get(task.id);
  f.service.store.save({...stored, requester: {...stored.requester, sessionKey: `agent:main:qq-bridge:direct:${owner}`}});
  assert.equal(f.service.list(canonical).length, 0);
  assert.throws(() => f.service.status(task.id, canonical), /unknown_coding_task/);
  const list = f.service.archive(undefined, canonical);
  assert.equal(list.length, 1);
  assert.equal(list[0].id, task.id);
  const full = f.service.archive(task.id, canonical);
  assert.equal(full.id, task.id);
  assert.equal(full.rounds.length, 1);
  assert.equal(full.rounds[0].roundId, stored.executionRoundId);
});

test('archive requires tasks.read in both modes', async t => {
  const f = await fixture(t);
  const task = await start(f);
  await f.settle(task.id);
  f.config.channels['kurumi-qq'].accessControl.subjects[0].permissions['tasks.read'] = false;
  await assert.rejects(f.run({action: 'archive'}), /capability_not_allowed/);
  await assert.rejects(f.run({action: 'archive', taskId: task.id}), /capability_not_allowed/);
});
