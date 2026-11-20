#!/usr/bin/node
// kurumi-stack：本机整套服务的统一入口。
// 对应文档：docs/9_QQ融合助手架构与开发计划.md「统一启停（kurumi-stack）」；清单：config/stack.json。
//
// 边界（重要）：
//   - start 只做“收敛”，不是 restart-all。健康组件只检查不重启；只有单元已退出/失败才拉起；
//     运行中但探针异常只报告，默认不重启（--repair 才允许重启运行中的异常组件）。
//   - stop 默认只停 UI/会话层（管理台、Fusion、DSH），保留 QQ/SnowLuma/KnowledgeMap 让消息排队；
//     --all 才停整套（MySQL 属外部依赖，永远不碰）。
//   - 不直接 kill 进程；只通过 systemd 单元操作。端口被未知进程占用时拒绝启动，避免双实例。
//   - 需要 sudo 的操作在无终端时不会尝试，转为“待授权步骤”输出，不会卡住。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';

const NODE_BIN = fs.existsSync('/usr/bin/node') ? '/usr/bin/node' : process.execPath;
const HOME = os.homedir();
export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const MANIFEST_PATH = path.join(REPO, 'config/stack.json');
const BIN_DIR = path.join(HOME, '.local/bin');
const BIN_PATH = path.join(BIN_DIR, 'kurumi-stack');
const GUI_PATH = path.join(BIN_DIR, 'kurumi-stack-gui');
const DESKTOP_DIR = path.join(HOME, '桌面');
const DESKTOP_PATH = path.join(DESKTOP_DIR, 'kurumi-stack.desktop');
const APPS_PATH = path.join(HOME, '.local/share/applications/kurumi-stack.desktop');
const DSH_DEPLOY = '/opt/deepseek-harness';
const KM_DESKTOP_COPY = path.join(HOME, '桌面/KnowledgeMap');
const LAUNCHER_NAMES = ['Start-DSH.sh', 'Stop-DSH.sh'];

const tty = Boolean(process.stdout.isTTY);
const color = (code, text) => (tty ? `\u001b[${code}m${text}\u001b[0m` : text);
const okText = text => color('32', text);
const badText = text => color('31', text);
const warnText = text => color('33', text);
const dimText = text => color('90', text);

// ---------------------------------------------------------------- utilities

function run(command, args, {timeout = 15000, stdio = 'pipe', env} = {}) {
  return spawnSync(command, args, {encoding: 'utf8', timeout, stdio, env});
}

function runOk(command, args, options) {
  const result = run(command, args, options);
  return result.status === 0;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function displayWidth(text) {
  let width = 0;
  for (const char of String(text)) {
    width += /[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60\uffe0-\uffe6]/u.test(char) ? 2 : 1;
  }
  return width;
}

function pad(text, width) {
  return String(text) + ' '.repeat(Math.max(0, width - displayWidth(text)));
}

// ---------------------------------------------------------------- manifest

export function loadManifest(file = MANIFEST_PATH) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

export function validateManifest(manifest) {
  const issues = [];
  if (!manifest || typeof manifest !== 'object') return ['清单不是对象'];
  if (!Array.isArray(manifest.components) || manifest.components.length === 0) issues.push('components 为空');
  const ids = new Set();
  const units = new Set();
  const ports = new Map();
  const orders = new Map();
  for (const component of manifest.components ?? []) {
    if (!component.id || typeof component.id !== 'string') issues.push('组件缺少 id');
    else if (ids.has(component.id)) issues.push(`组件 id 重复：${component.id}`);
    else ids.add(component.id);
    if (!['system', 'user'].includes(component.kind)) issues.push(`${component.id}: kind 必须是 system 或 user`);
    if (!component.unit || typeof component.unit !== 'string') issues.push(`${component.id}: 缺少 unit`);
    else if (units.has(component.unit)) issues.push(`unit 重复：${component.unit}`);
    else units.add(component.unit);
    if (!Number.isInteger(component.order)) issues.push(`${component.id}: order 必须是整数`);
    else if (orders.has(component.order)) issues.push(`order 重复：${component.order}`);
    else orders.set(component.order, component.id);
    for (const port of component.ports ?? []) {
      if (!Number.isInteger(port) || port < 1 || port > 65535) issues.push(`${component.id}: 端口非法 ${port}`);
      if (ports.has(port)) issues.push(`端口 ${port} 同时属于 ${ports.get(port)} 和 ${component.id}`);
      else ports.set(port, component.id);
    }
    for (const probe of component.probes ?? []) {
      if (probe.type === 'http' && !/^http:\/\/127\.0\.0\.1:\d+\//.test(probe.url ?? '')) {
        issues.push(`${component.id}: HTTP 探针必须是本机回环地址`);
      }
      if (probe.type === 'tcp' && !Number.isInteger(probe.port)) issues.push(`${component.id}: TCP 探针缺少端口`);
      if (!['http', 'tcp'].includes(probe.type)) issues.push(`${component.id}: 未知探针类型 ${probe.type}`);
    }
    if (component.launcher) {
      for (const key of ['root', 'start', 'stop', 'stateFile']) {
        if (typeof component.launcher[key] !== 'string') issues.push(`${component.id}: launcher.${key} 缺失`);
      }
    }
  }
  for (const id of manifest.defaultStop ?? []) {
    if (!ids.has(id)) issues.push(`defaultStop 引用了不存在的组件：${id}`);
  }
  return issues;
}

function componentMap(manifest) {
  return new Map(manifest.components.map(component => [component.id, component]));
}

function orderedComponents(manifest, ids) {
  const map = componentMap(manifest);
  return ids.map(id => map.get(id)).filter(Boolean).sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------- probing

export function parseSsPorts(stdout) {
  const ports = new Set();
  for (const line of String(stdout ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const local = fields[3];
    const match = /:(\d+)$/.exec(local);
    if (match) ports.add(Number(match[1]));
  }
  return ports;
}

export function parseSsOwners(stdout) {
  const owners = new Map();
  for (const line of String(stdout ?? '').split('\n')) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4) continue;
    const port = Number(/:(\d+)$/.exec(fields[3])?.[1]);
    if (!port) continue;
    const match = /users:\(\("([^"]+)",pid=(\d+)/.exec(line);
    owners.set(port, match ? `${match[1]}(pid=${match[2]})` : '未知进程');
  }
  return owners;
}

function listeningPorts() {
  const result = run('ss', ['-H', '-ltn']);
  return parseSsPorts(result.stdout);
}

function listeningOwners() {
  const result = run('ss', ['-H', '-ltnp']);
  return parseSsOwners(result.stdout);
}

function tcpProbe(port, timeout = 1200) {
  return new Promise(resolve => {
    const socket = net.connect({host: '127.0.0.1', port});
    const finish = value => {
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeout);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

async function httpProbe(probe, timeout = 1500) {
  try {
    const response = await fetch(probe.url, {redirect: 'manual', signal: AbortSignal.timeout(timeout)});
    const expected = probe.expect?.length ? probe.expect : null;
    return {ok: !expected || expected.includes(response.status), status: response.status};
  } catch {
    return {ok: false, status: 0};
  }
}

export async function probeComponent(component, ports) {
  const probes = await Promise.all((component.probes ?? []).map(probe => {
    if (probe.type === 'tcp') return tcpProbe(probe.port);
    return httpProbe(probe);
  }));
  const probeOk = probes.every(result => (typeof result === 'boolean' ? result : result.ok));
  const portsOk = (component.ports ?? []).every(port => ports.has(port));
  return {probeOk, portsOk};
}

function showUnit(component) {
  const base = component.kind === 'system' ? [] : ['--user'];
  const result = run('systemctl', [...base, 'show', component.unit, '-p', 'ActiveState', '-p', 'SubState', '-p', 'UnitFileState', '-p', 'Result', '-p', 'ActiveEnterTimestamp']);
  const text = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (/could not be found|not found|not loaded/i.test(text)) {
    return {exists: false, activeState: 'not-found', subState: '', unitFileState: 'not-found', result: '', activeEnter: ''};
  }
  const values = {};
  for (const line of String(result.stdout ?? '').split('\n')) {
    const index = line.indexOf('=');
    if (index > 0) values[line.slice(0, index)] = line.slice(index + 1).trim();
  }
  if (!values.ActiveState) return {exists: false, activeState: 'not-found', subState: '', unitFileState: 'not-found', result: '', activeEnter: ''};
  return {
    exists: true,
    activeState: values.ActiveState,
    subState: values.SubState ?? '',
    unitFileState: values.UnitFileState ?? 'unknown',
    result: values.Result ?? '',
    activeEnter: values.ActiveEnterTimestamp ?? '',
  };
}

function hasDisplay() {
  return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY || fs.existsSync('/tmp/.X11-unix/X0'));
}

export async function gatherStates(manifest, {health = null} = {}) {
  const ports = listeningPorts();
  const states = [];
  for (const component of orderedComponents(manifest, manifest.components.map(item => item.id))) {
    const unit = showUnit(component);
    const {probeOk, portsOk} = await probeComponent(component, ports);
    const active = unit.activeState === 'active';
    const ok = active && probeOk && portsOk;
    const state = {component, unit, active, probeOk, portsOk, ok, semanticOk: true};
    if (component.semantic === 'qq' && health) {
      state.semanticOk = health.qq?.online === true && health.qq?.good === true;
      state.ok = state.ok && state.semanticOk;
    }
    states.push(state);
  }
  return states;
}

function stateFor(states, id) {
  return states.find(state => state.component.id === id);
}

// ---------------------------------------------------------------- decision (pure)

export function decideAction(component, state, {repair = false} = {}) {
  if (component.external) return {kind: state.ok || state.probeOk ? 'external-ok' : 'external-down'};
  if (!state.unit.exists) return {kind: 'missing-unit'};
  if (state.active) {
    if (state.ok) return {kind: 'ok'};
    return {kind: repair ? 'repair' : 'degraded'};
  }
  switch (state.unit.activeState) {
    case 'activating':
      return {kind: 'wait'};
    case 'deactivating':
      return {kind: 'wait-then-start'};
    case 'failed':
      return {kind: 'reset-start'};
    case 'inactive':
      return {kind: 'start'};
    default:
      return {kind: 'start'};
  }
}

export function precheckStart(component, action, {ports, display, sudoReady}) {
  const starting = ['start', 'reset-start', 'wait-then-start'].includes(action.kind);
  if (!starting && action.kind !== 'repair') return null;
  if (component.needsDisplay && !display) return 'no-display';
  if (component.kind === 'system' && sudoReady === false) return 'sudo-required';
  if (starting && (component.ports ?? []).some(port => ports.has(port))) return 'port-conflict';
  return null;
}

export function planStart(manifest, states, {repair = false, only = null} = {}) {
  const selected = only ? new Set(only) : null;
  return states
    .filter(state => !selected || selected.has(state.component.id))
    .map(state => ({component: state.component, state, action: decideAction(state.component, state, {repair})}))
    .sort((a, b) => a.component.order - b.component.order);
}

export function stopTargets(manifest, {all = false} = {}) {
  const components = componentMap(manifest);
  const ids = all
    ? manifest.components.filter(component => !component.external).map(component => component.id)
    : manifest.defaultStop ?? [];
  return ids
    .map(id => components.get(id))
    .filter(component => component && !component.external)
    .sort((a, b) => b.order - a.order);
}

// ---------------------------------------------------------------- process helpers

let sudoState = null;
function ensureSudo() {
  if (sudoState !== null) return sudoState;
  if (runOk('sudo', ['-n', 'true'])) {
    sudoState = true;
    return true;
  }
  if (!process.stdin.isTTY) {
    sudoState = false;
    return false;
  }
  console.error(dimText('需要 sudo 权限完成系统级操作，请输入密码：'));
  sudoState = runOk('sudo', ['-v'], {stdio: 'inherit'});
  return sudoState;
}

function systemctl(component, args, timeout = 30000) {
  const base = component.kind === 'system' ? [] : ['--user'];
  return run('systemctl', [...base, ...args, component.unit], {timeout});
}

function systemctlResult(component, verb) {
  const result = systemctl(component, [verb]);
      if (result.status !== 0) {
    return {ok: false, message: (result.stderr || result.stdout || '').trim()};
  }
  return {ok: true, message: ''};
}

async function waitReady(component, {timeoutSec = 45} = {}) {
  const deadline = Date.now() + timeoutSec * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const units = showUnit(component);
    last = units;
    if (units.activeState === 'failed') return {ok: false, failed: true, state: last};
    if (units.activeState === 'active') {
      const ports = listeningPorts();
      const {probeOk, portsOk} = await probeComponent(component, ports);
      if (probeOk && portsOk) return {ok: true, state: last};
      if ((component.probes ?? []).length === 0) return {ok: true, state: last};
    }
    await sleep(700);
  }
  return {ok: false, failed: last?.activeState === 'failed', state: last};
}

async function waitUntilInactive(component, timeoutSec = 20) {
  const deadline = Date.now() + timeoutSec * 1000;
  while (Date.now() < deadline) {
    const unit = showUnit(component);
    if (unit.activeState === 'inactive' || unit.activeState === 'failed' || !unit.exists) return true;
    await sleep(500);
  }
  return false;
}

function runLauncher(component, action) {
  const launcher = component.launcher;
  if (!launcher) return {ok: false, message: '缺少启动器配置'};
  const script = action === 'start' ? launcher.start : launcher.stop;
  const args = action === 'start' ? ['--hide-key'] : [];
  const result = run('bash', [script, ...args], {timeout: 300000});
  return {ok: result.status === 0, message: (result.stderr || result.stdout || '').trim()};
}

function launcherState(component) {
  try {
    return JSON.parse(fs.readFileSync(component.launcher.stateFile, 'utf8'));
  } catch {
    return null;
  }
}

function kmCanUseUnit(component) {
  const state = launcherState(component);
  if (!state || state.root !== component.launcher.root) return false;
  if (!fs.existsSync(component.launcher.unitFile)) return false;
  try {
    return fs.existsSync(path.join(state.dist, 'index.html'));
  } catch {
    return false;
  }
}

async function startComponent(component) {
  if (component.id === 'km-web' && component.launcher && !kmCanUseUnit(component)) {
    return runLauncher(component, 'start');
  }
  if (component.unit.endsWith('.service')) {
    const result = systemctlResult(component, 'start');
    if (!result.ok && component.launcher && /not found|could not be found/i.test(result.message)) {
      return runLauncher(component, 'start');
    }
    return result;
  }
  return {ok: false, message: `不支持的单元 ${component.unit}`};
}

// ---------------------------------------------------------------- health

function runHealth() {
  const result = run(NODE_BIN, [path.join(REPO, 'scripts/fusion/health.mjs')], {timeout: 120000});
  try {
    const data = JSON.parse(result.stdout || '');
    return {available: true, ok: data.ok === true, data, raw: result.stdout};
  } catch {
    return {available: false, ok: false, data: null, raw: (result.stderr || result.stdout || '').trim()};
  }
}

function dshAuthUrl() {
  const result = run('journalctl', ['-u', 'dsh-web.service', '-n', '200', '--no-pager', '-o', 'cat'], {timeout: 10000});
  const matches = String(result.stdout ?? '').split('\n')
    .map(line => line.startsWith('dsh web: ') ? line.slice('dsh web: '.length).trim() : '')
    .filter(Boolean);
  return matches.at(-1) ?? '';
}

function trustedHost() {
  const result = run('systemctl', ['show', 'dsh-web.service', '-p', 'ExecStart', '--value']);
  return /--trusted-host\s+([^\s;]+)/.exec(result.stdout ?? '')?.[1] ?? '';
}

function printUrls() {
  if (!tty) return;
  const auth = dshAuthUrl();
  if (auth.startsWith('http://127.0.0.1:3080/')) {
    console.log(`  DSH 本地入口：${auth}`);
    const host = trustedHost();
    if (/^[A-Za-z0-9.-]+\.ts\.net$/.test(host)) console.log(`  DSH Tailscale 入口：https://${host}${auth.slice('http://127.0.0.1:3080'.length)}`);
  }
  const km = componentMap(loadManifest()).get('km-web');
  const state = km ? launcherState(km) : null;
  if (state?.access_key && state?.tailnet_authority) {
    console.log(`  KnowledgeMap Tailscale 入口：https://${state.tailnet_authority}/_km/login#key=${state.access_key}`);
  }
  if (state?.access_key) console.log(`  KnowledgeMap 本机入口：http://127.0.0.1:8020/_km/login#key=${state.access_key}`);
  console.log('  SnowLuma WebUI：http://127.0.0.1:3082/');
  console.log('  Fusion 管理台：http://127.0.0.1:3085/（登录口令：cat ~/.local/state/kurumi-admin-web/access-key）');
}

// ---------------------------------------------------------------- commands

async function cmdStart(argv) {
  const options = parseOptions(argv);
  const manifest = loadManifest();
  const issues = validateManifest(manifest);
  if (issues.length) {
    for (const issue of issues) console.error(badText(`✗ 清单错误：${issue}`));
    return 2;
  }
  const healthBefore = runHealth();
  const states = await gatherStates(manifest, {health: healthBefore.available ? healthBefore.data : null});
  const plan = planStart(manifest, states, {repair: options.repair, only: options.only});
  const ports = listeningPorts();
  const owners = listeningOwners();
  const display = hasDisplay();
  const sudoReady = ensureSudoIfNeeded(plan);

  if (options.dryRun) {
    for (const item of plan) {
      const reason = precheckStart(item.component, item.action, {ports, display, sudoReady});
      const label = reason ? warnText(`[${reason}]`) : '';
      console.log(`${pad(item.component.id, 12)} ${item.action.kind}${label ? ' ' + label : ''}`);
    }
    return 0;
  }

  const results = [];
  for (const item of plan) {
    const {component, action} = item;
    const blocked = precheckStart(component, action, {ports, display, sudoReady});
    if (blocked) {
      const messages = {
        'no-display': '需要图形会话（:0），未尝试启动',
        'sudo-required': '需要 sudo 权限；请在终端运行 kurumi-stack start',
        'port-conflict': `端口 ${(component.ports ?? []).filter(port => ports.has(port)).join(',')} 已被 ${(component.ports ?? []).map(port => owners.get(port)).filter(Boolean).join('、') || '未知进程'} 占用，未启动`,
      };
      console.log(warnText(`! ${component.label}：${messages[blocked]}`));
      results.push({id: component.id, level: blocked === 'no-display' ? 'skip' : 'fail', message: messages[blocked]});
      continue;
    }
    switch (action.kind) {
      case 'ok':
      case 'external-ok':
        console.log(`${okText('✓')} ${component.label}：运行中，健康（仅检查，未重启）`);
        results.push({id: component.id, level: 'ok'});
        break;
      case 'external-down':
        console.log(badText(`✗ ${component.label}：外部服务未运行（本工具不启停它）`));
        results.push({id: component.id, level: 'fail', message: '外部依赖未运行'});
        break;
      case 'degraded': {
        const wait = (component.graceSec ?? 10) * 1000;
        const deadline = Date.now() + wait;
        let healthy = false;
        while (Date.now() < deadline) {
          const current = await gatherStates(manifest);
          const now = stateFor(current, component.id);
          if (now?.ok) {
            healthy = true;
            break;
          }
          await sleep(800);
        }
        if (healthy) {
          console.log(`${okText('✓')} ${component.label}：运行中，已恢复健康（未重启）`);
          results.push({id: component.id, level: 'ok'});
        } else {
          console.log(warnText(`! ${component.label}：运行中但探针异常，未自动重启；可用 kurumi-stack restart ${component.id} 或 start --repair`));
          results.push({id: component.id, level: 'degraded', message: '运行中但探针异常'});
        }
        break;
      }
      case 'wait': {
        const ready = await waitReady(component, {timeoutSec: component.startTimeoutSec});
        if (!ready.ok) {
          console.log(badText(`✗ ${component.label}：启动中但未在期限内就绪（${ready.state?.activeState ?? 'unknown'}）`));
          results.push({id: component.id, level: 'fail', message: '启动超时'});
        } else {
          console.log(`${okText('↑')} ${component.label}：等待后已就绪`);
          results.push({id: component.id, level: 'started'});
        }
        break;
      }
      case 'wait-then-start':
        await waitUntilInactive(component, 20);
        // fall through
      case 'reset-start':
        if (action.kind === 'reset-start') systemctl(component, ['reset-failed']);
        // fall through
      case 'start':
      case 'repair': {
        if (action.kind === 'repair') systemctl(component, ['restart']);
        const started = action.kind === 'repair' ? {ok: true} : await startComponent(component);
        if (!started.ok) {
          console.log(badText(`✗ ${component.label}：启动失败 ${started.message ? dimText(`(${started.message.split('\n')[0]})`) : ''}`));
          results.push({id: component.id, level: 'fail', message: started.message || '启动失败'});
          break;
        }
        const ready = await waitReady(component, {timeoutSec: component.startTimeoutSec});
        if (!ready.ok) {
          console.log(warnText(`! ${component.label}：已启动但未在期限内探针就绪（${ready.state?.activeState ?? 'unknown'}）`));
          results.push({id: component.id, level: 'degraded', message: '已启动但探针未就绪'});
        } else {
          console.log(`${okText('↑')} ${component.label}：${action.kind === 'repair' ? '已重启' : '已拉起'}并就绪`);
          results.push({id: component.id, level: 'started'});
        }
        break;
      }
      case 'missing-unit':
        console.log(badText(`✗ ${component.label}：单元 ${component.unit} 不存在`));
        results.push({id: component.id, level: 'fail', message: '单元不存在'});
        break;
      default:
        console.log(warnText(`! ${component.label}：未知动作 ${action.kind}`));
        results.push({id: component.id, level: 'fail', message: `未知动作 ${action.kind}`});
    }
  }

  const health = runHealth();
  const after = await gatherStates(manifest, {health: health.available ? health.data : null});
  const unhealthy = after.filter(state => !state.ok && state.component.id !== 'mysql');
  console.log('');
  const failed = results.filter(result => result.level === 'fail').length;
  const degraded = results.filter(result => result.level === 'degraded').length;
  const semanticOk = health.available && health.ok === true;
  if (unhealthy.length === 0 && semanticOk) {
    console.log(okText('整套就绪：健康组件未重启，异常组件已按需拉起。'));
  } else if (unhealthy.length === 0) {
    console.log(warnText(`组件与端口就绪，但语义自检未通过：${health.available ? 'health.mjs 有告警' : 'health.mjs 无法运行'}`));
    for (const issue of health.data?.issues ?? []) console.log(warnText(`  ! ${issue}`));
    if (!health.available) console.log(dimText(`  ${shortTail(health.raw, 1)}`));
  } else {
    console.log(warnText(`未完全就绪：${unhealthy.length} 个组件探针异常，${failed} 个启动失败、${degraded} 个降级。`));
    for (const state of unhealthy) console.log(warnText(`  ! ${state.component.label}：${state.unit.activeState}`));
    for (const issue of health.data?.issues ?? []) console.log(warnText(`  ! ${issue}`));
  }
  printUrls();
  return failed === 0 && degraded === 0 && unhealthy.length === 0 && semanticOk ? 0 : 1;
}

function ensureSudoIfNeeded(plan) {
  const needsSudo = plan.some(item => item.component.kind === 'system' && ['start', 'reset-start', 'wait-then-start', 'repair'].includes(item.action.kind));
  if (!needsSudo) return true;
  return ensureSudo();
}

function shortState(state) {
  if (!state.unit.exists) return '单元不存在';
  if (state.active) return state.ok ? '健康' : '运行中，探针异常';
  if (state.unit.activeState === 'failed') return `异常退出（${state.unit.result || 'failed'}）`;
  return state.unit.activeState === 'inactive' ? '未运行' : state.unit.activeState;
}

async function cmdStatus(argv) {
  const options = parseOptions(argv);
  const manifest = loadManifest();
  const issues = validateManifest(manifest);
  if (issues.length) {
    for (const issue of issues) console.error(badText(`✗ 清单错误：${issue}`));
    return 2;
  }
  const health = runHealth();
  const states = await gatherStates(manifest, {health: health.available ? health.data : null});
  const bootIssues = [];
  for (const state of states) {
    const component = state.component;
    if (component.external || !component.boot?.managed || !component.boot?.enabled) continue;
    if (state.unit.exists && state.unit.unitFileState !== 'enabled') bootIssues.push(`${component.id} 未设置开机自启`);
  }
  if (options.json) {
    console.log(JSON.stringify({
      ok: states.every(state => state.ok) && health.ok && bootIssues.length === 0,
      at: new Date().toISOString(),
      bootPolicy: manifest.bootPolicy,
      components: states.map(state => ({
        id: state.component.id,
        label: state.component.label,
        unit: state.component.unit,
        kind: state.component.kind,
        activeState: state.unit.activeState,
        unitFileState: state.unit.unitFileState,
        ports: state.component.ports,
        portsOk: state.portsOk,
        probeOk: state.probeOk,
        ok: state.ok,
        semanticOk: state.semanticOk,
        activeEnter: state.unit.activeEnter,
      })),
      health: health.available ? {ok: health.ok, issues: health.data?.issues ?? [], qq: health.data?.qq ?? null} : {available: false},
      bootIssues,
      issues: bootIssues,
    }, null, 2));
    return states.every(state => state.ok) && health.ok && bootIssues.length === 0 ? 0 : 1;
  }
  console.log(`kurumi-stack 状态（${new Date().toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'})}，开机策略：${manifest.bootPolicy === 'auto' ? '全自动' : manifest.bootPolicy}）`);
  const header = `${pad('组件', 14)}${pad('单元', 34)}${pad('运行状态', 20)}${pad('开机', 6)}${pad('端口', 16)}说明`;
  console.log(header);
  console.log('─'.repeat(displayWidth(header) + 20));
  for (const state of states) {
    const component = state.component;
    const unitState = state.unit.exists ? (state.unit.unitFileState === 'enabled' ? '✓' : '✗') : '—';
    const portText = (component.ports ?? []).length ? (component.ports.map(port => `${port}${state.portsOk ? '' : '✗'}`).join(',')) : '—';
    const semantic = component.semantic === 'qq' && !state.semanticOk ? '，QQ 未在线' : '';
    console.log(`${pad(component.id, 14)}${pad(component.unit, 34)}${pad(shortState(state) + semantic, 20)}${pad(unitState, 6)}${pad(portText, 16)}${component.external ? '外部依赖，不启停' : ''}`);
  }
  if (health.available) {
    console.log('');
    console.log(dimText(`语义自检：health.mjs ${health.ok ? '通过' : '有告警'}${health.data?.qq ? `；QQ ${health.data.qq.online ? '在线' : '离线'}${health.data.qq.good ? '' : '（链路异常）'}` : ''}${health.data?.channel ? `；QQ 频道 ${health.data.channel.some(channel => channel.running && channel.connected) ? '已连接' : '未连接'}` : ''}`));
    if (!health.ok) for (const issue of health.data?.issues ?? []) console.log(warnText(`  ! ${issue}`));
  }
  if (bootIssues.length) {
    console.log('');
    for (const issue of bootIssues) console.log(warnText(`! ${issue}（运行 kurumi-stack install）`));
  }
  console.log('');
  console.log(dimText('提示：点击桌面 “Kurumi 栈” 或在终端运行 kurumi-stack start 只拉起未运行的组件；健康组件不会重启。'));
  const allOk = states.every(state => state.ok) && health.ok && bootIssues.length === 0;
  return allOk ? 0 : 1;
}

async function cmdStop(argv) {
  const options = parseOptions(argv);
  const manifest = loadManifest();
  const targets = stopTargets(manifest, {all: options.all});
  if (targets.length === 0) {
    console.log('没有需要停止的组件。');
    return 0;
  }
  const states = await gatherStates(manifest);
  const activeTargets = targets.filter(component => stateFor(states, component.id)?.active);
  if (options.dryRun) {
    console.log(options.all ? '将停止整套（dry-run，不执行）：' : '将停止 UI/会话层（dry-run，不执行）：');
    for (const component of targets) {
      const state = stateFor(states, component.id);
      const action = !state.unit.exists ? '单元不存在，跳过' : state.active ? '将 stop' : `已是 ${state.unit.activeState}`;
      console.log(`  ${pad(component.id, 12)} ${state.unit.activeState.padEnd(12)} ${action}`);
    }
    const wouldSudo = activeTargets.some(component => component.kind === 'system');
    if (wouldSudo) console.log(dimText('  其中系统单元需要 sudo 密码。'));
    return 0;
  }
  const needsSudo = activeTargets.some(component => component.kind === 'system');
  if (needsSudo && !ensureSudo()) {
    console.error(badText('需要 sudo 权限停止系统单元；请在终端运行 kurumi-stack stop。未执行任何停止操作。'));
    return 1;
  }
  console.log(options.all ? '停止整套（保留 MySQL；KnowledgeMap 网站停止后 8443 转发会暂时指向关闭端口）：' : '停止 UI/会话层（保留 QQ/SnowLuma/KnowledgeMap）：');
  let failed = 0;
  for (const component of targets) {
    const state = stateFor(states, component.id);
    if (!state.unit.exists) {
      console.log(dimText(`- ${component.label}：单元不存在，跳过`));
      continue;
    }
    if (!state.active) {
      console.log(dimText(`- ${component.label}：已是 ${state.unit.activeState}`));
      continue;
    }
    const result = systemctlResult(component, 'stop');
    if (!result.ok) {
      console.log(badText(`✗ ${component.label}：停止失败 ${dimText(result.message)}`));
      failed += 1;
      continue;
    }
    const stopped = await waitUntilInactive(component, 25);
    if (!stopped) {
      console.log(badText(`✗ ${component.label}：stop 已发出但未在期限内停止`));
      failed += 1;
      continue;
    }
    const after = showUnit(component);
    console.log(after.activeState === 'failed'
      ? warnText(`⚠ ${component.label}：已停止，退出状态异常（Result=${after.result || 'unknown'}）`)
      : `${okText('✓')} ${component.label}：已停止`);
  }
  return failed === 0 ? 0 : 1;
}

async function cmdRestart(argv) {
  const options = parseOptions(argv);
  const [id] = options.positionals;
  const manifest = loadManifest();
  const component = componentMap(manifest).get(id);
  if (!component) {
    console.error(badText(`未知组件：${id ?? '(缺少 id)'}`));
    console.error(`可用组件：${manifest.components.map(item => item.id).join(', ')}`);
    return 2;
  }
  if (component.external) {
    console.error(badText(`${component.label} 是外部依赖，kurumi-stack 不重启它。`));
    return 1;
  }
  if (component.kind === 'system' && !ensureSudo()) {
    console.error(badText('需要 sudo 权限；请在终端运行。'));
    return 1;
  }
  if (component.id === 'km-web' && component.launcher && !kmCanUseUnit(component)) {
    const stopped = runLauncher(component, 'stop');
    if (!stopped.ok) {
      console.error(badText(`停止失败：${stopped.message}`));
      return 1;
    }
  } else {
    const result = systemctlResult(component, 'restart');
    if (!result.ok) {
      console.error(badText(`重启失败：${result.message}`));
      return 1;
    }
  }
  const ready = await waitReady(component, {timeoutSec: component.startTimeoutSec});
  if (!ready.ok) {
    console.error(warnText(`${component.label}：已重启但探针未就绪`));
    return 1;
  }
  console.log(`${okText('↑')} ${component.label}：已重启并就绪`);
  return 0;
}

function cmdLogs(argv) {
  const options = parseOptions(argv);
  const [id] = options.positionals;
  const manifest = loadManifest();
  const component = componentMap(manifest).get(id);
  if (!component) {
    console.error(badText(`未知组件：${id ?? '(缺少 id)'}`));
    console.error(`可用组件：${manifest.components.map(item => item.id).join(', ')}`);
    return 2;
  }
  if (component.logFile) console.error(dimText(`文件日志：${component.logFile}`));
  if (component.logDir) console.error(dimText(`目录日志：${component.logDir}`));
  const args = component.kind === 'system' ? ['-u', component.unit] : ['--user', '-u', component.unit];
  args.push('-n', String(options.lines ?? 100), '--no-pager');
  if (options.follow) args.push('-f');
  const result = run('journalctl', args, {stdio: 'inherit', timeout: options.follow ? 0 : 15000});
  return result.status ?? 0;
}

// ---------------------------------------------------------------- doctor

function shortTail(text, lines = 3) {
  return String(text ?? '').trim().split('\n').slice(-lines).join('\n');
}

function driftSummary(text) {
  const line = String(text ?? '').split('\n').find(item => /config DRIFT|persona .*drift|DRIFT:/i.test(item));
  return line ? line.trim() : shortTail(text, 2);
}

function stripComments(text) {
  return String(text).split('\n').filter(line => !line.trim().startsWith('#')).join('\n').trim();
}

function adminWebHash() {
  const files = [
    'chatbot/admin-web/common.mjs', 'chatbot/admin-web/changes.mjs', 'chatbot/admin-web/inventory.mjs',
    'chatbot/admin-web/observations.mjs', 'chatbot/admin-web/logs.mjs', 'chatbot/admin-web/git.mjs', 'chatbot/admin-web/server.mjs', 'chatbot/admin-web/package.json',
    'chatbot/admin-web/public/index.html', 'chatbot/admin-web/public/mark.svg', 'chatbot/admin-web/public/app.js',
    'chatbot/admin-web/public/pages.js', 'chatbot/admin-web/public/components.js', 'chatbot/admin-web/public/styles.css',
    'docs/33_Fusion后端Web界面.md',
  ].map(relative => [relative, fs.readFileSync(path.join(REPO, relative))]);
  const hash = createHash('sha256');
  for (const [name, value] of files) hash.update(name + '\0' + value.length + '\0').update(value);
  return hash.digest('hex').slice(0, 16);
}

function installedAdminWebRelease() {
  try {
    const unit = fs.readFileSync(path.join(HOME, '.config/systemd/user/kurumi-admin-web.service'), 'utf8');
    return /kurumi-admin-web\/([0-9a-f]{16})\//.exec(unit)?.[1] ?? null;
  } catch {
    return null;
  }
}

function processesUnder(target) {
  const found = [];
  let entries = [];
  try {
    entries = fs.readdirSync('/proc').filter(name => /^\d+$/.test(name));
  } catch {
    return found;
  }
  for (const pid of entries) {
    try {
      const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === target || cwd.startsWith(target + path.sep)) found.push(`${pid}(${cwd})`);
    } catch {
      // 进程已退出或不可读
    }
  }
  return found;
}

async function cmdDoctor(argv) {
  const options = parseOptions(argv);
  const checks = [];
  const add = (level, label, detail = '', hint = '') => checks.push({level, label, detail, hint});
  const manifest = loadManifest();
  const manifestIssues = validateManifest(manifest);
  add(manifestIssues.length ? 'fail' : 'ok', '清单合法性', manifestIssues.join('；'), '修 config/stack.json');

  const health = runHealth();
  const states = await gatherStates(manifest, {health: health.available ? health.data : null});
  const byId = new Map(states.map(state => [state.component.id, state]));

  for (const state of states) {
    const component = state.component;
    if (!state.unit.exists) {
      add('fail', `单元存在：${component.id}`, `${component.unit} 不存在`, component.id === 'km-web' ? '先运行 kurumi-stack start 让 KnowledgeMap 启动器生成单元' : 'kurumi-stack install');
      continue;
    }
    if (!state.ok) add('fail', `运行健康：${component.id}`, `${shortState(state)}`, `kurumi-stack start（必要时 --repair）`);
  }
  if (!states.some(state => !state.ok)) add('ok', '运行健康：全部组件');

  const bootFailures = [];
  for (const state of states) {
    const component = state.component;
    if (component.external || !component.boot?.managed || !component.boot?.enabled) continue;
    if (state.unit.exists && state.unit.unitFileState !== 'enabled') bootFailures.push(`${component.id}(${state.unit.unitFileState})`);
  }
  if (manifest.bootPolicy === 'auto' && bootFailures.length) {
    add('fail', '开机策略 A（全自动）', `未启用：${bootFailures.join('、')}`, 'kurumi-stack install（含 sudo 步骤）');
  } else {
    add('ok', '开机策略 A（全自动）');
  }
  const mysqlEnabled = run('systemctl', ['is-enabled', 'mysql.service']).stdout?.trim();
  add(mysqlEnabled === 'enabled' ? 'ok' : 'warn', 'MySQL 自启', mysqlEnabled || '读取失败', 'systemctl is-enabled mysql 非本工具范围');

  add(health.available && health.ok ? 'ok' : 'fail', '语义自检（health.mjs）', health.available ? (health.ok ? '' : (health.data?.issues ?? []).join('；')) : shortTail(health.raw), 'node scripts/fusion/health.mjs');

  const deps = run(NODE_BIN, [path.join(REPO, 'scripts/fusion/verify-dependencies.mjs')], {timeout: 120000});
  add(deps.status === 0 ? 'ok' : 'fail', '依赖校验', deps.status === 0 ? '' : shortTail(deps.stderr || deps.stdout), 'node scripts/fusion/verify-dependencies.mjs');

  const configDiff = run(NODE_BIN, [path.join(REPO, 'scripts/fusion/sync-config.mjs'), '--diff'], {timeout: 90000});
  add(configDiff.status === 0 ? 'ok' : 'warn', '配置同步（sync-config --diff）', configDiff.status === 0 ? '' : driftSummary(`${configDiff.stdout ?? ''}\n${configDiff.stderr ?? ''}`), '确认属于已授权部署后 --apply 并重启');
  const personaDiff = run(NODE_BIN, [path.join(REPO, 'scripts/fusion/sync-persona.mjs'), '--diff'], {timeout: 90000});
  add(personaDiff.status === 0 ? 'ok' : 'fail', '人格同步（sync-persona --diff）', personaDiff.status === 0 ? '' : driftSummary(`${personaDiff.stdout ?? ''}\n${personaDiff.stderr ?? ''}`), 'node scripts/fusion/sync-persona.mjs --apply');

  // 部署一致性
  const deployDrift = [];
  for (const name of LAUNCHER_NAMES) {
    const source = path.join(REPO, 'scripts/fusion/launchers', name);
    const target = path.join(DSH_DEPLOY, name);
    if (!fs.existsSync(target)) deployDrift.push(`${name} 未部署`);
    else if (stripComments(fs.readFileSync(source, 'utf8')) !== stripComments(fs.readFileSync(target, 'utf8'))) deployDrift.push(`${name} 与仓库源不一致`);
  }
  for (const name of ['kurumi-stack-gui']) {
    if (!fs.existsSync(path.join(BIN_DIR, name))) deployDrift.push(`${name} 未安装`);
  }
  try {
    if (!fs.lstatSync(BIN_PATH).isSymbolicLink() || fs.realpathSync(BIN_PATH) !== path.join(REPO, 'scripts/fusion/stack.mjs')) {
      deployDrift.push('kurumi-stack 命令未指向仓库脚本');
    }
  } catch {
    deployDrift.push('kurumi-stack 命令未安装');
  }
  if (!fs.existsSync(DESKTOP_PATH)) deployDrift.push('桌面快捷方式未安装');
  add(deployDrift.length ? 'fail' : 'ok', '入口安装一致性', deployDrift.join('；'), 'kurumi-stack install（含 sudo 步骤）');

  const expectedHash = adminWebHash();
  const installedHash = installedAdminWebRelease();
  add(installedHash === expectedHash ? 'ok' : 'warn', '管理台安装副本', installedHash === expectedHash ? '' : `已安装 ${installedHash ?? '未知'}，main 为 ${expectedHash}（可能来自尚未合并的分支）`, '以 main 为准时：/usr/bin/node scripts/fusion/install-admin-web.mjs && systemctl --user restart kurumi-admin-web.service');

  const km = componentMap(manifest).get('km-web');
  const kmState = km ? launcherState(km) : null;
  const kmProblems = [];
  if (!kmState) kmProblems.push('缺少启动器状态文件');
  else if (kmState.root !== km.launcher.root) kmProblems.push(`启动器事实源是 ${kmState.root}`);
  if (fs.existsSync(KM_DESKTOP_COPY)) kmProblems.push('桌面旧副本仍在');
  const under = processesUnder(KM_DESKTOP_COPY);
  if (under.length) kmProblems.push(`仍有进程工作目录在旧副本：${under.join('、')}`);
  add(kmProblems.length ? 'fail' : 'ok', 'KnowledgeMap 唯一事实源', kmProblems.join('；'), 'kurumi-stack start 并删除桌面旧副本');

  const legacy = ['qq-bridge.service', 'openclaw-gateway.service'].map(unit => {
    const result = run('systemctl', ['--user', 'show', unit, '-p', 'ActiveState', '-p', 'UnitFileState']);
    const values = Object.fromEntries(String(result.stdout ?? '').split('\n').filter(line => line.includes('=')).map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]));
    return {unit, active: values.ActiveState, file: values.UnitFileState};
  });
  const legacyProblems = legacy.filter(item => item.active === 'active');
  add(legacyProblems.length ? 'fail' : 'ok', '旧消费者已停用', legacyProblems.map(item => item.unit).join('、'), 'systemctl --user stop 旧单元');

  let tailscale = null;
  try {
    const result = run('tailscale', ['serve', 'status', '--json'], {timeout: 10000});
    tailscale = JSON.parse(result.stdout || '{}');
  } catch {
    tailscale = null;
  }
  if (!tailscale) {
    add('warn', 'Tailscale Serve 转发', '无法读取 tailscale serve 状态', '检查 tailscale 登录状态');
  } else {
    const handlers = Object.entries(tailscale.Web ?? {});
    const proxy = port => handlers.find(([authority]) => authority.endsWith(`:${port}`))?.[1]?.Handlers?.['/']?.Proxy;
    const problems = [];
    if (proxy(443) !== 'http://127.0.0.1:3080') problems.push(`443 → ${proxy(443) ?? '未配置'}（应为 3080）`);
    if (proxy(8443) !== 'http://127.0.0.1:8020') problems.push(`8443 → ${proxy(8443) ?? '未配置'}（应为 8020）`);
    add(problems.length ? 'fail' : 'ok', 'Tailscale Serve 转发', problems.join('；'), 'tailscale serve --bg --https=8443 http://127.0.0.1:8020');
  }

  const portConflicts = [];
  const ports = listeningPorts();
  for (const state of states) {
    const component = state.component;
    if (component.external || state.unit.activeState === 'active') continue;
    const occupied = (component.ports ?? []).filter(port => ports.has(port));
    if (occupied.length) portConflicts.push(`${component.id} 端口 ${occupied.join(',')} 被占用`);
  }
  add(portConflicts.length ? 'fail' : 'ok', '端口占用冲突', portConflicts.join('；'), '查明占用进程后再启动，避免双实例');

  const failedUnits = [];
  for (const state of states) if (state.unit.activeState === 'failed') failedUnits.push(state.component.unit);
  add(failedUnits.length ? 'fail' : 'ok', '失败单元', failedUnits.join('、'), 'kurumi-stack start 或查看 logs');

  if (options.json) {
    console.log(JSON.stringify({ok: checks.every(check => check.level !== 'fail'), at: new Date().toISOString(), checks}, null, 2));
    return checks.some(check => check.level === 'fail') ? 1 : 0;
  }
  const marks = {ok: okText('✓'), warn: warnText('!'), fail: badText('✗')};
  console.log('kurumi-stack doctor（只读诊断，不修改任何服务）');
  for (const check of checks) {
    console.log(`${marks[check.level]} ${check.label}${check.detail ? dimText(`：${check.detail}`) : ''}`);
    if (check.level !== 'ok' && check.hint) console.log(dimText(`    处理：${check.hint}`));
  }
  const fails = checks.filter(check => check.level === 'fail').length;
  const warns = checks.filter(check => check.level === 'warn').length;
  console.log('');
  console.log(fails === 0 ? okText(`doctor 通过（${checks.length} 项，${warns} 个警告）`) : badText(`doctor 未通过：${fails} 项失败，${warns} 个警告`));
  return fails === 0 ? 0 : 1;
}

// ---------------------------------------------------------------- install

const GUI_WRAPPER = `#!/usr/bin/env bash
# kurumi-stack 桌面快捷方式入口：启动/自检后暂停，便于阅读输出。
set -uo pipefail
export PATH="$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin"
"$HOME/.local/bin/kurumi-stack" start "$@"
code=$?
echo
read -n 1 -s -r -p "按任意键关闭窗口…"
echo
exit $code
`;

function desktopEntry() {
  return `[Desktop Entry]
Type=Application
Version=1.0
Name=Kurumi 栈（启动/自检）
Comment=按需拉起异常退出的组件并检查整套服务；健康组件不会重启
Exec=${GUI_PATH}
Icon=utilities-system-monitor
Terminal=true
Categories=Utility;
StartupNotify=false
`;
}

function writeFileAtomic(target, content, mode = 0o644) {
  fs.mkdirSync(path.dirname(target), {recursive: true});
  const temporary = `${target}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, content, {mode});
  fs.chmodSync(temporary, mode);
  fs.renameSync(temporary, target);
}

async function cmdInstall(argv) {
  const options = parseOptions(argv);
  const manifest = loadManifest();
  const plan = [];
  const runStep = (label, fn) => plan.push({label, fn});

  runStep('安装 kurumi-stack 命令', () => {
    fs.mkdirSync(BIN_DIR, {recursive: true});
    if (fs.existsSync(BIN_PATH) && !fs.lstatSync(BIN_PATH).isSymbolicLink()) throw Error(`${BIN_PATH} 已存在且不是符号链接，拒绝覆盖`);
    try {
      fs.unlinkSync(BIN_PATH);
    } catch {}
    fs.symlinkSync(path.join(REPO, 'scripts/fusion/stack.mjs'), BIN_PATH);
    fs.chmodSync(path.join(REPO, 'scripts/fusion/stack.mjs'), 0o755);
    writeFileAtomic(GUI_PATH, GUI_WRAPPER, 0o755);
  });
  runStep('安装桌面快捷方式', () => {
    fs.mkdirSync(DESKTOP_DIR, {recursive: true});
    writeFileAtomic(DESKTOP_PATH, desktopEntry(), 0o755);
    writeFileAtomic(APPS_PATH, desktopEntry(), 0o755);
    run('gio', ['set', '-t', 'string', DESKTOP_PATH, 'metadata::trusted', 'true'], {timeout: 5000});
  });
  runStep('刷新用户单元并启用自启', () => {
    run('systemctl', ['--user', 'daemon-reload'], {timeout: 15000});
    const pending = [];
    for (const component of manifest.components) {
      if (component.kind !== 'user' || component.external || !component.boot?.managed || !component.boot?.enabled) continue;
      const unit = showUnit(component);
      if (!unit.exists) {
        pending.push(component.id);
        continue;
      }
      if (unit.unitFileState !== 'enabled') run('systemctl', ['--user', 'enable', component.unit], {timeout: 15000});
    }
    if (pending.length) console.log(dimText(`  待生成单元：${pending.join('、')}（先运行 kurumi-stack start）`));
  });

  const pendingSudo = [];
  const privilegedCommands = () => [
    ['sudo', 'systemctl', 'enable', 'dsh-web.service'],
    ['sudo', 'install', '-o', 'dsh', '-g', 'dsh', '-m', '755', path.join(REPO, 'scripts/fusion/launchers/Start-DSH.sh'), path.join(DSH_DEPLOY, 'Start-DSH.sh')],
    ['sudo', 'install', '-o', 'dsh', '-g', 'dsh', '-m', '755', path.join(REPO, 'scripts/fusion/launchers/Stop-DSH.sh'), path.join(DSH_DEPLOY, 'Stop-DSH.sh')],
  ];

  if (options.dryRun) {
    for (const step of plan) console.log(`将执行：${step.label}`);
    console.log('将执行（需要 sudo）：');
    for (const command of privilegedCommands()) console.log(`  ${command.join(' ')}`);
    return 0;
  }
  for (const step of plan) {
    try {
      step.fn();
      console.log(`${okText('✓')} ${step.label}`);
    } catch (error) {
      console.log(badText(`✗ ${step.label}：${error.message}`));
      return 1;
    }
  }
  // 只有在真实终端里才尝试 sudo；无终端或 --no-sudo 时只打印待执行命令，不制造失败噪音。
  if (options.noSudo || !process.stdin.isTTY) {
    for (const command of privilegedCommands()) pendingSudo.push(command.join(' '));
  } else {
    for (const command of privilegedCommands()) {
      const result = run(command[0], command.slice(1), {stdio: 'inherit', timeout: 60000});
      if (result.status !== 0) pendingSudo.push(command.join(' '));
    }
  }
  if (pendingSudo.length) {
    console.log('');
    console.log(warnText('以下系统级步骤需要你在终端执行一次（sudo 密码不经过本工具保存）：'));
    for (const command of pendingSudo) console.log(`  ${command}`);
  } else {
    console.log(okText('系统级步骤已完成（DSH 已设为开机自启，/opt 启动器已更新）。'));
  }
  console.log('');
  console.log('下一步：kurumi-stack start（只拉起异常退出的组件，健康组件不会重启）');
  console.log(`桌面快捷方式：${DESKTOP_PATH}`);
  return 0;
}

// ---------------------------------------------------------------- CLI

function parseOptions(argv) {
  const options = {positionals: [], json: false, all: false, repair: false, dryRun: false, noSudo: false, verbose: false, follow: false, only: null, lines: null};
  for (const arg of argv) {
    if (arg === '--json') options.json = true;
    else if (arg === '--all') options.all = true;
    else if (arg === '--repair') options.repair = true;
    else if (arg === '--dry-run') options.dryRun = true;
    else if (arg === '--no-sudo') options.noSudo = true;
    else if (arg === '--verbose') options.verbose = true;
    else if (arg === '--follow' || arg === '-f') options.follow = true;
    else if (arg.startsWith('--only=')) options.only = arg.slice('--only='.length).split(',').map(value => value.trim()).filter(Boolean);
    else if (arg.startsWith('--lines=')) options.lines = Number(arg.slice('--lines='.length));
    else if (arg.startsWith('-')) throw Error(`未知参数：${arg}`);
    else options.positionals.push(arg);
  }
  return options;
}

function usage() {
  console.log(`用法：kurumi-stack <命令> [选项]

命令：
  start [--repair] [--dry-run] [--only=a,b]   收敛整套：健康组件只检查；异常退出/未运行的才拉起
  stop [--all] [--dry-run]                     默认停 UI/会话层（管理台、Fusion、DSH）；--all 停整套
  status [--json]                             查看服务、端口、自启、语义健康
  doctor [--json]                             只读诊断：单元、开机策略、部署漂移、转发、端口冲突
  restart <组件>                               显式重启单个组件
  logs <组件> [-f] [--lines=100]              查看组件日志
  install [--no-sudo] [--dry-run]             安装命令、桌面快捷方式、自启（系统级步骤需要 sudo）

组件：${loadManifest().components.map(component => component.id).join(', ')}
边界：start 不重启健康组件；运行中但探针异常只报告，--repair 才重启。`);
}

async function main() {
  const [command = 'status', ...rest] = process.argv.slice(2);
  const handlers = {start: cmdStart, stop: cmdStop, status: cmdStatus, restart: cmdRestart, logs: cmdLogs, doctor: cmdDoctor, install: cmdInstall};
  try {
    const options = parseOptions(rest);
    if (command === 'help' || command === '--help' || command === '-h') {
      usage();
      return 0;
    }
    if (!handlers[command]) {
      console.error(badText(`未知命令：${command}`));
      usage();
      return 2;
    }
    return await handlers[command](rest, options);
  } catch (error) {
    console.error(badText(`错误：${error.message}`));
    if (process.argv.includes('--verbose')) console.error(error.stack);
    return 2;
  }
}

const invokedPath = process.argv[1] ? (() => {
  try {
    return fs.realpathSync(process.argv[1]);
  } catch {
    return path.resolve(process.argv[1]);
  }
})() : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
  main().then(code => {
    process.exitCode = code;
  });
}
