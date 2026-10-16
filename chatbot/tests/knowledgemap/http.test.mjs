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
  t.diagnostic('真实HTTP双向读写、无DDL、并发冲突、写入幂等、精确金额/月汇总通过；SQLite隔离。');
});
