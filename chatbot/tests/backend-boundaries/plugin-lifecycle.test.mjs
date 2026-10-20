// Real installed OpenClaw service manager, isolated temporary state and synthetic identity.
// Injected translation/delivery only; no model/API/QQ/SMTP calls or production service restart.
// Evidence and scope: docs/verification/plugin-lifecycle-2026-10-19/README.md.
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {pdf} from '../papers/fixtures.mjs';
import {withAccess} from '../access-control/fixtures.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-plugin-lifecycle-'));
const previous = Object.fromEntries(['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'].map(key => [key, process.env[key]]));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'openclaw.json');
const config = withAccess({logging: {file: path.join(root, 'host.log'), level: 'silent'}}, '100001');
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(config));
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, {recursive: true, force: true});
});

// The manager is internal to the pinned SDK. Discover its hashed bundle and named
// function rather than copying host semantics or silently skipping an SDK change.
const dist = path.dirname(fileURLToPath(import.meta.resolve('openclaw')));
const bundles = fs.readdirSync(dist).filter(name => /^services-.*\.mjs$/.test(name)
  && fs.readFileSync(path.join(dist, name), 'utf8').includes('function startPluginServices('));
assert.equal(bundles.length, 1, 'Installed OpenClaw service manager layout changed; update this integration test');
const manager = await import(pathToFileURL(path.join(dist, bundles[0])).href);
const startPluginServices = Object.values(manager).find(value => typeof value === 'function' && value.name === 'startPluginServices');
assert.equal(typeof startPluginServices, 'function');
const {createPaperPlugin} = await import('../../plugins/kurumi-papers/index.js');
const {PaperService} = await import('../../plugins/kurumi-papers/service.js');
const {createMailPlugin} = await import('../../plugins/kurumi-mail/index.js');
const {confirmationBackendIds, registerConfirmationBackend} = await import('../../packages/confirmation-core/dist/index.js');

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return {promise, resolve};
}
function servicesOf(plugin, pluginConfig = {}, logger = {info() {}}) {
  const services = [];
  const runtime = {...config, plugins: {entries: {[plugin.id]: {config: pluginConfig}}}};
  plugin.register({config: runtime, pluginConfig, logger, registerService: service => services.push(service), registerTool() {}});
  return services;
}
function start(services) {
  return startPluginServices({config, workspaceDir: root, throwOnStartError: true,
    registry: {plugins: [], services: services.map(service => ({pluginId: service.id, id: service.id, service}))}});
}

test('OpenClaw forwards paper stop and waits for asynchronous cleanup', {timeout: 10000}, async t => {
  const cleanup = deferred();
  let online = false, starts = 0, stops = 0;
  const services = servicesOf(createPaperPlugin({serviceFactory: () => ({
    start() { starts++; online = true; },
    async stop() { stops++; await cleanup.promise; online = false; },
  })}));
  const host = await start(services);
  t.after(async () => { cleanup.resolve(); await host.stop(); });
  assert.equal(starts, 1);
  let settled = false;
  const stopping = host.stop().then(() => { settled = true; });
  await nextTurn();
  assert.equal(stops, 1, 'the real host must call the plugin stop method');
  assert.equal(settled, false, 'host stop must await the cleanup promise');
  cleanup.resolve(); await stopping;
  assert.equal(online, false);
  await host.stop(); assert.equal(stops, 1);
});

test('OpenClaw stop interrupts paper workers and queued jobs without sending or replaying', {timeout: 10000}, async t => {
  const entered = deferred(), cleanup = deferred();
  let service, calls = 0, sends = 0, notices = 0;
  const paperConfig = {root: path.join(root, 'papers'), liveTranslationEnabled: true};
  const services = servicesOf(createPaperPlugin({serviceFactory: (cfg, deps) => {
    service = new PaperService(cfg, {...deps, trace() {}, inspect: async () => ({pages: 1}),
      runner: ({signal}) => new Promise((resolve, reject) => {
        calls++; entered.resolve();
        signal.addEventListener('abort', () => { void cleanup.promise.then(() => reject(signal.reason)); }, {once: true});
      }),
      sendFile: async () => { sends++; return {status: 'platform_accepted'}; },
      notify: async () => { notices++; },
    });
    return service;
  }}), paperConfig);
  t.after(async () => { cleanup.resolve(); await service.stop(); });
  const document = await service.documents.add(pdf('Lifecycle fixture'), {filename: 'fixture.pdf'}, {inspect: async () => ({pages: 1})});
  const host = await start(services);
  t.after(() => host.stop());
  const first = service.submit({documentId: document.id}, {key: 'active', requester: service.ownerBinding});
  await entered.promise;
  const queued = service.submit({documentId: document.id}, {key: 'queued', requester: service.ownerBinding});
  let settled = false;
  const stopping = host.stop().then(() => { settled = true; });
  await nextTurn();
  assert.equal(service.online, false);
  assert.equal(service.active.controller.signal.aborted, true);
  assert.equal(settled, false);
  cleanup.resolve(); await stopping;
  assert.equal(service.active, null);
  assert.equal(service.get(first.id).status, 'interrupted');
  assert.equal(service.get(queued.id).status, 'interrupted');
  assert.deepEqual(service.queue, []);
  assert.equal(fs.existsSync(path.join(paperConfig.root, 'work', first.id)), false);
  assert.throws(() => service.submit({documentId: document.id}, {key: 'stopped', requester: service.ownerBinding}), /not running/);
  const restarted = await start(services);
  try { await nextTurn(); assert.equal(calls, 1); assert.equal(sends, 0); assert.equal(notices, 0); }
  finally { await restarted.stop(); }
});

test('OpenClaw stops mail confirmation registration and supports restart and failed startup cleanup', {timeout: 10000}, async t => {
  const before = confirmationBackendIds();
  assert(!before.includes('kurumi-mail'));
  const services = servicesOf(createMailPlugin());
  t.after(() => services[0].stop?.());
  const host = await start(services);
  assert.deepEqual(confirmationBackendIds(), [...before, 'kurumi-mail'].sort());
  await host.stop(); await host.stop(); services[0].stop?.();
  assert.deepEqual(confirmationBackendIds(), before);
  const restarted = await start(services);
  await restarted.stop();
  assert.deepEqual(confirmationBackendIds(), before);

  const external = registerConfirmationBackend({id: 'kurumi-mail', open() { throw Error('must not open'); }});
  try {
    await assert.rejects(start(servicesOf(createMailPlugin())), /plugin services failed to start/);
    assert(confirmationBackendIds().includes('kurumi-mail'), 'failed start must not remove another instance registration');
  } finally { external(); }

  await assert.rejects(start(servicesOf(createMailPlugin(), {}, {info() { throw Error('synthetic startup failure'); }})), /plugin services failed to start/);
  assert.deepEqual(confirmationBackendIds(), before, 'host must clean a registration acquired before startup failed');
});
