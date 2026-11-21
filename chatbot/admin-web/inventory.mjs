import fs from 'node:fs';
import {execFile} from 'node:child_process';
import {Socket} from 'node:net';
import {promisify} from 'node:util';
import path from 'node:path';
import {jsonFile, loadModule, optional, Problem, readFile} from './common.mjs';

const exec = promisify(execFile);

const groups = [
  ['陪伴与权限', [
    ['persona', '人格与关系', [25], [], 'persona'],
    ['memory', '记忆与会话连续性', [25, 29], ['kurumi-memory'], 'memory'],
    ['access', '身份、白名单与确认', [24, 6], ['kurumi-access-admin', 'personal-confirmation'], 'access'],
    ['wake', '主动唤醒 N3', [25], [], null],
  ]],
  ['个人助手', [
    ['daily', '天气、资料与行程', [2], ['personal-weather', 'personal-profile', 'personal-planning']],
    ['reminders', '一次性提醒', [3], ['personal-reminders'], 'tasks/reminders'],
    ['shared', '共享事项、账单与天气', [23], ['personal-reminder-list', 'kurumi-knowledgemap']],
    ['mail', '邮件与受管附件', [20], ['kurumi-mail'], 'tasks/mail'],
    ['papers', '论文阅读与翻译', [22], ['kurumi-research', 'kurumi-papers'], 'tasks/papers'],
    ['search', '网页检索与抓取', [8], ['tavily', 'kurumi-web-deepseek']],
    ['e7', '第七史诗数据', [27], ['kurumi-e7']],
    ['flights', '航班查询与提醒', [30], []],
    ['media', '媒体渠道接入', [31], []],
  ]],
  ['宿主与运维', [
    ['qq', 'QQ 与 SnowLuma', [32, 9], ['kurumi-qq'], 'system'],
    ['host', 'OpenClaw 宿主与调度', [1, 9, 21], ['kurumi-host-control', 'kurumi-tasks', 'deepseek'], 'tasks'],
    ['coding', '编码委托与原生 exec', [28], ['kurumi-coding'], 'tasks/coding'],
    ['logs', '跨模块链路日志', [18], ['kurumi-logs'], 'logs'],
    ['recovery', '备份、恢复与资产', [12], [], 'system'],
    ['console', 'Fusion 管理台', [33], [], 'overview'],
    ['acceptance', '通用场景验收', [36], [], null],
  ]],
];

const safeName = value => typeof value === 'string' && /^[\w.:-]{1,110}$/u.test(value) ? value : null;
const safeVersion = value => typeof value === 'string' && /^v?\d[\w.-]{1,60}$/u.test(value) ? value : null;
export const runningConfig = root => optional(() => jsonFile(root, 'openclaw.json', 4 * 1024 * 1024));

function indexDocs(root) {
  const files = optional(() => fs.readdirSync(path.join(root, 'docs'))) ?? [];
  const docs = [];
  for (const name of files.filter(name => /^[1-9]\d{0,3}_[^/]+\.md$/u.test(name))) {
    const file = optional(() => readFile(root, 'docs/' + name, 256 * 1024));
    if (!file) continue;
    const [first] = file.text.split(/\r?\n/u, 1);
    const title = /^# ([^\r\n]+)$/mu.exec(file.text)?.[1] ?? name.replace(/^\d+_|\.md$/gu, '');
    const [id] = name.split('_', 1);
    const [, status, scope] = /^状态：\s*(需求|开发中|已完成)(.*)$/u.exec(first) ?? [];
    docs.push({id: Number(id), title, status: status ?? '未标注', scope: scope?.trim() ?? '', file: name});
  }
  return docs.sort((a, b) => a.id - b.id);
}

export function document({sourceRoot, docsRoot}, id) {
  if (!/^[1-9]\d{0,3}$/u.test(id)) throw new Problem(404, '没有这份编号文档。');
  const doc = indexDocs(sourceRoot).find(row => String(row.id) === id)
    ?? indexDocs(docsRoot).find(row => String(row.id) === id);
  if (!doc) throw new Problem(404, '没有这份编号文档。');
  // Serve numbered repository docs as text; user artifacts and runtime files are outside this surface.
  const contents = optional(() => readFile(sourceRoot, 'docs/' + doc.file, 256 * 1024))
    ?? readFile(docsRoot, 'docs/' + doc.file, 256 * 1024);
  return {...doc, text: contents.text};
}

function pluginState(config, id) {
  if (!config) return 'unknown';
  const p = config.plugins;
  if (p?.enabled === false || (Array.isArray(p?.allow) && p.allow.length && !p.allow.includes(id))
      || p?.deny?.includes(id) || p?.entries?.[id]?.enabled === false) return 'off';
  return p?.entries?.[id]?.enabled === true ? 'on' : 'unconfigured';
}

export function inventory({sourceRoot, runtimeRoot, docsRoot}) {
  const source = optional(() => jsonFile(sourceRoot, 'config/runtime.config.json', 4 * 1024 * 1024));
  const runtime = runningConfig(runtimeRoot);
  const entries = config => Object.keys(config?.plugins?.entries ?? {});
  const denoted = new Set(groups.flatMap(([, rows]) => rows.flatMap(row => row[3])));
  const local = optional(() => fs.readdirSync(path.join(sourceRoot, 'chatbot/plugins'))) ?? [];
  const pluginIds = [...new Set([...entries(source), ...entries(runtime), ...denoted,
    ...local.filter(id => fs.existsSync(path.join(sourceRoot, 'chatbot/plugins', id, 'openclaw.plugin.json')))])].filter(safeName).sort();
  const plugins = pluginIds.map(id => ({
    id, source: pluginState(source, id), runtime: pluginState(runtime, id),
    origin: local.includes(id) ? 'Fusion' : '宿主或外部',
  }));
  const docs = [...new Map([...indexDocs(docsRoot), ...indexDocs(sourceRoot)].map(doc => [doc.id, doc])).values()]
    .sort((a, b) => a.id - b.id).map(({file, ...v}) => v);
  const tree = groups.map(([name, rows]) => ({
    name, rows: rows.map(([key, label, documents, ids, page]) => ({
      key, label, documents, plugins: ids, page,
      state: key === 'console' ? 'on' : key === 'wake'
        ? (runtime ? (runtime.plugins?.entries?.['kurumi-host-control']?.config?.proactive?.enabled === true ? 'on' : 'off') : 'unknown')
        : ids.length ? ids.some(id => pluginState(runtime, id) === 'on') ? 'on' : runtime ? 'off' : 'unknown'
        : ['flights', 'media'].includes(key) ? 'planned' : 'read',
    })),
  }));
  const extra = plugins.filter(p => !denoted.has(p.id));
  if (extra.length) tree.push({name: '其他插件', rows: extra.map(p => ({
    key: p.id, label: p.id, documents: [], plugins: [p.id], state: p.runtime,
  }))});
  const agents = Object.entries(runtime?.agents?.entries ?? {}).map(([id, cfg]) => ({
    id: safeName(id), role: id === 'main' ? '主人' : id.startsWith('qq-user-') ? '成员' : '后台',
    model: modelOf(cfg.model ?? runtime?.agents?.defaults?.model),
    allow: listTools(cfg.tools?.allow), alsoAllow: listTools(cfg.tools?.alsoAllow), deny: listTools(cfg.tools?.deny),
  })).filter(agent => agent.id !== null);
  const release = optional(() => jsonFile(sourceRoot, 'config/openclaw-release.json'));
  return {
    sourceAvailable: source !== null, runtimeAvailable: runtime !== null, plugins, tree, docs, agents,
    release: safeVersion(release?.version),
    model: modelOf(runtime?.agents?.defaults?.model ?? runtime?.agents?.entries?.main?.model),
    integrations: {
      qq: runtime ? runtime.channels?.['kurumi-qq']?.enabled === true : null,
      testIngress: runtime ? runtime.channels?.['kurumi-qq']?.testIngress === true : null,
      listSource: safeName(runtime?.plugins?.entries?.['personal-reminder-list']?.config?.dataSource),
      searchProvider: safeName(runtime?.tools?.web?.search?.provider),
      memory: runtime ? runtime.plugins?.entries?.['kurumi-memory']?.config?.continuity?.enabled === true : null,
      codeMode: typeof runtime?.tools?.codeMode === 'boolean' ? runtime.tools.codeMode : null,
    },
  };
}

const listTools = tools => Array.isArray(tools) ? tools.filter(safeName).slice(0, 150) : [];
function modelOf(value) {
  const label = typeof value === 'string' ? value : value?.primary;
  return typeof label === 'string' && /^[\w./:-]{1,110}$/u.test(label) ? label : null;
}

function portOf(value) {
  return Number.isInteger(value) && value >= 1 && value <= 65535 ? value : null;
}

function loopbackPort(value, protocol) {
  return optional(() => {
    const url = new URL(value);
    return url.protocol === protocol && url.hostname === '127.0.0.1' && !url.username && !url.password
      ? portOf(Number(url.port)) : null;
  });
}

const link = port => port ? 'http://127.0.0.1:' + port : null;

// Loopback observation only. No status command accepts parameters from the browser.
function probe(port) {
  if (!port) return Promise.resolve(null);
  return new Promise(resolve => {
    const socket = new Socket();
    const done = value => { socket.destroy(); resolve(value); };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
    socket.setTimeout(800, () => done(false));
    socket.connect(port, '127.0.0.1');
  });
}

async function unit(name, user) {
  try {
    const {stdout} = await exec('/usr/bin/systemctl', [
      ...(user ? ['--user'] : []), 'show', name + '.service', '--property=ActiveState,SubState,LoadState',
    ], {timeout: 1800, maxBuffer: 2048});
    const data = Object.fromEntries(stdout.trim().split('\n').map(line => line.split('=', 2)));
    return {active: safeName(data.ActiveState), sub: safeName(data.SubState), loaded: data.LoadState === 'loaded'};
  } catch {
    return {active: null, sub: null, loaded: null};
  }
}

async function qqStatus(sourceRoot, config, port) {
  if (!port || config?.channels?.['kurumi-qq']?.enabled !== true) return null;
  try {
    const {account, token} = await loadModule(sourceRoot, 'chatbot/packages/qq-delivery/config.js');
    const a = account(config);
    const response = await fetch('http://127.0.0.1:' + port + '/get_status', {
      method: 'POST', signal: AbortSignal.timeout(1600), redirect: 'error',
      headers: {'content-type': 'application/json', authorization: 'Bearer ' + token(a, 'http')}, body: '{}',
    });
    if (!response.ok) return null;
    const result = await response.json();
    if (result.status !== 'ok' || result.retcode !== 0 || typeof result.data?.online !== 'boolean') return null;
    return {online: result.data.online, good: result.data.good === true};
  } catch {
    return null;
  }
}

export async function serviceStatus({sourceRoot, runtimeRoot, port}) {
  const c = runningConfig(runtimeRoot);
  const qq = c?.channels?.['kurumi-qq'];
  const onebot = loopbackPort(qq?.httpUrl, 'http:');
  const km = loopbackPort(c?.plugins?.entries?.['kurumi-knowledgemap']?.config?.baseUrl
    ?? c?.plugins?.entries?.['personal-reminder-list']?.config?.bridgeBaseUrl, 'http:');
  const endpoints = [
    {id: 'fusion', name: 'Fusion / OpenClaw', detail: '会话、模型与插件宿主', port: portOf(c?.gateway?.port), unit: 'kurumi-fusion'},
    {id: 'snowluma', name: 'SnowLuma', detail: 'QQ 平台与 OneBot', port: 3082, unit: 'snowluma', url: link(3082)},
    {id: 'onebot', name: 'QQ 客户端', detail: 'OneBot HTTP / WS', port: onebot, wsPort: loopbackPort(qq?.wsUrl, 'ws:'), unit: 'snowluma-qq'},
    {id: 'dsh', name: 'DeepSeek Harness', detail: '独立网页与编码后端', port: 3080, unit: 'dsh-web', system: true, url: link(3080)},
    {id: 'km', name: 'KnowledgeMap', detail: '共享事项、账单与天气 API', port: km, unit: 'knowledgemap-assistant'},
    {id: 'web', name: 'Fusion 管理台', detail: '本机管理入口', port, unit: 'kurumi-admin-web', url: link(port)},
  ];
  const [services, qqClient] = await Promise.all([Promise.all(endpoints.map(async service => {
    const [systemd, reachable] = await Promise.all([unit(service.unit, !service.system), probe(service.port)]);
    return {...service, systemd, reachable};
  })), qqStatus(sourceRoot, c, onebot)]);
  return {at: new Date().toISOString(), qq: qqClient, services};
}
