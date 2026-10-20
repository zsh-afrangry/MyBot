// Real isolated Gateway loading/disabling and RPC catalogs; no model/API/QQ/SMTP.
// Writes temporary state and the explicitly supplied new --out evidence file only.
// Evidence: docs/verification/capability-decoupling-2026-10-20/README.md
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {randomBytes} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';

const out = process.argv[process.argv.indexOf('--out') + 1];
if (!process.argv.includes('--out') || !path.isAbsolute(out ?? '') || fs.existsSync(out)) throw Error('Require a new absolute --out');
const repo = fileURLToPath(new URL('../../../', import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-capabilities-host-'));
const token = randomBytes(24).toString('hex');
const probe = path.join(root, 'probe'); fs.mkdirSync(probe);
fs.writeFileSync(path.join(probe, 'package.json'), JSON.stringify({name: 'capability-probe', type: 'module', openclaw: {extensions: ['./index.js']}}));
fs.writeFileSync(path.join(probe, 'openclaw.plugin.json'), JSON.stringify({id: 'capability-probe', activation: {onStartup: true}, configSchema: {type: 'object', properties: {}}}));
const core = pathToFileURL(path.join(repo, 'chatbot/packages/confirmation-core/dist/index.js')).href;
fs.writeFileSync(path.join(probe, 'index.js'), `import {confirmationBackendIds} from ${JSON.stringify(core)};
export default {id:'capability-probe',register(api){api.registerGatewayMethod('capability-probe.backends',({respond})=>respond(true,{ids:confirmationBackendIds()}));}};`);
const ids = ['personal-weather', 'personal-profile', 'personal-planning', 'personal-reminders'];
const manifests = Object.fromEntries(ids.map(id => [id, JSON.parse(fs.readFileSync(path.join(repo, 'chatbot/plugins', id, 'openclaw.plugin.json')))]));
const report = {at: new Date().toISOString(), boundary: 'Real isolated Gateway and plugin/tool RPC catalogs. No model provider, external API, QQ network or production write.', stages: []};

async function run(disabled) {
  const directory = path.join(root, disabled ?? 'all'); fs.mkdirSync(directory);
  const portProbe = net.createServer(); portProbe.listen(0, '127.0.0.1'); await once(portProbe, 'listening');
  const port = portProbe.address().port; await new Promise(resolve => portProbe.close(resolve));
  const entries = Object.fromEntries(ids.map(id => [id, {enabled: id !== disabled, config:
    ['personal-weather', 'personal-profile'].includes(id) ? {apiHost: 'example.invalid', apiKey: 'synthetic'} : {}}]));
  entries['capability-probe'] = {enabled: true};
  const config = {
    gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
    agents: {defaults: {workspace: path.join(directory, 'workspace'), heartbeat: {every: '0m'}}, entries: {main: {workspace: path.join(directory, 'workspace')}}},
    plugins: {allow: [...ids, 'capability-probe'], load: {paths: [...ids.map(id => path.join(repo, 'chatbot/plugins', id)), probe]}, entries, slots: {memory: 'none'}},
    cron: {enabled: false}, tools: {web: {search: {enabled: false}, fetch: {enabled: false}}},
    logging: {file: path.join(directory, 'runtime.log')},
  };
  fs.mkdirSync(config.agents.defaults.workspace);
  const configFile = path.join(directory, 'openclaw.json'); fs.writeFileSync(configFile, JSON.stringify(config), {mode: 0o600});
  const fd = fs.openSync(path.join(directory, 'gateway.log'), 'w', 0o600);
  const child = spawn(process.execPath, [path.join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port), '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {
    cwd: repo, detached: true, stdio: ['ignore', fd, fd],
    env: {PATH: process.env.PATH, HOME: process.env.HOME, LANG: 'C.UTF-8', OPENCLAW_STATE_DIR: directory,
      OPENCLAW_CONFIG_PATH: configFile, OPENCLAW_GATEWAY_TOKEN: token, OPENCLAW_AGENT_DIR: path.join(directory, 'agents/main/agent')},
  }); fs.closeSync(fd);
  const call = (method, params = {}, timeout = 10000) => callGatewayFromCli(method,
    {url: `ws://127.0.0.1:${port}`, token, timeout: String(timeout), json: true}, params);
  try {
    let ready = false;
    for (let i = 0; i < 100; i++) {
      try { await call('health', {}, 1000); ready = true; break; }
      catch { if (child.exitCode !== null) throw Error('Isolated Gateway exited: ' + fs.readFileSync(path.join(directory, 'gateway.log'), 'utf8').replaceAll(token, '[token]').slice(-4000)); await new Promise(r => setTimeout(r, 300)); }
    }
    assert(ready, 'Isolated Gateway readiness timed out');
    const plugins = await call('plugins.list'), catalog = await call('tools.catalog', {agentId: 'main', includePlugins: true});
    const backends = (await call('capability-probe.backends')).ids;
    const expectedBackends = ['personal-profile', 'personal-planning', 'personal-reminder']
      .filter(id => id !== disabled && !(disabled === 'personal-reminders' && id === 'personal-reminder')).sort();
    assert.deepEqual(backends, expectedBackends);
    const groups = catalog.groups.filter(g => ids.includes(g.pluginId));
    for (const id of ids) {
      const record = plugins.plugins.find(p => p.id === id);
      assert(record, `Missing ${id}`);
      if (id === disabled) {
        assert(['disabled', 'unloaded'].includes(record.runtime.state), JSON.stringify(record.runtime));
        assert.equal(config.plugins.entries[id].enabled, false);
      } else assert.equal(record.runtime.state, 'active', JSON.stringify(record.runtime));
      const tools = groups.find(g => g.pluginId === id)?.tools.map(t => t.id).sort() ?? [];
      assert.deepEqual(tools, id === disabled ? [] : manifests[id].contracts.tools.slice().sort());
    }
    report.stages.push({disabled, backends, plugins: plugins.plugins.filter(p => ids.includes(p.id)).map(p => ({id: p.id, state: p.runtime.state})),
      tools: groups.map(g => ({plugin: g.pluginId, names: g.tools.map(t => t.id)})), passed: true});
  } finally {
    const exited = once(child, 'exit');
    try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 8000);
    timer.unref();
    if (child.exitCode === null && child.signalCode === null) await exited;
    clearTimeout(timer);
  }
}

try {
  await run(null);
  // Each disabled capability must leave its siblings' tools/services intact.
  for (const id of ids) await run(id);
  report.passed = true;
} catch (error) { report.passed = false; report.error = error.stack; process.exitCode = 1; }
finally {
  report.finishedAt = new Date().toISOString();
  if (report.passed) fs.rmSync(root, {recursive: true, force: true});
  else report.diagnosticDirectory = root;
  fs.writeFileSync(out, JSON.stringify(report, null, 2), {flag: 'wx'});
  console.log(JSON.stringify({passed: report.passed, stages: report.stages.length, error: report.error}));
}
