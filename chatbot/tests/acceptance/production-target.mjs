// Read-only observations of the active service. No test messages or state mutation.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {isDeepStrictEqual, promisify} from 'node:util';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {accessPolicy, agentFor, allowedMembers, MEMBER_TOOLS, sessionFor} from '../../packages/access-control/index.js';
import {validateWriteFence, writeFenceRoots} from '../../packages/coding-runtime/write-fence.js';

const exec = promisify(execFile);
const fields = text => Object.fromEntries(text.trim().split('\n').map(line => {
  const at = line.indexOf('=');
  return [line.slice(0, at), line.slice(at + 1)];
}));

const toolsOf = catalog => [...new Set(catalog.groups.flatMap(group => group.tools.map(tool => tool.id)))].sort();
const entriesOf = cfg => cfg.plugins.entries;
function accessProjection(cfg) {
  const entries = entriesOf(cfg);
  const memberAgents = Object.fromEntries(Object.entries(cfg.agents.entries).filter(([id]) => /^qq-user-\d+$/u.test(id)));
  return {
    policy: accessPolicy(cfg),
    testIngress: cfg.channels['kurumi-qq'].testIngress,
    memberAgents,
    bindings: cfg.bindings.filter(binding => /^qq-user-\d+$/u.test(binding.agentId)),
    ownerTools: cfg.agents.entries.main.tools,
    globalDeny: cfg.tools.deny,
    admin: entries['kurumi-access-admin'].config,
    recipients: entries['kurumi-mail'].config.allowedRecipients,
    exec: entries['kurumi-host-control'].config.exec,
    projects: entries['kurumi-coding'].config.projects,
    projectWriteBoundary: entries['kurumi-coding'].config.writeBoundary,
    hostAdmin: entries['kurumi-host-admin']?.config,
  };
}

async function appliedAccessConfig(rpc, configFile, cfg) {
  const snapshot = await rpc('config.get');
  if (snapshot.path !== configFile || snapshot.valid !== true || typeof snapshot.appliedConfigHash !== 'string'
    || snapshot.configRevisionHash !== snapshot.appliedConfigHash
    || !isDeepStrictEqual(accessProjection(snapshot.config), accessProjection(cfg))) {
    throw Error('active_access_config_mismatch');
  }
  return snapshot.appliedConfigHash;
}
async function serviceIdentity(port) {
  const service = fields((await exec('/usr/bin/systemctl', ['--user', 'show', 'kurumi-fusion.service',
    '--property=ActiveState,MainPID,InvocationID,ControlGroup'], {timeout: 5000})).stdout);
  if (service.ActiveState !== 'active' || !service.ControlGroup.endsWith('/kurumi-fusion.service')) throw Error('production_service_inactive');
  const {stdout} = await exec('/usr/bin/ss', ['-H', '-ltnp', 'sport = :' + port], {timeout: 5000});
  const pids = [...new Set([...stdout.matchAll(/pid=(\d+)/gu)].map(match => Number(match[1])))];
  if (pids.length !== 1) throw Error('production_listener_ambiguous');
  const [pid] = pids;
  const cgroups = readFileSync('/proc/' + pid + '/cgroup', 'utf8').trim().split('\n');
  if (!cgroups.some(line => line.slice(line.indexOf(':', line.indexOf(':') + 1) + 1) === service.ControlGroup)) {
    throw Error('production_listener_service_mismatch');
  }
  const stat = readFileSync('/proc/' + pid + '/stat', 'utf8');
  const startedAtTicks = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  return {service: 'kurumi-fusion.service', mainPid: Number(service.MainPID), gatewayPid: pid,
    invocationId: service.InvocationID, startedAtTicks};
}

export async function verifyProductionDeployment({repo}) {
  const state = '/home/afrangry/.openclaw-fusion';
  const report = {at: new Date().toISOString(), target: 'production', scope: 'read-only deployment checks',
    checks: [], uncovered: ['loaded plugin code hashes',
      'production scenario interactions with isolated identity/storage/confirmations/background delivery'],
    effects: {modelCalls: 0, messages: 0, stateWrites: 0, restarts: 0}};
  const step = async (name, read) => {
    try {report.checks.push({name, status: 'passed', evidence: await read()});}
    catch {report.checks.push({name, status: 'failed'});}
  };
  try {
    const configFile = join(state, 'openclaw.json');
    const beforeConfig = readFileSync(configFile, 'utf8');
    const cfg = JSON.parse(beforeConfig);
    const token = JSON.parse(readFileSync(join(state, 'runtime-env.json'), 'utf8')).OPENCLAW_GATEWAY_TOKEN;
    const port = cfg.gateway.port;
    if (!Number.isInteger(port) || port < 1024 || port > 65535 || typeof token !== 'string' || !token) throw Error('invalid_production_connection');
    const before = await serviceIdentity(port);
    report.process = before;
    const policy = accessPolicy(cfg);
    const owner = policy.subjects.find(subject => subject.role === 'owner');
    report.config = {fileSha256: createHash('sha256').update(beforeConfig).digest('hex'), policyRevision: policy.revision,
      configuredModel: cfg.agents?.entries?.main?.model?.primary ?? cfg.agents?.defaults?.model?.primary};
    const rpc = (method, params = {}) => callGatewayFromCli(method,
      {config: cfg, url: 'ws://127.0.0.1:' + port, token, timeout: '10000', json: true}, params,
      {deviceIdentity: null, sharedStateMode: 'read-only'});
    await step('gateway-health-in-service-process', async () => {
      await rpc('health');
      return {gatewayPid: before.gatewayPid};
    });
    let appliedHash;
    await step('gateway-applied-access-configuration', async () => {
      appliedHash = await appliedAccessConfig(rpc, configFile, cfg);
      if (cfg.channels['kurumi-qq'].testIngress !== false) throw Error('test_ingress_not_closed');
      return {policyRevision: policy.revision, testIngress: false};
    });
    await step('trusted-host-tool-policy-ready', async () => {
      if ((await rpc('kurumi-host-control.status')).ready !== true) throw Error('host_policy_unavailable');
      return true;
    });
    await step('qq-channel-connected', async () => {
      const status = await rpc('channels.status', {probe: true});
      if (!status.channelAccounts?.['kurumi-qq']?.some(a => a.running && a.connected)) throw Error('channel_disconnected');
      return true;
    });
    await step('loaded-plugins', async () => {
      const result = await rpc('plugins.list');
      const plugins = result.plugins.map(p => ({id: p.id, state: p.runtime?.state ?? null}));
      const required = ['kurumi-qq', 'kurumi-host-control', 'kurumi-access-admin', 'personal-confirmation', 'kurumi-mail', 'kurumi-coding', 'kurumi-host-admin'];
      if (required.some(id => !plugins.some(p => p.id === id && p.state === 'active'))) {
        throw Error('required_plugins_missing');
      }
      return plugins;
    });
    await step('owner-session-effective-tools', async () => {
      const catalog = await rpc('tools.effective', {agentId: 'main', sessionKey: sessionFor(owner)});
      const names = toolsOf(catalog), tools = cfg.agents.entries.main.tools;
      if (catalog.agentId !== 'main' || [...tools.alsoAllow, 'kurumi_access', 'personal_confirmation'].some(name => !names.includes(name))
        || [...tools.deny, ...cfg.tools.deny].some(name => names.includes(name))) throw Error('owner_tool_catalog_mismatch');
      return {explicit: tools.alsoAllow.length, visible: names.length};
    });
    await step('member-session-boundaries', async () => {
      let verifiedSessions = 0, withoutSession = 0;
      for (const member of allowedMembers(cfg).filter(row => row.role === 'member')) {
        const agentId = agentFor(member), sessionKey = sessionFor(member);
        if (!isDeepStrictEqual(cfg.agents.entries[agentId]?.tools?.allow, MEMBER_TOOLS)
          || !cfg.bindings.some(({agentId: id, match}) => id === agentId && match.channel === 'kurumi-qq'
            && match.accountId === 'default' && match.peer.kind === 'direct' && match.peer.id === member.qq)) {
          throw Error('member_route_or_catalog_mismatch');
        }
        try {
          const catalog = await rpc('tools.effective', {agentId, sessionKey});
          if (catalog.agentId !== agentId || toolsOf(catalog).some(name => !MEMBER_TOOLS.includes(name))) {
            throw Error('member_effective_catalog_mismatch');
          }
          verifiedSessions++;
        } catch (error) {
          if (error.code !== 'INVALID_REQUEST' || !error.message.startsWith('unknown session key')) throw error;
          withoutSession++;
        }
      }
      if (withoutSession) report.uncovered.push('member session catalog for accounts without a session');
      return {verifiedSessions, withoutSession};
    });
    await step('five-owner-admin-categories', () => {
      const {admin, exec: ownerExec, recipients, projects, projectWriteBoundary} = accessProjection(cfg);
      const categories = ['mail_recipient', 'owner_tool', 'exec_root', 'coding_project'];
      if (owner.permissions['access.manage'] !== true || admin.sourceRoot !== repo
        || !isDeepStrictEqual([...admin.enabledCategories].sort(), categories.sort())
        || !isDeepStrictEqual(recipients, owner.mailRecipients)) throw Error('owner_admin_registration_mismatch');
      validateWriteFence(ownerExec.writeBoundary);
      validateWriteFence(projectWriteBoundary);
      const extraRoots = writeFenceRoots(ownerExec.writeBoundary).length - 1;
      return {categories: categories.length + 1, recipients: recipients.length, extraRoots, projects: projects.length};
    });
    for (const [name, script] of [['managed-config-aligned', 'sync-config.mjs'], ['persona-projection-aligned', 'sync-persona.mjs'],
      ['installed-dependencies-approved', 'verify-dependencies.mjs'], ['semantic-health', 'health.mjs']]) {
      await step(name, async () => {
        const {stdout} = await exec(process.execPath, [join(repo, 'scripts/fusion', script)], {
          cwd: repo, timeout: 45000, maxBuffer: 1024 * 1024});
        if (script === 'health.mjs') {
          const health = JSON.parse(stdout);
          if (!health.ok) throw Error('semantic_health_failed');
          return {ok: true, issues: health.issues.length};
        }
        return true; // Do not retain output which may contain paths/private configuration.
      });
    }
    await step('service-and-config-stable-during-observation', async () => {
      if (appliedHash !== await appliedAccessConfig(rpc, configFile, cfg)
        || beforeConfig !== readFileSync(configFile, 'utf8') ||
          JSON.stringify(before) !== JSON.stringify(await serviceIdentity(port))) throw Error('production_changed_during_check');
      return true;
    });
    report.passed = report.checks.every(check => check.status === 'passed');
  } catch {
    report.passed = false;
    report.blocked = 'production_service_identity_or_connection_unavailable';
  }
  report.finishedAt = new Date().toISOString();
  return report;
}
