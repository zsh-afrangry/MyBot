// Real isolated Gateway/plugin catalog and enabled/disabled lifecycle. No model/API/QQ network. DSH is not launched.
// Evidence: docs/verification/coding-delegation-plan-2026-10-28/product-pilot-2026-10-29/README.md.
// Only temporary state/processes and the explicitly supplied new --out evidence file.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import assert from 'node:assert/strict';
import {git} from '../../plugins/kurumi-coding/workspaces.js';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !path.isAbsolute(out ?? '') || fs.existsSync(out)) throw Error('Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-coding-host-'));
const source = path.join(root, 'source'); fs.mkdirSync(source); git(source, 'init', '-b', 'main');
fs.writeFileSync(path.join(source, 'README.md'), 'synthetic host load only\n'); git(source, 'add', '.');
git(source, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@localhost', 'commit', '-m', 'host fixture');
const dshHome = path.join(root, 'dsh-home'); fs.mkdirSync(dshHome);
const token = randomBytes(24).toString('hex');
const report = {at: new Date().toISOString(), boundary: 'Real isolated Gateway/plugin loading, RPC catalog and graceful process stop. No model provider, external API, QQ network or production write. Tool handler/permission and timer behavior covered separately by offline tests.', stages: []};
async function run(enabled) {
  const directory = path.join(root, enabled ? 'enabled' : 'disabled'); fs.mkdirSync(directory);
  const socket = net.createServer(); socket.listen(0, '127.0.0.1'); await once(socket, 'listening');
  const port = socket.address().port; await new Promise(r => socket.close(r));
  const codingRoot = path.join(directory, 'coding');
  const pluginConfig = {pilot: true, writeBoundary: {root, launcher: '/opt/deepseek-harness/node_modules/@deepseek-ai/node-addon-system-linux-x64/bin/landlock-run'}, root: codingRoot, worktrees: path.join(directory, 'worktrees'), dsh: {command: process.execPath, home: dshHome, model: ['fixture', 'fixture']}, projects: [{id: 'fixture', root: source, branch: 'main', checks: [{name: 'fixture check', argv: [process.execPath, '-e', 'process.exit(0)']}]}]};
  const config = {
    gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
    agents: {defaults: {workspace: path.join(directory, 'workspace'), heartbeat: {every: '0m'}}, entries: {main: {workspace: path.join(directory, 'workspace'), tools: {alsoAllow: ['kurumi_code']}}}},
    plugins: {allow: ['kurumi-coding'], load: {paths: [path.join(repo, 'chatbot/plugins/kurumi-coding')]}, entries: {'kurumi-coding': {enabled, config: pluginConfig}}, slots: {memory: 'none'}},
    cron: {enabled: false}, tools: {web: {search: {enabled: false}, fetch: {enabled: false}}}, logging: {file: path.join(directory, 'runtime.log')},
  };
  fs.mkdirSync(config.agents.defaults.workspace);
  const configFile = path.join(directory, 'openclaw.json'); fs.writeFileSync(configFile, JSON.stringify(config), {mode: 0o600});
  const fd = fs.openSync(path.join(directory, 'gateway.log'), 'w', 0o600);
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
    cwd: repo, detached: true, stdio: ['ignore', fd, fd],
    env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', OPENCLAW_STATE_DIR: directory, OPENCLAW_CONFIG_PATH: configFile,
      OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_AGENT_DIR: path.join(directory, 'agents/main/agent')},
  }); fs.closeSync(fd);
  const call = (method, params = {}, timeout = 10000) => callGatewayFromCli(method,
    {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
  const stage = {enabled}; report.stages.push(stage);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try {await call('health', {}, 1000); ready = true; break;}
      catch {if (child.exitCode !== null) throw Error('Isolated Gateway exited'); await new Promise(r => setTimeout(r, 300));}
    }
    assert(ready, 'Gateway readiness timed out');
    const plugins = await call('plugins.list'), catalog = await call('tools.catalog', {agentId: 'main', includePlugins: true});
    const plugin = plugins.plugins.find(p => p.id === 'kurumi-coding'); assert(plugin);
    const names = catalog.groups.filter(g => g.pluginId === 'kurumi-coding').flatMap(g => g.tools.map(t => t.id));
    if (enabled) {assert.equal(plugin.runtime.state, 'active'); assert.deepEqual(names, ['kurumi_code']);}
    else {assert(['disabled', 'unloaded'].includes(plugin.runtime.state)); assert.deepEqual(names, []);}
    assert.equal(fs.existsSync(path.join(codingRoot, 'coding.sqlite')), enabled);
    assert.equal(fs.existsSync(path.join(codingRoot, 'tasks')), false); // Loading never starts a model task.
    Object.assign(stage, {state: plugin.runtime.state, tools: names, noInitialTask: true, passed: true});
  } finally {
    const exited = once(child, 'exit'); let killed = false;
    try {process.kill(-child.pid, 'SIGTERM');} catch {}
    const timer = setTimeout(() => {killed = true; try {process.kill(-child.pid, 'SIGKILL');} catch {}}, 8000); timer.unref();
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(timer); stage.gracefulStop = !killed; assert.equal(killed, false);
    assert.equal(fs.existsSync(path.join(codingRoot, 'service.lock')), false); stage.serviceLockReleased = true;
  }
}
try {await run(true); await run(false); report.passed = true;}
catch (error) {report.passed = false; report.error = {name: error.name, message: error.message}; process.exitCode = 1;}
finally {
  report.finishedAt = new Date().toISOString();
  if (report.passed) fs.rmSync(root, {recursive: true, force: true}); else report.diagnosticDirectory = root;
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', {flag: 'wx'});
  console.log(JSON.stringify({passed: report.passed, stages: report.stages.length, error: report.error}));
}
