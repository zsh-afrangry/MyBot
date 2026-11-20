// Offline HTTP acceptance: synthetic identities, state, logs and roles only.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import test from 'node:test';
import {fixture, fixtureOwner, fixtureMember, fixturePaperJob} from './fixture.mjs';

const policyPath = 'config/access-control.json';

async function setup(t) {
  const f = await fixture();
  t.after(() => f.close());
  return f;
}

async function preview(api, input) {
  const r = await api('/change/preview', {data: input});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

async function commit(api, id) {
  const r = await api('/change/commit', {data: {id}});
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.saved, true);
  assert.equal(r.body.recorded, true);
  assert.equal(r.body.pendingSync, true);
  return r.body;
}

test('loopback, Host/Origin, authenticated private routes and logout', async t => {
  const f = await setup(t);
  const home = await fetch(f.base + '/');
  assert.equal(home.status, 200);
  assert.match(home.headers.get('content-security-policy'), /frame-ancestors 'none'/u);
  assert.equal(home.headers.get('cache-control'), 'no-store');
  assert.match(await home.text(), /Kurumi/u);
  assert.equal((await f.call('/api/memory?content=1')).status, 401);
  assert.equal((await f.call('/api/whitelist')).status, 401);
  assert.equal((await f.call('/api/session', {headers: {'X-Forwarded-Host': 'external.test'}})).status, 403);
  const badHost = await new Promise((resolve, reject) => {
    http.get(f.base + '/api/session', {headers: {Host: 'rebind.test:3085'}}, res => {
      res.resume(); resolve(res.statusCode);
    }).on('error', reject);
  });
  assert.equal(badHost, 403);
  assert.equal((await f.call('/api/login', {origin: 'http://127.0.0.1:3082', data: {key: f.key}})).status, 403);
  assert.equal((await f.call('/api/login', {data: {key: 'wrong'}})).status, 401);
  const login = await f.call('/api/login', {data: {key: f.key}});
  assert.equal(login.status, 200);
  assert.equal(login.headers.get('set-cookie'), null);
  assert.equal((await f.call('/api/whitelist', {headers: {Cookie: 'kurumi_admin_session=' + login.body.token}})).status, 401);
  assert.equal((await f.call('/api/whitelist', {token: login.body.token})).status, 200);
  const api = await f.session();
  assert.equal((await api('/change/preview', {data: {}, origin: 'http://127.0.0.1:3082'})).status, 403);
  assert.equal((await api('/change/preview', {data: {}, headers: {'Content-Type': 'text/plain'}})).status, 415);
  assert.equal((await api('/change/preview', {data: {text: 'a'.repeat(270000)}})).status, 413);
  assert.equal((await api('/logout', {data: {}})).status, 200);
  assert.equal((await api('/whitelist')).status, 401);
});

test('QQ member and mail recipient CRUD validate policy and never update the runtime copy', async t => {
  const f = await setup(t), api = await f.session();
  const effective = f.file(f.runtime, 'openclaw.json');
  const current = async () => (await api('/whitelist')).body;
  const init = await current();
  assert.equal(init.sourceRevision, 1);
  const add = {kind: 'member', operation: 'add', qq: fixtureMember, revision: init.revision, enabled: true,
    note: '合成成员', permissions: ['chat.use', 'qq.reply'], expiresAt: null};
  assert.equal((await api('/change/preview', {data: {...add, permissions: ['host.exec']}})).status, 400);
  assert.equal((await api('/change/preview', {data: {...add, operation: 'remove', qq: fixtureOwner}})).status, 403);
  const proposal = await preview(api, add);
  assert.equal((await current()).sourceRevision, 1);
  const otherSession = await f.session();
  assert.equal((await otherSession('/change/commit', {data: {id: proposal.id}})).status, 409);
  await commit(api, proposal.id);
  assert.equal((await api('/change/commit', {data: {id: proposal.id}})).status, 409);
  const added = await current();
  assert.equal(added.sourceRevision, 2);
  assert.equal(added.runtimeRevision, 1);
  assert.equal(added.aligned, false);
  assert.deepEqual(added.rows.find(r => r.source.qq === fixtureMember).source.permissions, {'chat.use': true, 'qq.reply': true});
  const edit = await preview(api, {...add, operation: 'edit', revision: added.revision, enabled: false, permissions: ['qq.reply'],
    expiresAt: '2028-01-12T09:05:00+08:00', note: '已修改'});
  assert.equal(edit.after.expiresAt, '2028-01-12T01:05:00.000Z');
  await commit(api, edit.id);
  assert.equal((await current()).rows.find(r => r.source.qq === fixtureMember).source.enabled, false);
  await commit(api, (await preview(api, {kind: 'member', operation: 'remove', revision: (await current()).revision, qq: fixtureMember})).id);
  for (const [operation, address, nextAddress] of [
    ['add', null, 'Second@Example.com'], ['edit', 'second@example.com', 'third@example.com'], ['remove', 'third@example.com', null],
  ]) await commit(api, (await preview(api, {kind: 'mail', operation, revision: (await current()).revision, address, nextAddress})).id);
  const end = await current();
  assert.equal(end.rows.length, 1);
  assert.deepEqual(end.rows[0].source.mailRecipients, ['first@example.com']);
  assert.equal(end.sourceRevision, 7);
  assert.equal(f.file(f.runtime, 'openclaw.json'), effective);
  const audit = (await api('/audit')).body.rows;
  assert.equal(audit.length, 6);
  assert.doesNotMatch(JSON.stringify(audit), /example\.com|100000002|合成成员/u);
  assert.equal(fs.statSync(path.join(f.local, 'access-key')).mode & 0o777, 0o600);
});

test('persona diffs reject placeholders, stale previews, replaced role selection and symlinks', async t => {
  const f = await setup(t), api = await f.session();
  const get = async () => (await api('/persona/soul')).body;
  const draft = async text => ({...(await get()), kind: 'persona', text});
  const shape = ({source, ...input}) => input;
  const testText = '# 合成角色\n\n加入一行验收文本。\n';
  const current = await get();
  const projection = async () => (await api('/persona')).body;
  assert.deepEqual((await projection()).workspaces[0].files.map(f => f.state), ['match', 'match', 'match', 'match']);
  const owner = (await api('/persona/owner')).body;
  const {source: _source, ...ownerDraft} = owner;
  await commit(api, (await preview(api, {...ownerDraft, kind: 'persona', text: '# 修改合成主人关系\n'})).id);
  assert.deepEqual((await projection()).workspaces[0].files.filter(f => f.state !== 'match'),
    [{name: 'USER.md', state: 'different'}]);
  assert.equal((await api('/change/preview', {data: shape(await draft('{{待替换}}'))})).status, 400);
  const a = await preview(api, shape(await draft(testText)));
  const b = await preview(api, shape(await draft('# 另一版'))); // 同一源版本的并行候选
  assert.equal(a.before, current.text);
  assert.equal(f.file(f.source, 'roles/fusion.md'), current.text);
  await commit(api, a.id);
  assert.equal((await api('/change/commit', {data: {id: b.id}})).status, 409);
  assert.equal(f.file(f.source, 'roles/fusion.md'), testText);
  assert.equal(f.file(f.runtime, 'workspace/SOUL.md'), current.text);
  assert.equal((await api('/persona')).body.aligned, false);
  const c = await preview(api, shape(await draft('# 另一个候选')));
  const configPath = path.join(f.source, 'config/persona.json');
  const conf = JSON.parse(fs.readFileSync(configPath));
  conf.roleFile = 'roles/owner.md';
  fs.writeFileSync(configPath, JSON.stringify(conf));
  assert.equal((await api('/change/commit', {data: {id: c.id}})).status, 409);
  const target = path.join(f.source, 'roles/owner.md');
  fs.renameSync(target, target + '.kept');
  fs.symlinkSync(path.join(f.runtime, 'workspace/SOUL.md'), target);
  assert.equal((await api('/persona/soul')).status, 503);
  assert.equal(f.file(f.runtime, 'workspace/SOUL.md'), current.text);
});

test('protected lists compare the registered configuration without exposing commands or permitting writes', async t => {
  const f = await setup(t), api = await f.session();
  assert.equal((await f.call('/api/whitelist/managed')).status, 401);
  const lists = (await api('/whitelist/managed')).body;
  assert.deepEqual(lists.tools, {source: ['fixture_tool'], runtime: ['fixture_tool'], aligned: true});
  assert.deepEqual(lists.directories.source, ['/synthetic/extra']);
  assert.deepEqual(lists.projects.source[0].checks, ['fixture-check']);
  assert.doesNotMatch(JSON.stringify(lists), /private-fixture-command/u);
  const configFile = path.join(f.source, 'config/runtime.config.json');
  const config = JSON.parse(fs.readFileSync(configFile));
  config.agents.entries.main.tools.alsoAllow.push('new_tool');
  config.plugins.entries['kurumi-coding'].config.projects[0].checks[0].command = 'new-private-fixture-command';
  fs.writeFileSync(configFile, JSON.stringify(config));
  const changed = (await api('/whitelist/managed')).body;
  assert.equal(changed.tools.aligned, false);
  assert.equal(changed.projects.aligned, false);
  assert.equal((await api('/change/preview', {data: {kind: 'owner_tool', operation: 'add', tool: 'new_tool'}})).status, 400);
});

test('real read adapters bound the content of diagnostics and expose numbered docs only', async t => {
  const f = await setup(t), api = await f.session();
  const mem = (await api('/memory')).body;
  assert.equal(mem.facts, 1);
  assert.equal(mem.factItems, undefined);
  const expanded = (await api('/memory?content=1')).body;
  assert.equal(expanded.factItems[0].text, '假设偏好热茶。');
  assert.doesNotMatch(JSON.stringify(expanded), /原文投影隔离的验收证据|fixture-run/u);
  const log = await api('/logs?source=trace-events&runId=fixture-run');
  assert.equal(log.status, 200, JSON.stringify(log.body));
  assert.equal(log.body.entries[0].code, 'SAMPLE_CODE');
  assert.match(log.body.entries[0].ref, /^event:/u);
  assert.doesNotMatch(JSON.stringify(log.body), /fixture-private-chat|fixture-private-key/u);
  const metadata = await api('/logs?source=trace-events&q=fixture-private-chat');
  assert.equal(metadata.body.count, 0);
  const errors = await api('/logs?source=trace-events&view=errors&q=sample_code');
  assert.equal(errors.body.entries[0].code, 'SAMPLE_CODE');
  assert.equal((await api('/logs?source=snowluma-messages')).status, 400);
  const cron = (await api('/ops/cron')).body;
  assert.equal(cron.total, 1);
  assert.equal(cron.rows[0].status, 'error');
  const papers = (await api('/ops/papers')).body;
  assert.equal(papers.total, 1);
  assert.equal(papers.rows[0].id, fixturePaperJob);
  assert.equal(papers.rows[0].delivery, 'delivered');
  assert.doesNotMatch(JSON.stringify(papers), /filename|testPadding/u);
  assert.equal((await api('/logs?taskId=' + fixturePaperJob)).body.entries[0].correlation.taskId, fixturePaperJob);
  assert.equal((await api('/logs?taskId=other-job')).body.count, 0);
  assert.equal((await api('/docs/25')).body.title, '人格与连续性');
  assert.equal((await api('/docs/example')).status, 404);
  assert.equal((await api('/docs/%2e%2e%2fexample')).status, 404);
  assert.equal((await api('/inventory')).body.docs.length, 2);
});
