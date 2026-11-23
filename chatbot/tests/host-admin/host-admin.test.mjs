// Offline unit and lifecycle tests for kurumi-host-admin (docs/37 Stage 1).
// Uses temporary SQLite and stubbed process runners; never invokes real sudo or systemd.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {after, test} from 'node:test';
import {fileURLToPath, pathToFileURL} from 'node:url';
import * as core from '../../packages/confirmation-core/dist/index.js';
import {ownerPolicy, memberRow, context} from '../access-control/fixtures.mjs';
import {ownerInvocation} from '../../plugins/kurumi-host-admin/inbound.js';
import {createHostAdminPlugin} from '../../plugins/kurumi-host-admin/index.js';
import {
  buildActionPreview, parseSystemctlShow, validateHostAdminConfig,
} from '../../plugins/kurumi-host-admin/policy.js';
import {createHostAdminService} from '../../plugins/kurumi-host-admin/service.js';
import {HostAdminStore} from '../../plugins/kurumi-host-admin/store.js';
import {validateTemplateTarget} from '../../plugins/kurumi-host-admin/templates.js';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kurumi-host-admin-test-'));
after(() => fs.rmSync(tmpRoot, {recursive: true, force: true}));

const fakeSudo = path.join(tmpRoot, 'sudo-stub');
const fakeSystemctl = path.join(tmpRoot, 'systemctl-stub');
for (const file of [fakeSudo, fakeSystemctl]) {
  fs.writeFileSync(file, '#!/bin/sh\nexit 0\n', {mode: 0o700});
}

const baseConfig = () => ({
  sudoCommand: fakeSudo,
  systemctlCommand: fakeSystemctl,
  timeoutMs: 5000,
  proposalTtlSeconds: 1800,
  actions: [{
    id: 'restart_todeskd',
    template: 'service.restart',
    target: 'todeskd.service',
    label: '重启远程桌面服务',
    impact: '重启期间远程桌面连接会短暂断开并需重新连接。',
    leaseEligible: false,
  }],
});

const makeActor = (qq = '365999865') => {
  const row = ownerPolicy(qq).subjects[0];
  const ctx = context(row);
  const scope = core.scopeFromToolContext(ctx);
  return {
    row,
    ctx,
    actor: {id: qq, owner: true},
    scope,
    inbound(text = '确认') {
      return {
        channel: 'kurumi-qq',
        accountId: 'default',
        senderId: qq,
        conversationId: `user:${qq}`,
        sessionKey: ctx.sessionKey,
        messageId: 'msg-' + Math.random().toString(16).slice(2),
        timestamp: this.nowMs,
        content: text,
        isGroup: false,
      };
    },
    nowMs: 1_800_000_000_000,
  };
};

test('validateHostAdminConfig rejects unknown templates, bad unit names, duplicates and unsafe paths', () => {
  const valid = validateHostAdminConfig(baseConfig(), validateTemplateTarget);
  assert.equal(valid.actions.length, 1);
  assert.equal(valid.byId.get('restart_todeskd').leaseEligible, false);

  const badConfigs = [
    null,
    {...baseConfig(), extraKey: true},
    {...baseConfig(), actions: []},
    {...baseConfig(), timeoutMs: 100},
    {...baseConfig(), proposalTtlSeconds: 10},
    {...baseConfig(), sudoCommand: 'sudo'},
    {...baseConfig(), sudoCommand: path.join(tmpRoot, '..', 'missing-sudo')},
    {...baseConfig(), sudoCommand: tmpRoot},
    {...baseConfig(), actions: [{...baseConfig().actions[0], template: 'shell.exec'}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], target: 'todeskd.timer'}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], target: '..evil.service'}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], target: '-flag.service'}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], target: '.hidden.service'}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], id: 'BadId'}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], label: ''}]},
    {...baseConfig(), actions: [{...baseConfig().actions[0], leaseEligible: 'yes'}]},
    {...baseConfig(), actions: [baseConfig().actions[0], baseConfig().actions[0]]},
  ];
  for (const cfg of badConfigs) {
    assert.throws(() => validateHostAdminConfig(cfg, validateTemplateTarget));
  }
});

test('buildActionPreview produces short human-readable QQ facts without UUID, SHA256 or raw paths', () => {
  const cfg = validateHostAdminConfig(baseConfig(), validateTemplateTarget);
  const {previewText, presentationFacts} = buildActionPreview(cfg.actions[0], {
    available: true,
    ActiveState: 'active',
    SubState: 'running',
    MainPID: '4123',
    ExecMainStartTimestamp: 'Tue 2026-11-24 00:10:00 CST',
  });
  assert.equal(presentationFacts.join('\n'), previewText);
  assert(previewText.length < 220, `preview too long: ${previewText.length}`);
  assert(previewText.includes('重启远程桌面服务'));
  assert(previewText.includes('todeskd.service'));
  assert(!/[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}/iu.test(previewText));
  assert(!/[a-f0-9]{32,}/iu.test(previewText));
  assert(!previewText.includes('/usr/bin/'));
  assert(!previewText.includes(tmpRoot));
});

test('parseSystemctlShow extracts only expected unit state fields', () => {
  const parsed = parseSystemctlShow('LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=778\nIgnoredKey=secret\n');
  assert.deepEqual(parsed, {LoadState: 'loaded', ActiveState: 'active', SubState: 'running', MainPID: '778'});
});

test('service enforces preview delivery, natural confirmation, no-replay, drift detection and owner isolation', async t => {
  const stateRoot = fs.mkdtempSync(path.join(tmpRoot, 'state-'));
  let nowMs = 1_800_000_000_000;
  const store = new HostAdminStore(stateRoot, () => nowMs);
  const off = core.registerConfirmationBackend({
    id: 'test-kurumi-host-admin',
    open: () => ({
      natural: store.natural,
      listInboundConfirmationCandidates: () => [],
      recordInboundConfirmation: () => false,
      close() {},
    }),
  });
  t.after(() => {
    off();
    store.close();
  });

  let pid = 1001;
  const execCalls = [];
  const runner = {
    async run({command, args}) {
      if (command === fakeSystemctl && args[0] === 'show') {
        return {
          ok: true, exitCode: 0, signal: null, timedOut: false, stderr: '',
          stdout: `LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=${pid}\nExecMainStartTimestamp=T${pid}\nUnitFileState=enabled\n`,
        };
      }
      if (command === fakeSudo) {
        execCalls.push({command, args});
        pid += 1;
        return {ok: true, exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: ''};
      }
      throw Error(`unexpected command ${command}`);
    },
  };

  let activeConfig = baseConfig();
  const traces = [];
  const service = createHostAdminService(() => activeConfig, store, {runner, trace: ev => traces.push(ev)});
  const helper = makeActor();
  helper.nowMs = nowMs;
  const req = {actor: helper.actor, scope: helper.scope, check() {}, correlation: {runId: 'run-1', sessionKey: helper.ctx.sessionKey}};

  // 1. Member and non-main contexts are rejected at boundary.
  const memberCfg = {channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: {...ownerPolicy(helper.row.qq), subjects: [helper.row, memberRow()]}}}};
  assert.throws(() => ownerInvocation(context(memberRow()), memberCfg, {action: 'list'}), {code: 'capability_not_allowed'});
  assert.throws(() => ownerInvocation({...helper.ctx, agentId: 'researcher'}, memberCfg, {action: 'list'}), {code: 'untrusted_identity_context'});

  // 2. List & propose.
  const listed = await service({action: 'list'}, memberCfg, req);
  assert.equal(listed.ok, true);
  assert.equal(listed.actions[0].id, 'restart_todeskd');
  assert.equal(listed.actions[0].leaseEligible, false);

  const proposed = await service({action: 'propose', actionId: 'restart_todeskd'}, memberCfg, req);
  assert.equal(proposed.ok, true);
  assert.equal(proposed.status, 'pending');
  assert.equal(proposed.domain, 'host_sudo');
  assert.equal(proposed.beforeState.MainPID, '1001');
  assert.equal(traces.at(-1).kind, 'host_admin.proposed');

  // 3. Unconfirmed commit fails without calling sudo.
  await assert.rejects(() => service({action: 'commit', proposalId: proposed.proposalId}, memberCfg, req), {code: 'approval_required'});
  assert.equal(execCalls.length, 0);

  // 4. Present preview via confirmation-core, then test config drift detection.
  const previewEvent = helper.inbound('请求重启');
  assert.equal(core.prepareConfirmationPreview(previewEvent, {
    domain: 'host_sudo', proposalId: proposed.proposalId, payloadHash: proposed.payloadHash,
  }, proposed.previewText, proposed.presentationFacts), true);
  core.recordConfirmationDelivery({
    accountId: 'default',
    conversationId: previewEvent.conversationId,
    sourceMessageId: previewEvent.messageId,
    messageId: 'qq-preview-1',
    text: proposed.previewText,
  });

  nowMs += 2000;
  const confirmEvent = {...helper.inbound('确认'), timestamp: nowMs};
  core.captureNaturalConfirmationRequest(confirmEvent);
  const auth = core.confirmNaturalProposal(confirmEvent, {
    domain: 'host_sudo', proposalId: proposed.proposalId, payloadHash: proposed.payloadHash,
  }, nowMs);
  assert.equal(auth.ok, true);

  activeConfig = {...baseConfig(), actions: [{...baseConfig().actions[0], target: 'other.service'}]};
  await assert.rejects(() => service({action: 'commit', proposalId: proposed.proposalId}, memberCfg, req), {code: 'host_admin_action_changed'});
  assert.equal((await service({action: 'status', proposalId: proposed.proposalId}, memberCfg, req)).status, 'stale');
  assert.equal(execCalls.length, 0);

  // 5. Restore config and commit cleanly.
  activeConfig = baseConfig();
  const committed = await service({action: 'commit', proposalId: proposed.proposalId}, memberCfg, req);
  assert.equal(committed.ok, true);
  assert.equal(committed.status, 'succeeded');
  assert.equal(committed.verification.pidChanged, true);
  assert.equal(committed.beforeState.MainPID, '1001');
  assert.equal(committed.afterState.MainPID, '1002');
  assert.equal(committed.feedback.action, 'host_admin.service.restart');
  assert.equal(committed.feedback.status, 'succeeded');
  assert.deepEqual(execCalls, [{command: fakeSudo, args: ['-n', '--', fakeSystemctl, 'restart', 'todeskd.service']}]);
  assert.equal(traces.at(-1).kind, 'host_admin.executed');

  // 6. Replay is refused and never invokes sudo again.
  await assert.rejects(() => service({action: 'commit', proposalId: proposed.proposalId}, memberCfg, req), {code: 'host_admin_already_submitted'});
  assert.equal(execCalls.length, 1);

  const st = await service({action: 'status', proposalId: proposed.proposalId}, memberCfg, req);
  assert.equal(st.status, 'succeeded');
  assert.equal(st.afterState.MainPID, '1002');
  assert.equal(st.currentState.MainPID, '1002');

  // 7. Expiration check.
  const expProp = await service({action: 'propose', actionId: 'restart_todeskd'}, memberCfg, req);
  nowMs += 2000 * 1000;
  await assert.rejects(() => service({action: 'commit', proposalId: expProp.proposalId}, memberCfg, req), {code: 'host_admin_proposal_expired'});
  assert.equal((await service({action: 'status', proposalId: expProp.proposalId}, memberCfg, req)).status, 'expired');
});

test('failed or timed-out execution consumes approval grant and refuses replay', async t => {
  for (const mode of ['sudo-fail', 'timeout', 'inactive-after']) {
    const stateRoot = fs.mkdtempSync(path.join(tmpRoot, `fail-${mode}-`));
    let nowMs = 1_800_000_000_000;
    const store = new HostAdminStore(stateRoot, () => nowMs);
    const off = core.registerConfirmationBackend({
      id: `test-host-admin-${mode}`,
      open: () => ({
        natural: store.natural,
        listInboundConfirmationCandidates: () => [],
        recordInboundConfirmation: () => false,
        close() {},
      }),
    });
    t.after(() => {
      off();
      store.close();
    });

    let sudoRuns = 0;
    let inspectedAfter = false;
    const runner = {
      async run({command}) {
        if (command === fakeSystemctl) {
          const active = mode === 'inactive-after' && inspectedAfter ? 'failed' : 'active';
          return {
            ok: true, exitCode: 0, signal: null, timedOut: false, stderr: '',
            stdout: `LoadState=loaded\nActiveState=${active}\nSubState=running\nMainPID=200\n`,
          };
        }
        sudoRuns += 1;
        inspectedAfter = true;
        if (mode === 'timeout') return {ok: false, exitCode: null, signal: 'SIGTERM', timedOut: true, stdout: '', stderr: ''};
        if (mode === 'sudo-fail') return {ok: false, exitCode: 1, signal: null, timedOut: false, stdout: '', stderr: 'a password is required'};
        return {ok: true, exitCode: 0, signal: null, timedOut: false, stdout: '', stderr: ''};
      },
    };
    const service = createHostAdminService(baseConfig(), store, {runner, trace() {}});
    const helper = makeActor();
    const req = {actor: helper.actor, scope: helper.scope, check() {}};
    const memberCfg = {channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: ownerPolicy(helper.row.qq)}}};

    const proposed = await service({action: 'propose', actionId: 'restart_todeskd'}, memberCfg, req);
    const pv = {...helper.inbound('preview'), timestamp: nowMs};
    core.prepareConfirmationPreview(pv, {domain: 'host_sudo', proposalId: proposed.proposalId, payloadHash: proposed.payloadHash},
      proposed.previewText, proposed.presentationFacts);
    core.recordConfirmationDelivery({
      accountId: 'default', conversationId: pv.conversationId, sourceMessageId: pv.messageId, messageId: 'pv-' + mode, text: proposed.previewText,
    });
    nowMs += 2000;
    const cf = {...helper.inbound('确认'), timestamp: nowMs};
    core.captureNaturalConfirmationRequest(cf);
    assert.equal(core.confirmNaturalProposal(cf, {
      domain: 'host_sudo', proposalId: proposed.proposalId, payloadHash: proposed.payloadHash,
    }, nowMs).ok, true);

    const committed = await service({action: 'commit', proposalId: proposed.proposalId}, memberCfg, req);
    assert.equal(committed.ok, false);
    assert.equal(committed.status, mode === 'timeout' ? 'unknown' : 'failed');
    assert.equal(committed.code, mode === 'timeout' ? 'host_admin_exec_timeout'
      : mode === 'sudo-fail' ? 'host_admin_sudo_failed' : 'host_admin_post_check_failed');
    assert.equal(sudoRuns, 1);

    await assert.rejects(() => service({action: 'commit', proposalId: proposed.proposalId}, memberCfg, req), {code: 'host_admin_already_submitted'});
    assert.equal(sudoRuns, 1);
  }
});

test('OpenClaw service manager starts/stops kurumi-host-admin and cleans up confirmation backend', async t => {
  const sdkDist = path.dirname(fileURLToPath(import.meta.resolve('openclaw')));
  const bundles = fs.readdirSync(sdkDist).filter(name => /^services-.*\.mjs$/.test(name)
    && fs.readFileSync(path.join(sdkDist, name), 'utf8').includes('function startPluginServices('));
  assert.equal(bundles.length, 1);
  const manager = await import(pathToFileURL(path.join(sdkDist, bundles[0])).href);
  const {GatewayScheduler} = await import(pathToFileURL(path.join(sdkDist, 'infra/gateway-scheduler.js')).href);
  const startPluginServices = Object.values(manager).find(value => typeof value === 'function' && value.name === 'startPluginServices');

  const stateRoot = fs.mkdtempSync(path.join(tmpRoot, 'lifecycle-'));
  const pluginCfg = baseConfig();
  const cfg = {plugins: {entries: {'kurumi-host-admin': {enabled: true, config: pluginCfg}}}};
  const plugin = createHostAdminPlugin({trace() {}});

  const discoveryTools = [];
  plugin.register({
    config: cfg, pluginConfig: pluginCfg, registrationMode: 'discovery',
    logger: {info() {}, warn() {}},
    registerService() { throw Error('discovery must not register service'); },
    registerTool(factory) { discoveryTools.push(factory); },
  });
  assert.equal(discoveryTools.length, 1);

  const services = [];
  let toolFactory;
  plugin.register({
    config: cfg, pluginConfig: pluginCfg, registrationMode: 'full',
    logger: {info() {}, warn() {}},
    runtime: {state: {resolveStateDir: () => stateRoot}},
    registerService(service) { services.push(service); },
    registerTool(factory) { toolFactory = factory; },
  });
  const before = core.confirmationBackendIds();
  const host = await startPluginServices({
    scheduler: new GatewayScheduler(), config: cfg, workspaceDir: stateRoot, throwOnStartError: true,
    registry: {plugins: [], services: services.map(service => ({pluginId: service.id, id: service.id, service}))},
  });
  t.after(() => host.stop());
  assert.deepEqual(core.confirmationBackendIds(), [...before, 'kurumi-host-admin'].sort());

  await host.stop();
  assert.deepEqual(core.confirmationBackendIds(), before);

  const helper = makeActor();
  const tool = toolFactory.create({
    ...helper.ctx,
    getRuntimeConfig: () => ({channels: {'kurumi-qq': {ownerId: helper.row.qq, accessControl: ownerPolicy(helper.row.qq)}}}),
  });
  const stoppedRes = await tool.execute('call-stopped', {action: 'list'});
  assert.deepEqual(stoppedRes.details, {ok: false, code: 'host_admin_unavailable'});
});
