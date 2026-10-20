// Offline architecture/registration regressions; isolated SQLite and the installed
// OpenClaw service manager. No API/model/QQ/SMTP or production service operations.
// Evidence: docs/verification/capability-decoupling-2026-10-20/README.md
import {test, after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {spawnSync} from 'node:child_process';
import {setImmediate as nextTurn} from 'node:timers/promises';
import {withAccess, context, ownerPolicy} from '../access-control/fixtures.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-capabilities-'));
const previous = Object.fromEntries(['OPENCLAW_STATE_DIR', 'OPENCLAW_CONFIG_PATH'].map(k => [k, process.env[k]]));
process.env.OPENCLAW_STATE_DIR = root;
process.env.OPENCLAW_CONFIG_PATH = path.join(root, 'config.json');
const cfg = withAccess({logging: {level: 'silent', file: path.join(root, 'host.log')}}, '100001');
fs.writeFileSync(process.env.OPENCLAW_CONFIG_PATH, JSON.stringify(cfg));
after(() => {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(root, {recursive: true, force: true});
});

const core = await import('../../packages/confirmation-core/dist/index.js');
const {WeatherStore} = await import('../../packages/personal-domains/dist/store.js');
const {proposePlanningChange, commitPlanningProposal} = await import('../../packages/personal-domains/dist/planning.js');
const {proposeProfileChange, commitProfileChange} = await import('../../packages/personal-domains/dist/profile.js');
const {geoLookupFixture} = await import('../../packages/personal-domains/dist/test-fixtures.js');
const {registerDomainBackend} = await import('../../packages/personal-domains/dist/confirmation-backends.js');
const {createReminderReconcilerService} = await import('../../packages/personal-domains/dist/reminder-reconciler-service.js');
const kinds = {weather: 1, profile: 3, planning: 3, reminder: 7};
const entries = Object.fromEntries(await Promise.all(Object.keys(kinds).map(async kind =>
  [kind, (await import(`../../packages/personal-domains/dist/${kind}-plugin.js`)).createPlugin])));
const sdkDist = path.dirname(fileURLToPath(import.meta.resolve('openclaw')));
const bundles = fs.readdirSync(sdkDist).filter(name => /^services-.*\.mjs$/.test(name)
  && fs.readFileSync(path.join(sdkDist, name), 'utf8').includes('function startPluginServices('));
assert.equal(bundles.length, 1, 'Pinned Host service-manager layout changed');
const manager = await import(pathToFileURL(path.join(sdkDist, bundles[0])).href);
const startServices = Object.values(manager).find(fn => typeof fn === 'function' && fn.name === 'startPluginServices');

function collect(plugin, mode = 'full') {
  const tools = new Map(), services = [], hooks = [];
  plugin.register({config: cfg, pluginConfig: {}, registrationMode: mode,
    on(name, handler) { hooks.push({name, handler}); }, logger: {info() {}, warn() {}},
    registerTool(factory, options) { tools.set(options.name, factory); },
    registerService(service) { services.push(service); },
  });
  return {tools, services, hooks};
}
async function start(services) {
  return startServices({config: cfg, workspaceDir: root, throwOnStartError: true,
    registry: {plugins: [], services: services.map(service => ({pluginId: service.id, id: service.id, service}))}});
}

test('shared packages have no runtime imports into plugins or deployment scripts', () => {
  const directory = fileURLToPath(new URL('../../packages/', import.meta.url));
  const files = [];
  function visit(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      if (['dist', 'node_modules'].includes(e.name)) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) visit(file);
      else if (/\.(?:js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(file);
    }
  }
  visit(directory);
  for (const file of files) {
    const source = fs.readFileSync(file, 'utf8');
    const imports = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)];
    for (const [, specifier] of imports) if (specifier.startsWith('.')) {
      const resolved = path.resolve(path.dirname(file), specifier);
      assert(!resolved.includes('/chatbot/plugins/') && !resolved.includes('/scripts/'), `${file}: ${specifier}`);
      // TypeScript emits .js references; source exists as .ts before building.
      assert(fs.existsSync(resolved) || fs.existsSync(resolved.replace(/\.js$/, '.ts')), `${file}: missing ${specifier}`);
    }
  }
});

test('plugins reach other plugins only through public entries, never their src internals', () => {
  const root = fileURLToPath(new URL('../../plugins/', import.meta.url));
  // Public outward interfaces another plugin's composition entry may wire (docs/21).
  const publicEntries = new Set([path.join(root, 'kurumi-qq', 'delivery.js')]);
  const files = [];
  function visit(dir) {
    for (const e of fs.readdirSync(dir, {withFileTypes: true})) {
      if (['dist', 'node_modules', 'vendor', 'test', 'python'].includes(e.name)) continue;
      const file = path.join(dir, e.name);
      if (e.isDirectory()) visit(file);
      else if (/\.(?:js|mjs|ts)$/.test(e.name) && !/\.test\./.test(e.name)) files.push(file);
    }
  }
  visit(root);
  let crossings = 0;
  for (const file of files) {
    const own = path.relative(root, file).split(path.sep)[0];
    const source = fs.readFileSync(file, 'utf8');
    for (const [, specifier] of source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/g)) {
      if (!specifier.startsWith('.')) continue;
      const resolved = path.resolve(path.dirname(file), specifier);
      if (!resolved.startsWith(root) || path.relative(root, resolved).split(path.sep)[0] === own) continue;
      crossings++;
      assert(publicEntries.has(resolved), `${file}: ${specifier}`);
    }
  }
  assert(crossings > 0, 'scan must see the papers -> QQ delivery wiring');
});

test('four independently discovered entries register exactly their manifest tools', () => {
  const all = [];
  for (const [kind, create] of Object.entries(entries)) {
    const plugin = create(), found = collect(plugin, 'discovery');
    const manifest = JSON.parse(fs.readFileSync(new URL(`../../plugins/${plugin.id}/openclaw.plugin.json`, import.meta.url)));
    assert.equal(found.tools.size, kinds[kind]);
    assert.deepEqual([...found.tools.keys()].sort(), manifest.contracts.tools.slice().sort());
    assert.equal(found.services.length, 0, 'discovery must not install background services');
    assert.equal(found.hooks.length, 0);
    all.push(...found.tools.keys());
  }
  assert.equal(new Set(all).size, 14);
});

test('installed Host starts/stops each domain independently without removing sibling registrations', async () => {
  const before = core.confirmationBackendIds(), hosts = [];
  try {
    for (const kind of ['weather', 'profile', 'planning', 'reminder']) hosts.push(await start(collect(entries[kind]()).services));
    assert.deepEqual(core.confirmationBackendIds(), [...before, 'personal-profile', 'personal-planning', 'personal-reminder'].sort());
    await hosts[1].stop();
    assert.deepEqual(core.confirmationBackendIds(), [...before, 'personal-planning', 'personal-reminder'].sort());
    await hosts[2].stop();
    assert.deepEqual(core.confirmationBackendIds(), [...before, 'personal-reminder'].sort());
  } finally { for (const host of hosts.reverse()) await host.stop(); }
  assert.deepEqual(core.confirmationBackendIds(), before);
  const restarted = await start(collect(entries.profile()).services);
  await restarted.stop();
  assert.deepEqual(core.confirmationBackendIds(), before);
});

test('installed Host waits for an in-flight reminder maintenance pass on stop', async t => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const service = createReminderReconcilerService({stateDirectory: path.join(root, 'maintenance-fixture'), scheduler: {
    async reconcile() {
      entered(); await gate;
      return {scanned: 0, jobsAdopted: 0, delivered: 0, failed: 0, warnings: []};
    }, add() { throw Error('no reminder to schedule'); }, remove() { throw Error('no reminder to remove'); },
  }});
  const host = await start([service]);
  t.after(async () => { release(); await host.stop(); });
  await started;
  let stopped = false;
  const pending = host.stop().then(() => { stopped = true; });
  await nextTurn(); assert.equal(stopped, false);
  release(); await pending;
  assert.equal(stopped, true);
});

test('shared historical DB proposals survive the split while disabled domains cannot issue grants', async t => {
  const now = Math.floor(Date.now() / 1000), stateDirectory = path.join(root, 'confirm-fixture');
  const store = new WeatherStore({stateDirectory, now: () => now});
  t.after(() => store.close());
  const scope = core.scopeFromToolContext(context(ownerPolicy('100001').subjects[0]));
  const trip = proposePlanningChange(store, {schema_version: 1, request: {kind: 'trip.create', destination: {text: '南京'}}}, scope);
  const profile = await proposeProfileChange(store, {lookupPlace: async () => ({...geoLookupFixture,
    location: [{...geoLookupFixture.location[0], name: '扬中', id: '101190704', lat: '32.2373', lon: '119.8281', adm1: '江苏省', adm2: '镇江市'}]})}, {
    schema_version: 1, request: {kind: 'current_location.set', location: {text: '扬中市'}}}, undefined, scope);
  assert.equal(trip.ok, true); assert.equal(profile.status, 'pending');
  const services = [];
  for (const [id, domain] of [['personal-profile', 'personal_profile'], ['personal-planning', 'planning']]) {
    registerDomainBackend({registerService: s => services.push(s)}, {id, domain, open: () => new WeatherStore({stateDirectory, now: () => now})});
  }
  t.after(() => services.forEach(s => s.stop()));
  services.forEach(s => s.start());
  const event = proposal => ({channel: 'kurumi-qq', senderId: '100001', accountId: 'default',
    conversationId: 'user:100001', sessionKey: context(ownerPolicy('100001').subjects[0]).sessionKey,
    messageId: 'message-' + proposal.proposalId, timestamp: now, isGroup: false,
    content: core.buildConfirmationInstruction(proposal.proposalId, proposal.payloadHash)});
  assert.equal(core.recordRegisteredConfirmation(event(profile), () => {}), 'recorded');
  assert.equal(commitProfileChange(store, {proposal_id: profile.proposalId, payload_hash: profile.payloadHash}, scope).ok, true);
  services[1].stop();
  assert.equal(core.recordRegisteredConfirmation(event(trip), () => {}), 'no_match');
  assert.equal(commitPlanningProposal(store, {proposal_id: trip.proposalId, payload_hash: trip.payloadHash}, scope).error.code, 'approval_required');
  services[1].start();
  assert.equal(core.recordRegisteredConfirmation(event(trip), () => {}), 'recorded');
  assert.equal(commitPlanningProposal(store, {proposal_id: trip.proposalId, payload_hash: trip.payloadHash}, scope).ok, true);
});

test('recording cannot bypass the per-domain candidate filter', () => {
  let recorded = 0, service;
  // The provider opens through the public registry; route a planning proposal
  // with only Profile enabled and prove record is unreachable.
  registerDomainBackend({registerService: s => service = s}, {id: 'filtered-profile', domain: 'personal_profile', open: () => ({
    listInboundConfirmationCandidates: () => [{domain: 'planning', proposalId: 'foreign'}],
    recordInboundConfirmation() { recorded++; return true; }, close() {},
  })});
  service.start();
  try {
    const event = {channel: 'qqbot', conversationId: 'qqbot:c2c:fixture', messageId: 'filtered', isGroup: false,
      content: '确认 abcdef123456'};
    assert.equal(core.recordRegisteredConfirmation(event, () => {}), 'no_match');
    assert.equal(recorded, 0);
  } finally { service.stop(); }
});

test('owner authorization is unchanged across all split tool factories', async () => {
  for (const create of Object.values(entries)) for (const factory of collect(create(), 'discovery').tools.values()) {
    const ctx = {...context(ownerPolicy('100001').subjects[0]), requesterSenderId: '100002', senderIsOwner: false,
      getRuntimeConfig: () => cfg};
    await assert.rejects(factory.create(ctx).execute('forbidden', {}), /identity_not_enabled/);
  }
});

test('old Cron CLI addresses and new reminder CLI execute the same implementation in isolation', () => {
  for (const [plugin, entry] of [['personal-weather', 'cli'], ['personal-weather', 'reminder-cli'], ['personal-reminders', 'reminder-cli']]) {
    const file = fileURLToPath(new URL(`../../plugins/${plugin}/dist/${entry}.js`, import.meta.url));
    const child = spawnSync(process.execPath, [file], {env: {...process.env}, encoding: 'utf8', timeout: 20000});
    assert.equal(child.status, 2, child.stderr);
    if (entry === 'cli') assert.equal(JSON.parse(child.stdout).code, 'USAGE');
    else { assert.equal(child.stdout, ''); assert.match(child.stderr, /usage: reminder-cli deliver/); }
  }
});
