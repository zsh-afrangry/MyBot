import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {isDeepStrictEqual} from 'node:util';

function supportedHeartbeat(value) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && value.every === '0m' && (value.agentId === undefined || value.agentId === 'main')
    && Object.keys(value).every(key => key === 'every' || key === 'agentId');
}

// Keep the old disabled setting until Doctor has migrated its associated job.
// Other legacy shapes need a separate review of scheduling and delivery semantics.
export function carryDisabledHeartbeat(intent, previous) {
  const entries = previous?.agents?.entries ?? {};
  if (Object.values(entries).some(agent => agent?.heartbeat !== undefined)) {
    throw Error('Per-agent heartbeat migration requires review');
  }
  const legacy = previous?.agents?.defaults?.heartbeat;
  const desired = intent?.agents?.defaults?.heartbeat;
  if (desired !== undefined) throw Error('Upgrade intent must not contain legacy heartbeat settings');
  if (legacy === undefined) return false;
  if (!supportedHeartbeat(legacy) || !intent?.agents?.defaults) {
    throw Error('Only the known disabled heartbeat can be migrated automatically');
  }
  intent.agents.defaults.heartbeat = structuredClone(legacy);
  return true;
}

export function expectedAfterHeartbeatMigration(before) {
  const expected = structuredClone(before);
  const heartbeat = expected?.agents?.defaults?.heartbeat;
  if (heartbeat !== undefined) {
    if (!supportedHeartbeat(heartbeat)) throw Error('Unsupported heartbeat normalization');
    delete expected.agents.defaults.heartbeat;
  }
  if (Object.values(expected?.agents?.entries ?? {}).some(agent => agent?.heartbeat !== undefined)) {
    throw Error('Per-agent heartbeat migration requires review');
  }
  return expected;
}

function hasTable(db, name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
}

// Only the copied OpenClaw state DB is eligible, never a runtime DB or an arbitrary
// database with a similarly named table. Other state lease scopes are retained.
export function clearCopiedGatewayLeases(target) {
  const root = fs.realpathSync(target);
  if (!root.startsWith('/tmp/') || root !== path.resolve(target)) throw Error('Unsafe recovery target');
  const file = path.join(root, 'runtime/state/openclaw.sqlite');
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync(file) !== file) {
    throw Error('Recovery state DB must be a regular, non-hardlinked copy inside the target');
  }
  const db = new DatabaseSync(file);
  try {
    db.exec('BEGIN IMMEDIATE');
    try {
      const gateway = hasTable(db, 'state_leases')
        ? Number(db.prepare("DELETE FROM state_leases WHERE scope='gateway-owner'").run().changes) : 0;
      const agent = hasTable(db, 'agent_database_leases')
        ? Number(db.prepare('DELETE FROM agent_database_leases').run().changes) : 0;
      db.exec('COMMIT');
      return {gateway, agent};
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
  } finally {
    db.close();
  }
}

export function snapshotCodingActivity(file) {
  if (!fs.existsSync(file)) return {tasks: [], rounds: [], events: []};
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const tasks = hasTable(db, 'coding_tasks')
      ? db.prepare('SELECT id, facts FROM coding_tasks ORDER BY id').all().map(row => [row.id, JSON.parse(row.facts).executionRoundId ?? null]) : [];
    const rounds = hasTable(db, 'coding_results')
      ? db.prepare('SELECT task_id, round_id FROM coding_results ORDER BY task_id, round_id').all().map(row => [row.task_id, row.round_id]) : [];
    const events = hasTable(db, 'coding_result_events')
      ? db.prepare('SELECT task_id, round_id, seq FROM coding_result_events ORDER BY task_id, round_id, seq').all().map(row => [row.task_id, row.round_id, row.seq]) : [];
    return {tasks, rounds, events};
  } finally {
    db.close();
  }
}

export function snapshotCronDefinitions(file) {
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    return db.prepare('SELECT store_key, job_id, enabled, payload_kind, job_json FROM cron_jobs ORDER BY store_key, job_id').all().map(row => {
      const definition = JSON.parse(row.job_json);
      delete definition.state;
      delete definition.updatedAtMs;
      return {store: row.store_key, id: row.job_id, enabled: Number(row.enabled), kind: row.payload_kind, definition};
    });
  } finally {
    db.close();
  }
}

// Ordinary jobs must preserve their definitions. A legacy disabled heartbeat may
// become a disabled agent-turn job; newly introduced jobs must also be disabled.
export function verifyCronMigration(before, after) {
  const key = job => JSON.stringify([job.store, job.id]);
  const latest = new Map(after.map(job => [key(job), job]));
  const known = new Set(before.map(key));
  for (const prior of before) {
    const current = latest.get(key(prior));
    if (!current || current.enabled !== prior.enabled) return false;
    if (prior.kind === 'heartbeat') {
      if (prior.enabled !== 0 || current.kind !== 'agentTurn') return false;
    } else if (prior.kind !== current.kind || !isDeepStrictEqual(prior.definition, current.definition)) return false;
  }
  return after.every(job => known.has(key(job)) || job.enabled === 0);
}
