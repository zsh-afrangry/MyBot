// Read-only observations of the active service. No test messages or state mutation.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';
import {promisify} from 'node:util';
import {callGatewayFromCli} from 'openclaw/plugin-sdk/gateway-runtime';
import {accessPolicy, sessionFor} from '../../packages/access-control/index.js';

const exec = promisify(execFile);
const fields = text => Object.fromEntries(text.trim().split('\n').map(line => {
  const at = line.indexOf('=');
  return [line.slice(0, at), line.slice(at + 1)];
}));
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
    checks: [], uncovered: ['loaded code hashes (the current runtime exposes no process-owned code attestation)',
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
    await step('test-ingress-closed', async () => {
      if (cfg.channels?.['kurumi-qq']?.testIngress !== false) throw Error('test_ingress_not_closed');
      try {await rpc('kurumi-qq.testInbound');}
      catch (error) {if (/unknown method|not found/iu.test(error.message)) return true; throw error;}
      throw Error('test_ingress_present');
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
      if (['kurumi-qq', 'kurumi-host-control'].some(id => !plugins.some(p => p.id === id && p.state === 'active'))) {
        throw Error('required_plugins_missing');
      }
      return plugins;
    });
    await step('owner-session-effective-tools', async () => {
      const catalog = await rpc('tools.effective', {agentId: 'main', sessionKey: sessionFor(owner)});
      if (catalog.agentId !== 'main') throw Error('owner_agent_mismatch');
      return [...new Set(catalog.groups.flatMap(g => g.tools.map(t => t.id)))].sort();
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
      if (beforeConfig !== readFileSync(configFile, 'utf8') ||
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
