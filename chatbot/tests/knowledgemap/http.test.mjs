// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「测试计划」。
// Integration: Node tool mapping -> real FastAPI HTTP -> disposable SQLite -> website API.
// No real model, production DB, external weather or QQ. Requires KnowledgeMap checkout.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {mkdtempSync, writeFileSync, rmSync, existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import net from 'node:net';
import {KnowledgeMapClient} from '../../packages/knowledgemap-client/client.js';
import {manageRemoteList} from '../../plugins/personal-reminder-list/remote.js';

test('two entry points share tasks and bills through actual HTTP, including conflict/replay', {timeout: 30000}, async t => {
  const km = process.env.KM_TEST_REPO ?? '/home/afrangry/repository';
  assert.ok(existsSync(join(km, 'backend/tests/assistant_server.py')), 'KM_TEST_REPO must contain document18 test server');
  const root = mkdtempSync(join(tmpdir(), 'km-cross-http-')), tokenFile = join(root, 'token');
  writeFileSync(tokenFile, 'b'.repeat(64), {mode: 0o600});
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn('/home/afrangry/miniconda3/envs/desheng/bin/python', [join(km, 'backend/tests/assistant_server.py'), '--port', String(port), '--token-file', tokenFile], {stdio: ['ignore', 'ignore', 'pipe']});
  let errors = ''; child.stderr.on('data', x => errors += x.toString());
  t.after(async () => {child.kill('SIGTERM'); await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve)); rmSync(root, {recursive: true, force: true});});
  const client = new KnowledgeMapClient({baseUrl: `http://127.0.0.1:${port}`, tokenFile, trace() {}});
  let ready = false;
  for (let i = 0; i < 50; i++) {
    try {ready = (await client.request('/api/assistant/status')).ok; break;} catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(ready, 'isolated API failed to start: ' + errors.slice(-1000));
  const web = async (path, method = 'GET', body) => {
    const result = await fetch(`http://127.0.0.1:${port}/api/${path}`, {method, headers: {'content-type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
    assert.ok(result.ok, `${path}: ${result.status}`); return result.status === 204 ? null : result.json();
  };
  const request = {sessionKey: 'isolated-owner', messageId: 'm1'};
  const added = await manageRemoteList(client, {action: 'add', title: '查党员材料', note: '活动后越快越好', ddl: null}, request);
  assert.equal(added.item.ddl, null);
  let website = await web('calendar-events/'); assert.equal(website[0].note, '活动后越快越好');
  const id = website[0].id;
  const changed = await web(`calendar-events/${id}`, 'PATCH', {title: '网站改过', expected_version: website[0].version});
  assert.equal((await client.allTasks())[0].title, '网站改过');
  await assert.rejects(manageRemoteList(client, {action: 'void', id: added.item.id, expectedVersion: 1}, {...request, messageId: 'm2'}), {code: 'version_conflict'});
  const voided = await manageRemoteList(client, {action: 'void', id: added.item.id, expectedVersion: changed.version}, {...request, messageId: 'm3'});
  assert.equal(voided.item.status, 'void'); assert.equal((await client.allTasks()).length, 0);
  const bill = {amount: '14.00', expense_date: '2026-10-17', category_id: 1, subcategory_id: 2};
  const first = await client.request('/api/assistant/bills', {method: 'POST', body: bill, key: 'bill-http-replay-001'});
  assert.deepEqual(await client.request('/api/assistant/bills', {method: 'POST', body: bill, key: 'bill-http-replay-001'}), first);
  const inWeb = await web('bills/'); assert.equal(inWeb.total, 1); assert.equal(inWeb.items[0].amount, '14.00');
  await web('bills/', 'POST', {...bill, amount: '2.01'});
  const inTool = await client.request('/api/assistant/bills'); assert.equal(inTool.total, 2);
  const summary = await client.request('/api/assistant/bills/monthly', {query: {year: 2026, month: 10}});
  assert.equal(summary.expense, '16.01');
  const row = first.item;
  const command = {action: 'update', id: row.id, expected_version: row.version, fields: {amount: '36.80', note: '跨入口单笔'}};
  const updated = await client.request('/api/assistant/bills/manage', {method: 'POST', body: command, key: 'bill-http-manage-001'});
  assert.equal((await web(`bills/${row.id}`)).amount, '36.80');
  assert.deepEqual(await client.request('/api/assistant/bills/manage', {method: 'POST', body: command, key: 'bill-http-manage-001'}), updated);
  const external = await web(`bills/${row.id}`, 'PATCH', {amount: '35.50', expected_version: updated.item.version});
  await assert.rejects(client.request('/api/assistant/bills/manage', {method: 'POST', body: {action: 'delete', id: row.id, expected_version: updated.item.version}, key: 'bill-http-stale-delete'}), {code: 'version_conflict'});
  const deletion = {action: 'delete', id: row.id, expected_version: external.version};
  const removed = await client.request('/api/assistant/bills/manage', {method: 'POST', body: deletion, key: 'bill-http-delete-001'});
  assert.equal(removed.before.amount, '35.50');
  assert.deepEqual(await client.request('/api/assistant/bills/manage', {method: 'POST', body: deletion, key: 'bill-http-delete-001'}), removed);
  const remaining = await client.request('/api/assistant/bills'); assert.equal(remaining.total, 1); assert.equal(remaining.items[0].amount, '2.01');
  assert.equal((await client.request('/api/assistant/bills/monthly', {query: {year: 2026, month: 10}})).expense, '2.01');

  const multiple = {sessionKey: request.sessionKey, messageId: 'multi-1'};
  const addA = {action: 'add', title: 'HTTP 条目甲', ddl: null};
  const addB = {action: 'add', title: 'HTTP 条目乙', ddl: '2026-11-02T10:30'};
  const savedA = await manageRemoteList(client, addA, multiple);
  const savedB = await manageRemoteList(client, addB, multiple);
  assert.notEqual(savedA.item.id, savedB.item.id);
  assert.equal(savedB.item.ddl, '2026-11-02T10:30');
  assert.deepEqual(await manageRemoteList(client, addA, multiple), savedA);
  await assert.rejects(manageRemoteList(client, {...addA, note: '不同参数'}, multiple), {code: 'idempotency_conflict', status: 409});
  await assert.rejects(manageRemoteList(client, {...addA, title: ' ＨＴＴＰ　 条目甲 '}, multiple), {code: 'idempotency_conflict', status: 409});
  let shared = await web('calendar-events/');
  assert.equal(shared.filter(item => item.title === addA.title).length, 1);
  assert.equal(shared.find(item => item.title === addA.title).note, null, 'a rejected target never rolls back or changes saved items');

  const completeA = {action: 'complete', id: savedA.item.id, expectedVersion: savedA.item.version};
  const completedA = await manageRemoteList(client, completeA, multiple);
  const voidedB = await manageRemoteList(client, {action: 'void', id: savedB.item.id, expectedVersion: savedB.item.version}, multiple);
  assert.equal(completedA.item.status, 'completed'); assert.equal(voidedB.item.status, 'void');
  assert.deepEqual(await manageRemoteList(client, completeA, multiple), completedA);
  await assert.rejects(manageRemoteList(client, {...completeA, action: 'void'}, multiple), {code: 'idempotency_conflict', status: 409});
  await assert.rejects(manageRemoteList(client, {...completeA, expectedVersion: completedA.item.version}, multiple), {code: 'idempotency_conflict', status: 409});
  for (let i = 3; i <= 6; i++) await manageRemoteList(client, {action: 'add', title: `HTTP 条目${i}`}, multiple);
  assert.equal(multiple.listSlots.size, 8);
  const ninth = {action: 'add', title: 'HTTP 第九槽位'};
  await assert.rejects(manageRemoteList(client, ninth, multiple), /最多维护8项/);
  assert.deepEqual(await manageRemoteList(client, addA, multiple), savedA, 'a full message still replays its existing targets');
  shared = await web('calendar-events/');
  assert.equal(shared.length, 7, 'six new items and the original history; no duplicate or ninth slot');
  assert.ok(!shared.some(item => item.title === ninth.title));
  await manageRemoteList(client, ninth, {sessionKey: request.sessionKey, messageId: 'multi-2'});

  // Lose a successful response after the isolated backend has committed, then retry the same target.
  const actualFetch = client.fetchImpl; let dropped = false;
  client.fetchImpl = async (...args) => {
    const result = await actualFetch(...args);
    if (!dropped && args[1].method === 'POST' && result.ok) {
      dropped = true;
      throw Error('simulated lost response after commit');
    }
    return result;
  };
  const uncertain = {sessionKey: request.sessionKey, messageId: 'multi-unknown'};
  const unknownAdd = {action: 'add', title: 'HTTP 结果核对'};
  await assert.rejects(manageRemoteList(client, unknownAdd, uncertain), {code: 'write_result_unknown'});
  const recovered = await manageRemoteList(client, unknownAdd, uncertain);
  assert.equal(recovered.ok, true); assert.equal(uncertain.listSlots.size, 1);
  shared = await web('calendar-events/');
  assert.equal(shared.filter(item => item.title === unknownAdd.title).length, 1);
  assert.equal(shared.length, 9);
  t.diagnostic('真实HTTP双向读写、每消息多目标/8槽位、同参重放/异参409、丢失响应后同键核对、账单维护、版本冲突、精确金额/月汇总通过；SQLite隔离，无生产或QQ写入。');
});
