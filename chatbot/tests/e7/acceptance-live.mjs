// Explicit --live public HTTP acceptance; --community-only selects phase 2A; optional --model uses the configured official model.
// Temporary public cache and new --out evidence only. No QQ delivery or production state writes.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {fileURLToPath} from 'node:url';
import {E7Client, USER_AGENT} from '../../plugins/kurumi-e7/client.js';
import {E7Service} from '../../plugins/kurumi-e7/service.js';
import {digest} from '../../plugins/kurumi-e7/store.js';
import {HERO_VIEWS, RESULT_BYTES, CATALOGS} from '../../plugins/kurumi-e7/policy.js';
import {dataCount} from '../../plugins/kurumi-e7/query.js';
import {createE7Plugin, E7_TOOL} from '../../plugins/kurumi-e7/index.js';
import {ownerPolicy, context} from '../access-control/fixtures.mjs';
import {modelCases as cases} from './model-cases.mjs';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--live') || !process.argv.includes('--out') || !path.isAbsolute(out ?? '') || fs.existsSync(out)) throw Error('Require --live and a new absolute --out');
const communityOnly = process.argv.includes('--community-only');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const runtimeEnv = JSON.parse(fs.readFileSync('/home/afrangry/.openclaw-fusion/runtime-env.json'));
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy'])
  if (typeof runtimeEnv[name] === 'string') process.env[name] = runtimeEnv[name];
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-e7-live-'));
const report = {at: new Date().toISOString(), boundary: 'Real public E7 HTTP, temporary public-data cache. Optional configured official model and actual v2 tool handlers with synthetic trusted owner context. No QQ send or production write; not full model/Gateway/QQ inbound.', userAgent: USER_AGENT, requests: [], queries: [], modelCases: []};
const client = new E7Client({observe: row => report.requests.push({...row, at: new Date().toISOString()})});
const read = client.read.bind(client);
client.read = async (...args) => {
  const response = await read(...args);
  Object.assign(report.requests.at(-1), {parameters: args[1] ?? {}, dataSha256: response.data === undefined ? null : digest(response.data),
    conditional: Boolean(args[2]?.validators?.etag || args[2]?.validators?.lastModified)});
  return response;
};
const service = new E7Service({cacheRoot: root, refreshEnabled: false}, {client});
function brief(result) {
  const d = result.data;
  return {status: result.status, action: result.action, source: result.source, stale: result.stale, missingFields: result.missingFields, sources: result.sources,
    bytes: Buffer.byteLength(JSON.stringify(result)), sha256: digest(result),
    ...(d?.items ? {total: d.total ?? null, items: d.items.map(r => ({id: r.id ?? r.heroCode ?? r.artifactId ?? r.entryId ?? null, name: r.name ?? r.title ?? null, server: r.server ?? null})), hasNext: Boolean(d.nextCursor)} : {}),
    ...(d?.heroCode ? {heroCode: d.heroCode, name: d.name, view: d.view, skillNames: d.skills?.map(s => s.name), stats: d.stats,
      statBasis: d.statBasis, exclusiveEquipment: d.exclusiveEquipment, storyCharacters: d.story?.length} : {}),
  };
}
async function query(label, args) {
  const result = await service.query(args);
  report.queries.push({label, args: {...args, ...(args.cursor ? {cursor: '[previous nextCursor]'} : {})}, result: brief(result)});
  assert.equal(result.status, 'ok'); assert.equal(result.stale, false);
  assert(Buffer.byteLength(JSON.stringify(result)) <= RESULT_BYTES);
  assert(result.sources.every(s => /^https:\/\/(admin|assets2)\.e7\.wiki\//.test(s.url)));
  assert.equal(result.externalContent.untrusted, true);
  return result;
}
async function modelAcceptance() {
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, 'config/runtime.config.json')));
  const primary = cfg.agents.entries.main.model?.primary ?? cfg.agents.defaults.model.primary;
  const [providerId, model] = primary.split('/'), provider = cfg.models.providers[providerId];
  const key = runtimeEnv[provider.apiKey?.id];
  assert.equal(new URL(provider.baseUrl).hostname, 'api.deepseek.com'); assert(key);
  report.model = primary;
  const policy = ownerPolicy(), config = {channels: {'kurumi-qq': {ownerId: policy.subjects[0].qq, accessControl: policy}}};
  const ctx = context(policy.subjects[0]); ctx.getRuntimeConfig = () => config;
  let factory;
  createE7Plugin({serviceFactory: () => service}).register({config, pluginConfig: {}, registerService() {}, registerTool: f => {factory = f;}});
  const tool = factory.create(ctx);
  const system = fs.readFileSync(path.join(repo, 'scripts/fusion/templates/AGENTS.md'), 'utf8') +
    '\n本轮为隔离验收，仅提供e7_data。按工具真实结果回答，查名称先search再用真实ID。需要专属装备、可用性或公告正文但来源缺失时说明边界。当前时间：' + new Date().toISOString();
  const definition = {type: 'function', function: {name: E7_TOOL.name, description: E7_TOOL.description, parameters: E7_TOOL.parameters}};

  const selection = process.argv.includes('--cases') ? process.argv[process.argv.indexOf('--cases') + 1]?.split(',')
    : cases.filter(c => communityOnly ? /^(?:builds|reviews)-/.test(c[0]) : !/^(?:builds|reviews)-/.test(c[0])).map(c => c[0]);
  assert(selection?.length && selection.every(label => cases.some(c => c[0] === label)), 'Unknown --cases selection');
  report.modelCaseSelection = selection;
  for (const [label, input, verify] of cases.filter(c => selection.includes(c[0]))) {
    const row = {label, input, calls: [], requests: 0}; report.modelCases.push(row);
    const messages = [{role: 'system', content: system}, {role: 'user', content: input}];
    for (let step = 0; step < 5; step++) {
      row.requests++;
      const response = await fetch(provider.baseUrl.replace(/\/$/, '') + '/chat/completions', {
        method: 'POST', headers: {'Content-Type': 'application/json', Authorization: 'Bearer ' + key}, signal: AbortSignal.timeout(60000),
        body: JSON.stringify({model, messages, tools: [definition], max_tokens: 1600, temperature: 0}),
      });
      if (!response.ok) throw Error('Model HTTP ' + response.status);
      const body = await response.json(), answer = body.choices?.[0]?.message;
      assert(answer); messages.push(answer);
      if (!answer.tool_calls?.length) {row.reply = answer.content ?? ''; verify(row); assert.match(row.reply, /E7|WIKI|wiki/u); row.passed = true; break;}
      for (const call of answer.tool_calls) {
        assert.equal(call.function.name, E7_TOOL.name);
        const args = JSON.parse(call.function.arguments), result = await tool.execute(call.id, args);
        const value = result.content[0].text;
        row.calls.push({name: call.function.name, args, resultBytes: Buffer.byteLength(value), resultSha256: digest(value), untrustedBoundary: value.includes('EXTERNAL_UNTRUSTED_CONTENT')});
        assert(value.includes('EXTERNAL_UNTRUSTED_CONTENT'));
        messages.push({role: 'tool', tool_call_id: call.id, content: value});
      }
    }
    assert(row.passed, 'Exceeded bounded tool rounds');
    if (communityOnly) {row.replyCharacters = row.reply.length; row.replySha256 = digest(row.reply); delete row.reply;}
    console.log(JSON.stringify({modelCase: label, passed: true, calls: row.calls.length}));
  }
}
async function communityAcceptance() {
  report.phase = '2A';
  const found = await query('build-hero-search', {action: 'search', kind: 'hero', query: '梅铃'});
  assert.equal(found.data.items[0].heroCode, 'mei-lin');
  const first = await query('builds-page1', {action: 'builds', heroCode: 'mei-lin', limit: 3});
  assert(first.data.total > 3); assert(first.data.items.every(r => r.statBasis.equipmentIncluded && r.statBasis.percentUnit === 'percentage_points'));
  assert.equal(first.data.items[0].stats.chd, 289); assert.equal(first.data.items[0].statBasis.level, null);
  report.buildSample = {id: first.data.items[0].id, stats: first.data.items[0].stats, statBasis: first.data.items[0].statBasis, updatedAt: first.data.items[0].updatedAt};
  const second = await query('builds-page2', {action: 'builds', heroCode: 'mei-lin', limit: 3, cursor: first.data.nextCursor});
  assert(!second.data.items.some(r => first.data.items.some(p => p.id === r.id)));
  const filtered = await query('builds-filtered', {action: 'builds', heroCode: 'mei-lin', filters: {sets: ['开战', '穿透'], minStats: {chd: 250, spd: 218}}, limit: 3});
  assert(filtered.data.total > 0); assert(filtered.data.items.every(r => r.sets.includes('开战') && r.sets.includes('穿透') && r.stats.chd >= 250 && r.stats.spd >= 218));
  const reviewed = await query('review-hero-search', {action: 'search', kind: 'hero', query: '小春'});
  assert.equal(reviewed.data.items[0].heroCode, 'haru');
  const reviews = await query('reviews-all', {action: 'reviews', heroCode: 'haru'});
  assert(reviews.data.total >= 4); assert(reviews.data.items.every(r => r.author && r.updatedAt));
  const rta = await query('reviews-rta', {action: 'reviews', heroCode: 'haru', category: 'RTA'});
  assert(rta.data.items.length); assert(rta.data.items.every(r => r.category === 'RTA'));
  const empty = await query('reviews-empty', {action: 'reviews', heroCode: 'mei-lin'});
  assert.equal(empty.data.total, 0); assert.equal(empty.data.nextCursor, null);
  const before = report.requests.length;
  await service.query({action: 'builds', heroCode: 'mei-lin'}); await service.query({action: 'reviews', heroCode: 'haru'});
  assert.equal(report.requests.length, before); report.cacheReuseWithoutHttp = true;
}
try {
  if (communityOnly) await communityAcceptance();
  else {
  const found = await query('traditional-name-search', {action: 'search', kind: 'hero', query: '梅鈴'});
  assert.equal(found.data.items.length, 1); assert.equal(found.data.items[0].heroCode, 'mei-lin');
  for (const view of HERO_VIEWS) {
    const r = await query('hero-' + view, {action: 'hero', heroCode: 'mei-lin', view});
    if (view === 'stats') {assert.equal(r.data.stats.atk, 1208); assert.equal(r.data.statBasis.equipmentIncluded, false);}
    if (view === 'exclusive') {assert.equal(r.data.exclusiveEquipment, null); assert(r.missingFields.includes('exclusiveEquipment'));}
  }
  const artifact = await query('artifact-search', {action: 'search', kind: 'artifact', query: '火龙宝石'});
  assert.equal(artifact.data.items.length, 1);
  const effect = await query('artifact-effect', {action: 'artifact', artifactId: artifact.data.items[0].artifactId});
  assert(effect.data.effect.length > 20); assert(!effect.data.effect.includes('ps_refer'));
  const dict = await query('effect-dictionary', {action: 'dictionary', kind: 'effect', query: '灭亡'});
  assert(dict.data.items.length); assert.match(dict.data.items[0].description, /复活/u);
  await query('effect-filter', {action: 'search', kind: 'hero', filters: {effectIds: [dict.data.items[0].entryId]}, limit: 3});
  const item = await query('item-dictionary', {action: 'dictionary', kind: 'item', query: '天空石'}); assert(item.data.items.length);
  const codes = await query('codes', {action: 'codes', server: '国际服', limit: 3}); assert.equal(codes.data.redemptionVerified, false);
  await query('wiki-updates', {action: 'news', kind: 'wiki_update', limit: 2});
  await query('game-news-national', {action: 'news', kind: 'game', server: '国服', limit: 10});
  const news = await query('game-news-page1', {action: 'news', kind: 'game', server: '国际服', limit: 10});
  assert(news.data.items.every(r => r.server === '国际服' && r.bodyExtracted === false)); assert(news.data.nextCursor);
  const page2 = await query('game-news-page2', {action: 'news', kind: 'game', server: '国际服', limit: 10, cursor: news.data.nextCursor});
  assert(!page2.data.items.some(r => news.data.items.some(p => p.id === r.id)));
  const before = report.requests.length; await service.query({action: 'hero', heroCode: 'mei-lin'});
  assert.equal(report.requests.length, before); report.cacheReuseWithoutHttp = true;
  const first = await service.resource('hero', {heroCode: 'mei-lin'});
  const refreshed = await service.resource('hero', {heroCode: 'mei-lin'}, {force: true});
  assert.equal(refreshed.stale, false); assert.equal(refreshed.hash, first.hash); assert.equal(refreshed.fetchedAt, first.fetchedAt);
  assert(report.requests.at(-1).conditional); report.conditionalStatus = report.requests.at(-1).status;
  report.refresh = await service.refresh(); assert.equal(report.refresh.length, CATALOGS.length); assert(report.refresh.every(r => !r.stale && !r.warning));
  report.catalogs = [];
  for (const kind of CATALOGS) {const r = await service.resource(kind); report.catalogs.push({kind, count: dataCount(kind, r.data), sha256: r.hash});}
  }
  if (process.argv.includes('--model')) await modelAcceptance();
  report.passed = true;
} catch (error) {report.passed = false; report.error = {name: error.name, code: error.code, message: error.message}; process.exitCode = 1;}
finally {
  await service.stop(); fs.rmSync(root, {recursive: true, force: true});
  report.finishedAt = new Date().toISOString();
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({passed: report.passed, queries: report.queries.length, httpRequests: report.requests.length, modelCases: report.modelCases.filter(c => c.passed).length, error: report.error}));
}
