// Stage 4 tests: extensible coding backend adapter registry (ACP, Codex, and headless CLI drivers).
// Uses fake local subprocesses behind real Landlock write fences; never calls real external CLIs or models.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {fileURLToPath} from 'node:url';
import {fixture} from './fixtures.mjs';
import {DSH, CODEX, availableBackends, createBackendClient, describeBackends, launchOptions, selectBackend, validateBackends} from '../../plugins/kurumi-coding/backends.js';
import {AcpClient} from '../../packages/coding-runtime/acp-client.js';

const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-coding-adapters-'));
test.after(() => fs.rmSync(tmpBase, {recursive: true, force: true}));

function makeFakeCli(name, scriptBody) {
  const jsFile = path.join(tmpBase, `${name}.cjs`);
  const shFile = path.join(tmpBase, name);
  fs.writeFileSync(jsFile, scriptBody, {mode: 0o600});
  fs.writeFileSync(shFile, `#!/bin/bash\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(jsFile)} "$@"\n`, {mode: 0o700});
  return shFile;
}

test('backend registry lists presets cleanly, rejects disabled presets and unsafe env/binary paths', () => {
  const boundaryRoot = path.join(tmpBase, 'policy-boundary');
  const dshHome = path.join(boundaryRoot, 'dsh');
  const source = path.join(boundaryRoot, 'source');
  fs.mkdirSync(dshHome, {recursive: true});
  fs.mkdirSync(source, {recursive: true});

  const validCli = makeFakeCli('fake-claude.sh', 'process.exit(0);');
  const validAcp = makeFakeCli('fake-opencode.sh', 'process.exit(0);');
  const insideBin = path.join(boundaryRoot, 'evil-bin.sh');
  fs.writeFileSync(insideBin, '#!/bin/sh\nexit 0\n', {mode: 0o700});

  const cfg = {
    writeBoundary: {root: boundaryRoot, launcher: '/home/afrangry/.openclaw-fusion/tools/node-addon-system-linux-x64/bin/landlock-run'},
    root: path.join(boundaryRoot, 'state'),
    worktrees: path.join(boundaryRoot, 'worktrees'),
    dsh: {command: validAcp, home: dshHome, model: ['fixture', 'fixture']},
    backends: {
      'claude-code': {driver: 'cli', command: validCli, args: ['--headless'], promptMode: 'stdin', model: 'sonnet'},
      opencode: {driver: 'acp', command: validAcp, args: ['acp']},
    },
  };

  assert.deepEqual(availableBackends(cfg), [DSH, 'claude-code', 'opencode']);
  const details = describeBackends(cfg);
  assert.equal(details.find(b => b.id === 'claude-code')?.driver, 'cli');
  assert.equal(details.find(b => b.id === 'claude-code')?.supportsResume, false);
  assert.equal(details.find(b => b.id === 'opencode')?.driver, 'acp');
  assert.equal(details.find(b => b.id === 'opencode')?.supportsResume, true);
  assert.equal(selectBackend(cfg, 'claude-code'), 'claude-code');
  assert.throws(() => selectBackend(cfg, 'gemini-cli'), {code: 'coding_backend_not_enabled'});
  assert.throws(() => selectBackend(cfg, 'totally-unknown'), {code: 'unknown_coding_backend'});
  assert.doesNotThrow(() => validateBackends(cfg));

  // Binary inside writeBoundary.root is rejected.
  assert.throws(() => validateBackends({
    ...cfg,
    backends: {'claude-code': {driver: 'cli', command: insideBin}},
  }), {code: 'invalid_coding_backend'});

  // Sensitive/fence-overriding env keys are rejected.
  for (const key of ['PATH', 'HOME', 'LD_PRELOAD', 'GIT_CONFIG_GLOBAL']) {
    assert.throws(() => validateBackends({
      ...cfg,
      backends: {'claude-code': {driver: 'cli', command: validCli, env: {[key]: 'bad'}}},
    }), {code: 'invalid_coding_backend'});
  }
});

test('custom cli adapter runs fenced, records stdout result, denies outside writes, and cancels child tree', async t => {
  const outsideSentinel = path.join(tmpBase, 'outside-sentinel.txt');
  fs.writeFileSync(outsideSentinel, 'unchanged\n');

  const fakeCli = makeFakeCli('claude-sim.sh', `
    const fs = require('fs'), path = require('path');
    let prompt = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', d => prompt += d);
    process.stdin.on('end', () => {
      if (prompt.includes('BLOCK_WAIT')) {
        fs.writeFileSync(path.join(process.cwd(), 'waiting.marker'), 'started');
        setInterval(() => {}, 1000);
        return;
      }
      let blocked = false;
      try { fs.writeFileSync(${JSON.stringify(outsideSentinel)}, 'tampered'); }
      catch (e) { blocked = ['EACCES', 'EPERM', 'EROFS'].includes(e.code); }
      if (!blocked) process.exit(9);
      fs.writeFileSync(path.join(process.cwd(), 'value.mjs'), ${JSON.stringify('export const value = 77;\n')});
      process.stdout.write(${JSON.stringify('CLAUDE_CLI_ADAPTER_OK\n')});
    });
  `);

  const f = await fixture(t, {
    clientFactory: createBackendClient, // Use real production createBackendClient!
    configure(pluginConfig) {
      pluginConfig.backends = {
        'claude-code': {
          driver: 'cli',
          command: fakeCli,
          args: ['--non-interactive'],
          promptMode: 'stdin',
          model: 'claude-sonnet',
        },
      };
    },
  });

  const listed = await f.run({action: 'list'});
  assert(listed.backends.includes('claude-code'));
  assert(listed.backendDetails.some(b => b.id === 'claude-code' && b.driver === 'cli'));

  // Run full CLI task under real Landlock write fence.
  const started = await f.run({action: 'start', projectId: 'fixture', backend: 'claude-code', title: 'CLI 适配器测试', task: 'Set value to 77.'});
  assert.equal(started.backend, 'claude-code');
  const ready = await f.settle(started.id);
  const cliStderrPath = path.join(f.pluginConfig.root, 'tasks', started.id, 'claude-code.stderr');
  assert.equal(ready.state, 'ready', `${JSON.stringify(ready)} stderr=${fs.existsSync(cliStderrPath) ? fs.readFileSync(cliStderrPath, 'utf8') : 'none'}`);
  assert.equal(ready.checks.ok, true);
  assert.match(fs.readFileSync(path.join(ready.cwd, 'value.mjs'), 'utf8'), /value = 77/);
  assert.equal(fs.readFileSync(outsideSentinel, 'utf8'), 'unchanged\n');

  const res = await f.run({action: 'result', taskId: started.id, section: 'agent_report'});
  assert.match(res.result.page.text, /CLAUDE_CLI_ADAPTER_OK/);

  await assert.rejects(f.run({action: 'continue', taskId: started.id, backend: DSH, task: 'cannot switch'}), {code: 'coding_backend_only_for_start'});

  // Verify process tree cancellation works cleanly on CLI adapter.
  const waitTask = await f.run({action: 'start', projectId: 'fixture', backend: 'claude-code', title: '取消测试', task: 'BLOCK_WAIT'});
  for (let i = 0; i < 60 && !fs.existsSync(path.join(waitTask.cwd, 'waiting.marker')); i++) await delay(50);
  assert(fs.existsSync(path.join(waitTask.cwd, 'waiting.marker')));
  const cancelled = await f.run({action: 'cancel', taskId: waitTask.id});
  assert.equal(cancelled.state, 'cancelled');
});

test('acp adapter preset works with real AcpClient stdio peer and failed codex sandbox records diagnostic stderr cleanly', async t => {
  const acpPeer = fileURLToPath(new URL('./acp-peer.mjs', import.meta.url));
  const openCodeFake = path.join(tmpBase, 'opencode-acp-wrap.sh');
  const gates = path.join(tmpBase, 'acp-gates');
  fs.mkdirSync(gates, {recursive: true});
  fs.writeFileSync(path.join(gates, 'start'), '');
  const quote = s => `'${s.replaceAll("'", "'\\''")}'`;
  fs.writeFileSync(openCodeFake, `#!/bin/bash\nexec ${[process.execPath, acpPeer, '--completion-fixture', gates].map(quote).join(' ')}\n`, {mode: 0o700});

  const brokenCodex = makeFakeCli('broken-codex.sh', `
    if (process.argv[2] === 'sandbox') {
      process.stderr.write('landlock sandbox probe blocked by test diag\\n');
      process.exit(1);
    }
    process.exit(1);
  `);

  const f = await fixture(t, {
    clientFactory: createBackendClient, // Real AcpClient and CodexClient paths.
    configure(pluginConfig) {
      const codexHome = path.join(pluginConfig.root, 'backend', 'codex-home');
      fs.mkdirSync(codexHome, {recursive: true, mode: 0o700});
      pluginConfig.codex = {command: brokenCodex, model: 'gpt-5-codex'};
      pluginConfig.backends = {
        opencode: {driver: 'acp', command: openCodeFake, args: ['acp']},
      };
    },
  });

  // OpenCode ACP peer completes via real AcpClient and permission/edit cycle.
  const oc = await f.run({action: 'start', projectId: 'fixture', backend: 'opencode', task: 'FIXTURE_CASE_start'});
  const ocDone = await f.settle(oc.id);
  assert.equal(ocDone.backend, 'opencode');
  assert.equal(ocDone.state, 'ready');

  // Codex with failing native sandbox probe stays fail-closed and writes diagnostic stderr to private codex.stderr.
  const cx = await f.run({action: 'start', projectId: 'fixture', backend: CODEX, task: 'Attempt codex probe.'});
  const cxDone = await f.settle(cx.id);
  assert.equal(cxDone.state, 'failed');
  assert.equal(cxDone.reason, 'codex_sandbox_unavailable');
  const stderrLog = fs.readFileSync(path.join(f.pluginConfig.root, 'tasks', cx.id, 'codex.stderr'), 'utf8');
  assert.match(stderrLog, /landlock sandbox probe blocked by test diag/);
});

test('AcpClient passes string models unquoted and array models JSON-encoded; launchOptions stages opencode config and DSH web providers', async t => {
  const sentOptions = [];
  const acpPeer = fileURLToPath(new URL('./acp-peer.mjs', import.meta.url));
  const capturePeer = makeFakeCli('model-capture-peer.sh', `
    const readline = require('readline');
    readline.createInterface({input: process.stdin}).on('line', line => {
      const f = JSON.parse(line);
      if (f.method === 'initialize') process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: f.id, result: {protocolVersion: 1}}) + '\\n');
      else if (f.method === 'session/new') process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: f.id, result: {sessionId: 's-1'}}) + '\\n');
      else if (f.method === 'session/set_config_option') {
        require('fs').appendFileSync(process.env.MODEL_LOG, f.params.value + '\\n');
        process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: f.id, result: {}}) + '\\n');
      } else if (f.method === 'session/close') process.stdout.write(JSON.stringify({jsonrpc: '2.0', id: f.id, result: {}}) + '\\n');
    });
  `);
  const modelLog = path.join(tmpBase, 'model-options.log');
  fs.writeFileSync(modelLog, '');

  const strClient = new AcpClient({command: capturePeer, args: [], cwd: tmpBase, env: {...process.env, MODEL_LOG: modelLog}, stderrFile: path.join(tmpBase, 'str.stderr')});
  await strClient.initialize();
  await strClient.open(tmpBase, {model: 'volc-ark/deepseek-v4-1-flash-economy-261017'});
  await strClient.closeSession();
  await strClient.stop();

  const arrClient = new AcpClient({command: capturePeer, args: [], cwd: tmpBase, env: {...process.env, MODEL_LOG: modelLog}, stderrFile: path.join(tmpBase, 'arr.stderr')});
  await arrClient.initialize();
  await arrClient.open(tmpBase, {model: ['volc-ark', 'deepseek-v4-1-flash-economy-261017']});
  await arrClient.closeSession();
  await arrClient.stop();

  const recorded = fs.readFileSync(modelLog, 'utf8').trim().split('\n');
  assert.deepEqual(recorded, [
    'volc-ark/deepseek-v4-1-flash-economy-261017',
    '["volc-ark","deepseek-v4-1-flash-economy-261017"]',
  ]);
  void sentOptions;
  void acpPeer;

  // launchOptions with opencode configFile and DSH web llm-pi-ai inheritance.
  const f = await fixture(t, {
    configure(pluginConfig) {
      const dshProfiles = path.join(pluginConfig.dsh.home, 'profiles');
      fs.mkdirSync(path.join(dshProfiles, 'acp'), {recursive: true});
      fs.mkdirSync(path.join(dshProfiles, 'web'), {recursive: true});
      fs.writeFileSync(path.join(dshProfiles, 'acp', 'cordis.patch.yml'), '[]\n');
      fs.writeFileSync(path.join(dshProfiles, 'web', 'cordis.patch.yml'), '- id: ui\n  x: 1\n- id: llm-pi-ai\n  name: test\n  config:\n    providers:\n      volc-ark:\n        api: openai-completions\n- id: locale\n  x: 2\n');
      const ocSrc = path.join(tmpBase, 'opencode.source.json');
      fs.writeFileSync(ocSrc, JSON.stringify({provider: {'volc-ark': {options: {baseURL: 'https://example.invalid/v1'}}}}, null, 2));
      pluginConfig.dsh.model = ['volc-ark', 'deepseek-v4-1-flash-economy-261017'];
      pluginConfig.backends = {
        opencode: {driver: 'acp', command: capturePeer, args: ['acp'], model: 'volc-ark/deepseek-v4-1-flash-economy-261017', configFile: ocSrc},
      };
    },
  });

  const dshTaskDir = path.join(f.pluginConfig.root, 'tasks', 't-dsh');
  fs.mkdirSync(dshTaskDir, {recursive: true});
  const dshLaunch = launchOptions(f.pluginConfig, {id: 't-dsh', cwd: f.source, backend: DSH}, dshTaskDir, process.env);
  assert.deepEqual(dshLaunch.model, ['volc-ark', 'deepseek-v4-1-flash-economy-261017']);
  const dshPatch = fs.readFileSync(path.join(dshTaskDir, 'acp.patch.yml'), 'utf8');
  assert.match(dshPatch, /- id: llm-pi-ai/);
  assert.doesNotMatch(dshPatch, /- id: locale/);

  const ocTaskDir = path.join(f.pluginConfig.root, 'tasks', 't-oc');
  fs.mkdirSync(ocTaskDir, {recursive: true});
  const ocLaunch = launchOptions(f.pluginConfig, {id: 't-oc', cwd: f.source, backend: 'opencode'}, ocTaskDir, process.env);
  assert.equal(ocLaunch.model, 'volc-ark/deepseek-v4-1-flash-economy-261017');
  const stagedFile = path.join(f.pluginConfig.root, 'backend', 'opencode-home', '.config', 'opencode', 'opencode.json');
  assert.equal(fs.statSync(stagedFile).mode & 0o777, 0o600);
  const staged = JSON.parse(fs.readFileSync(stagedFile, 'utf8'));
  assert.equal(staged.permission.edit, 'allow');
  assert.equal(staged.permission.bash, 'allow');
  assert.equal(staged.permission.external_directory, 'deny');
  assert.equal(staged.permission.webfetch, 'deny');
  const sourceAfter = JSON.parse(fs.readFileSync(path.join(tmpBase, 'opencode.source.json'), 'utf8'));
  assert.equal(sourceAfter.permission, undefined);
});
