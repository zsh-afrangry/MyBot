// kurumi-stack 决策与清单的离线测试；不起停任何服务。
// 对应文档：docs/9_QQ融合助手架构与开发计划.md「统一启停（kurumi-stack）」。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  MANIFEST_PATH, loadManifest, validateManifest, decideAction, precheckStart,
  planStart, stopTargets, parseSsPorts, parseSsOwners,
} from '../stack.mjs';

const manifest = loadManifest();
const byId = new Map(manifest.components.map(component => [component.id, component]));

function stateOf(id, overrides = {}) {
  const component = byId.get(id);
  const unit = {
    exists: true, activeState: 'active', subState: 'running', unitFileState: 'enabled', result: 'success', activeEnter: 'now',
    ...(overrides.unit ?? {}),
  };
  const active = unit.activeState === 'active';
  return {
    component,
    unit,
    active,
    probeOk: overrides.probeOk ?? active,
    portsOk: overrides.portsOk ?? active,
    ok: overrides.ok ?? (active && (overrides.probeOk ?? active) && (overrides.portsOk ?? active)),
    semanticOk: overrides.semanticOk ?? true,
  };
}

test('仓库内清单合法，端口与单元不重复', () => {
  assert.deepEqual(validateManifest(manifest), []);
  assert.ok(fs.existsSync(MANIFEST_PATH));
});

test('清单校验能发现重复端口、重复单元与非法 kind', () => {
  const broken = {
    components: [
      {id: 'a', kind: 'user', unit: 'a.service', order: 1, ports: [3000]},
      {id: 'a', kind: 'daemon', unit: 'a.service', order: 1, ports: [3000]},
    ],
    defaultStop: ['nope'],
  };
  const issues = validateManifest(broken);
  assert.ok(issues.some(issue => issue.includes('id 重复')));
  assert.ok(issues.some(issue => issue.includes('unit 重复')));
  assert.ok(issues.some(issue => issue.includes('kind')));
  assert.ok(issues.some(issue => issue.includes('端口 3000')));
  assert.ok(issues.some(issue => issue.includes('defaultStop')));
});

test('健康组件只检查，不进入拉起动作', () => {
  assert.equal(decideAction(byId.get('fusion'), stateOf('fusion')).kind, 'ok');
  assert.equal(decideAction(byId.get('dsh'), stateOf('dsh')).kind, 'ok');
});

test('异常退出与未运行才拉起', () => {
  assert.equal(decideAction(byId.get('fusion'), stateOf('fusion', {unit: {activeState: 'failed', subState: 'failed'}})).kind, 'reset-start');
  assert.equal(decideAction(byId.get('admin-web'), stateOf('admin-web', {unit: {activeState: 'inactive', subState: 'dead'}})).kind, 'start');
  assert.equal(decideAction(byId.get('fusion'), stateOf('fusion', {unit: {activeState: 'activating', subState: 'start'}})).kind, 'wait');
  assert.equal(decideAction(byId.get('fusion'), stateOf('fusion', {unit: {activeState: 'deactivating', subState: 'stop'}})).kind, 'wait-then-start');
});

test('运行中但探针异常默认不重启，--repair 才允许', () => {
  const degraded = stateOf('fusion', {probeOk: false, ok: false});
  assert.equal(decideAction(byId.get('fusion'), degraded).kind, 'degraded');
  assert.equal(decideAction(byId.get('fusion'), degraded, {repair: true}).kind, 'repair');
});

test('外部依赖（MySQL）只检查，不启停', () => {
  const healthy = stateOf('mysql');
  assert.equal(decideAction(byId.get('mysql'), healthy).kind, 'external-ok');
  const down = stateOf('mysql', {unit: {activeState: 'inactive', subState: 'dead'}, probeOk: false, ok: false});
  assert.equal(decideAction(byId.get('mysql'), down).kind, 'external-down');
});

test('启动前置边界：无图形会话、sudo 不可用、端口被占时拒绝启动', () => {
  const qq = byId.get('qq');
  const qqState = stateOf('qq', {unit: {activeState: 'inactive', subState: 'dead'}});
  const action = decideAction(qq, qqState);
  assert.equal(precheckStart(qq, action, {ports: new Set(), display: false, sudoReady: true}), 'no-display');
  const dsh = byId.get('dsh');
  const dshState = stateOf('dsh', {unit: {activeState: 'inactive', subState: 'dead'}});
  assert.equal(precheckStart(dsh, decideAction(dsh, dshState), {ports: new Set(), display: true, sudoReady: false}), 'sudo-required');
  const fusion = byId.get('fusion');
  const fusionState = stateOf('fusion', {unit: {activeState: 'inactive', subState: 'dead'}});
  assert.equal(precheckStart(fusion, decideAction(fusion, fusionState), {ports: new Set([18890]), display: true, sudoReady: true}), 'port-conflict');
  assert.equal(precheckStart(fusion, decideAction(fusion, fusionState), {ports: new Set(), display: true, sudoReady: true}), null);
});

test('start 计划按 order 排序，--only 只包含指定组件', () => {
  const states = manifest.components.map(component => stateOf(component.id, {
    unit: {activeState: 'inactive', subState: 'dead'},
    probeOk: false, portsOk: false, ok: false,
  }));
  const plan = planStart(manifest, states);
  assert.deepEqual(plan.map(item => item.component.id), ['mysql', 'mongodb', 'km-api', 'km-web', 'dsh', 'snowluma', 'qq', 'fusion', 'admin-web']);
  const only = planStart(manifest, states, {only: ['fusion', 'admin-web']});
  assert.deepEqual(only.map(item => item.component.id), ['fusion', 'admin-web']);
});

test('stop 默认只停 UI/会话层，--all 停整套但不含外部 MySQL', () => {
  const defaults = stopTargets(manifest).map(component => component.id);
  assert.deepEqual(defaults, ['admin-web', 'fusion', 'dsh']);
  const all = stopTargets(manifest, {all: true}).map(component => component.id);
  assert.ok(!all.includes('mysql'));
  assert.ok(all.includes('snowluma') && all.includes('qq') && all.includes('km-web'));
  assert.deepEqual(all, [...all].sort((a, b) => byId.get(b).order - byId.get(a).order));
});

test('ss 输出解析出监听端口与占用进程', () => {
  const stdout = [
    'LISTEN 0 511 127.0.0.1:3080 0.0.0.0:* users:(("node",pid=255587,fd=21))',
    'LISTEN 0 4096 [::1]:18890 [::]:*',
    'LISTEN 0 4096 127.0.0.53%lo:53 0.0.0.0:*',
  ].join('\n');
  assert.deepEqual([...parseSsPorts(stdout)].sort((a, b) => a - b), [53, 3080, 18890]);
  assert.equal(parseSsOwners(stdout).get(3080), 'node(pid=255587)');
});

test('清单中所有 HTTP 探针只访问本机回环地址', () => {
  for (const component of manifest.components) {
    for (const probe of component.probes ?? []) {
      if (probe.type === 'http') assert.match(probe.url, /^http:\/\/127\.0\.0\.1:\d+\//);
    }
  }
});
