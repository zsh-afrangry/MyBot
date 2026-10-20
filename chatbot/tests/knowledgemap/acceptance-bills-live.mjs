import {compileAccessConfig} from '../../packages/access-control/config.js';
#!/usr/bin/env node
// 对应文档：docs/23_KnowledgeMap业务能力桥接.md「第二轮开发与验收」。
// Real model/host, production API/MySQL/browser and weather; synthetic owner ingress.
// Explicit --live required. Restarts Fusion; no real QQ send. Cleans only marked test bills.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {spawnSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {KnowledgeMapClient} from '../../packages/knowledgemap-client/client.js';
import {collectEvents, filterEvents} from '../../../scripts/fusion/log-query.mjs';

assert.ok(process.argv.includes('--live'), '--live acknowledges production test writes, real model and service restarts');
const outArg = process.argv.indexOf('--out');
assert.ok(outArg >= 0 && process.argv[outArg + 1], '--out is required');
const out = resolve(process.argv[outArg + 1]); assert.ok(!fs.existsSync(out), 'refuses overwriting evidence');
fs.mkdirSync(resolve(out, '..'), {recursive: true});
const repo = resolve(fileURLToPath(new URL('../../../', import.meta.url))), state = '/home/afrangry/.openclaw-fusion';
const configFile = join(repo, 'config/runtime.config.json'), config = compileAccessConfig(JSON.parse(fs.readFileSync(configFile)),JSON.parse(fs.readFileSync(join(repo,'config/access-control.json'))));
const owner = config.channels['kurumi-qq'].ownerId;
assert.equal(owner, '365999865'); assert.equal(config.channels['kurumi-qq'].testIngress, false);
const {rpc, ready} = await import('../../../scripts/fusion/rpc.mjs');
const {account} = await import('../../plugins/kurumi-qq/src/config.js');
const {onebot} = await import('../../plugins/kurumi-qq/src/transport.js');
const client = new KnowledgeMapClient({...config.plugins.entries['kurumi-knowledgemap'].config, trace() {}});
const marker = '[doc23-r2-' + Date.now().toString(36) + ']', ids = new Set(), started = Date.now();
const report = {at: new Date().toISOString(), marker, boundary: 'Real model/production OpenClaw/API/MySQL/browser/weather; synthetic owner inbound captured without QQ delivery; exact test-row cleanup, original bills unchanged', cases: []};
let ingressChanged = false, browser, originalBills, messageId = -Date.now();
async function bills(query = {}) {
  const page = await client.request('/api/assistant/bills', {query: {...query, limit: 200}});
  assert.equal(page.truncated, false, 'explicitly refuses partial business snapshots'); return page.items;
}
async function web(route, method = 'GET', body) {
  const response = await fetch('http://127.0.0.1:3000/api/' + route, {method, headers: {'Content-Type': 'application/json'}, ...(body ? {body: JSON.stringify(body)} : {})});
  assert.ok(response.ok, `website ${route} HTTP${response.status}`); return response.status === 204 ? null : response.json();
}
async function setIngress(enabled) {
  const current = JSON.parse(fs.readFileSync(configFile));
  assert.equal(current.channels['kurumi-qq'].testIngress, !enabled, 'unexpected concurrent ingress change');
  current.channels['kurumi-qq'].testIngress = enabled;
  // Patch one managed boolean, preserving every other concurrent configuration byte.
  const text = fs.readFileSync(configFile, 'utf8');
  fs.writeFileSync(configFile, text.replace(/("testIngress"\s*:\s*)(true|false)/, '$1' + enabled));
  ingressChanged = true;
  const sync = spawnSync(process.execPath, ['scripts/fusion/sync-config.mjs', '--apply'], {cwd: repo, encoding: 'utf8', timeout: 20000});
  assert.equal(sync.status, 0, 'configuration sync failed');
  const restart = spawnSync('systemctl', ['--user', 'restart', 'kurumi-fusion.service'], {encoding: 'utf8', timeout: 30000});
  assert.equal(restart.status, 0, 'Fusion restart failed'); await ready(); ingressChanged = enabled;
}
let bot;
async function turn(label, text, verify = () => {}) {
  const result = await rpc('kurumi-qq.testInbound', {capture: true, event: {post_type: 'message', message_type: 'private', self_id: bot,
    user_id: Number(owner), message_id: --messageId, time: Math.floor(Date.now() / 1000), message: [{type: 'text', data: {text: text === '/new' ? text : '【文档23架构验证】' + text}}]}}, 180000);
  assert.ok(result.ok, label + ': inbound failed'); await verify(result);
  report.cases.push({label, ok: true}); console.log(JSON.stringify({case: label, ok: true}));
}
try {
  assert.deepEqual((await client.request('/api/assistant/status')).billWrites, ['create', 'update', 'delete']);
  originalBills = await bills();
  bot = Number((await onebot(account(JSON.parse(fs.readFileSync(join(state, 'openclaw.json')))), 'get_login_info', {})).user_id);
  await setIngress(true);
  await turn('new-before-create', '/new');
  await turn('expression-to-first-bill', `这是明确的记账请求：今天午饭花了29.9+6.9元，直接保存一笔，备注原样写“${marker}午饭”，不要改其他记录。`, async () => {
    const rows = await bills({query: marker}); for (const r of rows) ids.add(r.id);
    assert.equal(rows.length, 1); assert.equal(rows[0].amount, '36.80'); assert.equal(rows[0].version, 1);
    assert.ok((await web('bills/?limit=200')).items.some(r => r.id === rows[0].id));
  });
  let row = (await bills({query: marker}))[0];
  await turn('semantic-single-update', `刚才备注为“${marker}午饭”的账单金额说错了，改成35.50元，其他不变，直接修改。`, async () => {
    row = (await bills({id: row.id}))[0]; assert.equal(row.amount, '35.50'); assert.equal(row.version, 2);
  });
  const require = createRequire(import.meta.url);
  const {chromium} = require(process.env.PLAYWRIGHT_MODULE || join(homedir(), '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright'));
  browser = await chromium.launch({executablePath: '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox']});
  const page = await browser.newPage({viewport: {width: 1440, height: 1000}}), pageErrors = [];
  page.on('pageerror', e => pageErrors.push(e.message)); page.setDefaultTimeout(12000);
  await page.goto('http://127.0.0.1:3000/bills');
  await page.getByRole('button', {name: `编辑记录 ${marker}午饭`, exact: true}).filter({visible: true}).click();
  await page.getByLabel('金额', {exact: true}).fill('32.10');
  await page.getByRole('button', {name: '保存修改', exact: true}).click();
  await page.getByRole('dialog').waitFor({state: 'hidden'});
  row = (await bills({id: row.id}))[0]; assert.equal(row.amount, '32.10'); assert.equal(row.version, 3); assert.deepEqual(pageErrors, []);
  report.cases.push({label: 'actual-website-form-update', ok: true}); await browser.close(); browser = undefined;
  await turn('website-edit-visible-to-model', `查询备注“${marker}午饭”的实际账单，告诉我现在的金额。`, r => assert.match(JSON.stringify(r.captured), /32[.．]1/));
  await turn('new-before-delete', '/new');
  await turn('semantic-single-actual-delete', `把备注为“${marker}午饭”的那一笔账单直接删除，这是测试记录，不要改其他账单。`, async () => assert.equal((await bills({id: row.id})).length, 0));
  const day = new Intl.DateTimeFormat('en-CA', {timeZone: 'Asia/Shanghai'}).format(new Date());
  for (const amount of ['8.00', '9.00']) {
    const r = await web('bills/', 'POST', {expense_date: day, amount, note: marker + '同名奶茶'}); ids.add(r.id);
  }
  await turn('new-before-ambiguous', '/new');
  await turn('ambiguous-delete-clarifies', `把备注“${marker}同名奶茶”的那笔账单删掉。`, async () => {
    assert.equal((await bills({query: marker + '同名奶茶'})).length, 2);
  });
  await turn('weather-real-run-correlation', '查询广州当前天气和接下来几小时趋势，不改默认城市。', r => assert.match(JSON.stringify(r.captured), /广州/));
  const events = collectEvents({from: started, to: Date.now() + 1000, runtimeRoot: state, sources: ['openclaw-session', 'openclaw-runtime', 'knowledgemap']});
  const apiEvents = events.filter(e => e.source === 'knowledgemap');
  const hostRuns = new Set(events.filter(e => e.source !== 'knowledgemap').map(e => e.correlation?.runId).filter(Boolean));
  assert.ok(apiEvents.length > 8, 'missing API observations');
  for (const e of apiEvents) {
    assert.ok(hostRuns.has(e.correlation.runId), 'API runId must match actual host transcript');
    assert.ok(filterEvents(events, {runId: e.correlation.runId}).some(x => x.source === 'knowledgemap'), 'unified run-id query must find API event');
  }
  assert.ok(apiEvents.some(e => e.data?.path?.includes('/weather/')), 'weather bridge correlation not covered');
  const invalid = events.filter(e => e.source !== 'knowledgemap' && /Invalid arguments for tool/.test(JSON.stringify(e)) && /knowledge_bill/.test(JSON.stringify(e)));
  assert.equal(invalid.length, 0, 'bill calls must use declared schema on first attempt');
  report.correlation = {apiEvents: apiEvents.length, allRunIdsMatchRealHost: true, runIdQueryFindsBusinessEvents: true, weatherCovered: true, invalidBillArgumentAttempts: 0};
  report.ok = true;
} catch (error) {report.ok = false; report.error = String(error.message).slice(0, 300); process.exitCode = 1;}
finally {
  if (browser) await browser.close();
  if (ingressChanged) {
    try {await setIngress(false); report.testIngressRestored = true;}
    catch (error) {report.testIngressRestored = false; report.restoreError = String(error.message); report.ok = false; process.exitCode = 1;}
  }
  try {
    for (const r of await bills({query: marker})) ids.add(r.id);
    for (const id of ids) {
      const r = (await bills({id}))[0]; if (!r) continue;
      assert.ok(r.note?.startsWith(marker), 'refuses deleting unrelated row');
      await web(`bills/${id}?expected_version=${r.version}`, 'DELETE');
    }
    assert.equal((await bills({query: marker})).length, 0);
    if (originalBills) for (const before of originalBills) assert.deepEqual((await bills({id: before.id}))[0], before, 'original bill changed');
    report.cleanup = {testBillIds: [...ids], noTestRowsRemain: true, originalBillsUnchanged: Boolean(originalBills), receiptsKept: true};
  } catch (error) {report.cleanupError = String(error.message); report.ok = false; process.exitCode = 1;}
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n'); console.log(JSON.stringify(report));
}
