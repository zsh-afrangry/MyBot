import {existsSync, realpathSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {isAbsolute, join, relative, resolve} from 'node:path';
import {redactText} from '../../packages/observability/index.js';

// A nonzero health command can still provide a complete JSON health report.
// Keep historical Cron failures separate without treating either as success.
export function classifyHealth(health) {
  if (!health || typeof health.ok !== 'boolean' || !Array.isArray(health.issues)
    || health.issues.some(issue => typeof issue !== 'string')
    || health.ok !== (health.issues.length === 0)
    || (health.cronFailures !== undefined && (!Array.isArray(health.cronFailures)
      || health.cronFailures.some(issue => typeof issue !== 'string' || !health.issues.includes(issue))))) {
    throw Error('invalid_health_report');
  }
  const cronFailures = new Set(health.cronFailures ?? []);
  const baseIssues = health.issues.filter(issue => !cronFailures.has(issue) && issue !== 'Cron state is unavailable');
  const cronAvailable = health.cron && Array.isArray(health.cron.jobs)
    && !health.issues.includes('Cron state is unavailable');
  return {
    base: {ok: baseIssues.length === 0, issues: baseIssues.length},
    cron: {ok: Boolean(cronAvailable && cronFailures.size === 0), available: Boolean(cronAvailable), issues: cronFailures.size},
  };
}

export function deploymentFailures(data) {
  return data.checks.filter(check => check.status !== 'passed').map(check => check.name);
}

function retainedRoot(data) {
  const candidate = data?.diagnosticsRoot ?? data?.diagnosticDirectory;
  if (typeof candidate !== 'string' || !isAbsolute(candidate)) return undefined;
  try {
    const root = realpathSync(candidate), temp = realpathSync(tmpdir());
    const within = relative(temp, root);
    if (!within || within.startsWith('..') || isAbsolute(within) || !statSync(root).isDirectory()) return undefined;
    return root;
  } catch {return undefined;}
}

function logReference(repo, runtimeRoot) {
  return {
    status: 'available', kind: 'log-query', scope: 'retained_fixture', runtimeRoot,
    command: process.execPath,
    args: [join(repo, 'chatbot/scripts/log-query.mjs'), '--runtime-root', runtimeRoot,
      '--snowluma-root', runtimeRoot, '--since', 'all',
      '--source', 'openclaw-runtime', '--source', 'openclaw-session', '--source', 'openclaw-receipt',
      '--source', 'trace-events', '--source', 'channel-delivery', '--no-text', '--json'],
  };
}

export function fixtureReference(data, repo) {
  const root = retainedRoot(data);
  if (!root) return undefined;
  // A few scenarios use a separate state directory for each gateway.
  const candidates = ['', 'state', 'enabled', 'disabled']
    .map(part => resolve(root, part))
    .filter(dir => {
      try {return existsSync(join(dir, 'openclaw.json')) && realpathSync(dir) === dir;} catch {return false;}
    });
  const references = (candidates.length ? candidates : [root]).map(dir => logReference(repo, dir));
  return {...references[0], diagnosticsRoot: root,
    ...(references.length > 1 && {alternatives: references.slice(1)})};
}

export function failureDiagnostic(data, observed) {
  const raw = typeof data?.error === 'string' ? data.error : data?.error?.message;
  const message = typeof raw === 'string'
    ? redactText(raw.split(/\r?\n/u, 1)[0])
      .replace(/\b(password|passwd|secret|api[_-]?key|token)\s*[:=]\s*[^\s,;]+/giu, '$1=[REDACTED]')
      .slice(0, 1000)
    : undefined;
  if (!observed && !message) return undefined;
  return {...(observed ?? {}), ...(message && {error: message})};
}

// Directory retention is evidence preservation, not proof of a process leak.
export function fixtureCleanup(data) {
  const stopped = data?.gatewayStopped ?? data?.gracefulStop;
  const stages = Array.isArray(data?.stages) ? data.stages : [];
  const gateway = stopped === true ? 'stopped' : stopped === false ? 'forced_or_failed'
    : stages.length && stages.every(stage => stage?.gracefulStop === true) ? 'stopped'
      : stages.some(stage => stage?.gracefulStop === false) ? 'forced_or_failed' : 'unknown';
  const removed = data?.fixtureRemoved ?? data?.fixtureCleaned;
  const fixture = removed === true ? 'removed' : removed === false || retainedRoot(data) ? 'retained' : 'unknown';
  const api = data?.knowledgeMapStopped;
  return {gateway, fixture, ...(typeof api === 'boolean' && {knowledgeMap: api ? 'stopped' : 'forced_or_failed'})};
}
