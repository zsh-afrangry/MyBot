import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import {openSync, closeSync, writeFileSync} from 'node:fs';
import {createServer} from 'node:net';
import {join} from 'node:path';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {waitForAcceptance} from './onebot-peer.mjs';
import {closeOnScenarioDisconnect, scenarioSignal} from './scenario-lifecycle.mjs';

// Accepts a temporary root owned by the caller. The child inherits no
// production state, shell credentials or agent-dir overrides.
export async function startIsolatedGateway({repo, root, token, configure, preload}) {
  scenarioSignal.throwIfAborted();
  const probe = createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const {port} = probe.address();
  await new Promise(resolve => probe.close(resolve));
  const cfg = {
    ...configure(port),
    gateway: {mode: 'local', port, bind: 'loopback', auth: {mode: 'token', token}, controlUi: {enabled: false}},
    discovery: {mdns: {mode: 'off'}},
  };
  const configFile = join(root, 'openclaw.json');
  scenarioSignal.throwIfAborted();
  const config = JSON.stringify(cfg);
  writeFileSync(configFile, config, {flag: 'wx', mode: 0o600});
  const fd = openSync(join(root, 'gateway.log'), 'wx', 0o600);
  let child;
  try {
    child = spawn(process.execPath, [...(preload ? ['--import', preload] : []),
      join(repo, 'node_modules/openclaw/openclaw.mjs'), 'gateway', 'run', '--port', String(port),
      '--bind', 'loopback', '--auth', 'token', '--tailscale', 'off'], {cwd: root, detached: true, stdio: ['ignore', fd, fd],
      env: {PATH: process.env.PATH, HOME: root, LANG: 'C.UTF-8', OPENCLAW_STATE_DIR: root, OPENCLAW_CONFIG_PATH: configFile,
        OPENCLAW_GATEWAY_TOKEN: token}});
  } finally {closeSync(fd);}
  let fault, stopped;
  const exited = new Promise(resolve => {
    child.once('exit', resolve);
    child.once('error', error => {fault = error; resolve();});
  });
  const call = (method, params = {}, timeoutMs = 10000) => callGatewayFromCli(method,
    {config: cfg, url: 'ws://127.0.0.1:' + port, token, timeout: String(timeoutMs), json: true}, params,
    {deviceIdentity: null, sharedStateMode: 'read-only'});
  const close = () => stopped ??= (async () => {
    removeDisconnectHandler();
    if (fault || child.exitCode !== null || child.signalCode !== null) return true;
    try {process.kill(-child.pid, 'SIGTERM');} catch {}
    let forced = false;
    const timer = setTimeout(() => {
      forced = true;
      try {process.kill(-child.pid, 'SIGKILL');} catch {}
    }, 8000);
    try {await exited; return !forced;} finally {clearTimeout(timer);}
  })();
  const removeDisconnectHandler = closeOnScenarioDisconnect(close);
  return {
    configSha256: createHash('sha256').update(config).digest('hex'),
    call,
    async ready() {
      await waitForAcceptance(async () => {
        if (fault) throw fault;
        assert(child.exitCode === null && child.signalCode === null, 'Isolated Gateway exited');
        try {return await call('health', {}, 1000);} catch {return false;}
      }, 'isolated Gateway health', {timeoutMs: 20000});
    },
    close,
  };
}
