import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {
  checkApprovalGrant,
  createNaturalConfirmationBackend,
  ensureConfirmationGateSchema,
  markConfirmationProposalCommitted,
  registerConfirmationProposal,
} from '../confirmation-core/dist/index.js';
import {
  LEASE_DOMAIN,
  LEASE_LIMITS,
  ScopedLeaseError,
  fail,
  insideRoot,
  leaseIdPattern,
  proposalIdPattern,
  sha256,
} from './policy.js';

function effectiveLeaseState(row, now) {
  if (row.state === 'active' && row.expires_at <= now) return 'expired';
  return row.state;
}

function formatLeaseRow(row, now) {
  const state = effectiveLeaseState(row, now);
  const actions = JSON.parse(row.actions_json);
  const roots = JSON.parse(row.roots_json);
  return {
    leaseId: row.lease_id,
    proposalId: row.proposal_id,
    label: row.label,
    actions,
    roots,
    maxOps: row.max_ops,
    usedOps: row.used_ops,
    remainingOps: Math.max(0, row.max_ops - row.used_ops),
    maxBytes: row.max_bytes,
    usedBytes: row.used_bytes,
    remainingBytes: Math.max(0, row.max_bytes - row.used_bytes),
    createdAtUtc: row.created_at,
    expiresAtUtc: row.expires_at,
    revokedAtUtc: row.revoked_at ?? null,
    revokeReason: row.revoke_reason ?? null,
    state,
  };
}

export class ScopedLeaseStore {
  constructor(stateRoot, now = Date.now) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
      || fs.realpathSync(stateRoot) !== stateRoot) {
      throw new ScopedLeaseError('lease_state_root_invalid');
    }
    const directory = path.join(stateRoot, 'state', 'scoped-lease');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.realpathSync(directory) !== directory) {
      throw new ScopedLeaseError('lease_state_path_invalid');
    }
    const file = path.join(directory, 'leases.sqlite');
    const stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      throw new ScopedLeaseError('lease_state_path_invalid');
    }
    const db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      ensureConfirmationGateSchema(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS lease_proposals (
          id TEXT PRIMARY KEY,
          owner_qq TEXT NOT NULL,
          plan TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          lease_id TEXT,
          error TEXT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS active_leases (
          lease_id TEXT PRIMARY KEY,
          proposal_id TEXT NOT NULL,
          owner_qq TEXT NOT NULL,
          origin_session_key TEXT NOT NULL,
          label TEXT NOT NULL,
          actions_json TEXT NOT NULL,
          roots_json TEXT NOT NULL,
          max_ops INTEGER NOT NULL,
          used_ops INTEGER NOT NULL,
          max_bytes INTEGER NOT NULL,
          used_bytes INTEGER NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          revoked_at INTEGER,
          revoke_reason TEXT,
          state TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS active_leases_owner_state_index
          ON active_leases(owner_qq, state, expires_at);

        CREATE TABLE IF NOT EXISTS lease_usage_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lease_id TEXT NOT NULL,
          at INTEGER NOT NULL,
          tool TEXT NOT NULL,
          action TEXT NOT NULL,
          target_summary TEXT NOT NULL,
          op_count INTEGER NOT NULL,
          byte_count INTEGER NOT NULL,
          outcome TEXT NOT NULL
        ) STRICT;

        CREATE INDEX IF NOT EXISTS lease_usage_log_lease_index
          ON lease_usage_log(lease_id, id);
      `);
      this.db = db;
      this.now = () => Math.floor(now() / 1000);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() {
    this.db.close();
  }

  get natural() {
    return createNaturalConfirmationBackend(this.db, {
      subjectId: 'owner',
      domains: [LEASE_DOMAIN],
      now: this.now,
      supportsBatch: false,
    });
  }

  transaction(work) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = work();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  propose(plan, owner, scope, proposalId = randomUUID(), ttlSeconds = LEASE_LIMITS.proposalTtlSeconds) {
    if (!proposalIdPattern.test(proposalId)) fail('invalid_proposal_id');
    const payload = JSON.stringify(plan);
    const payloadHash = sha256(payload);
    const at = this.now();
    const expiresAtUtc = at + ttlSeconds;
    this.transaction(() => {
      registerConfirmationProposal(this.db, {
        proposalId,
        payloadHash,
        domain: LEASE_DOMAIN,
        actionKind: 'lease.create',
        subjectId: 'owner',
        scope,
        createdAtUtc: at,
        expiresAtUtc,
      });
      this.db.prepare(
        'INSERT INTO lease_proposals (id, owner_qq, plan, state, created_at, updated_at) VALUES (?,?,?,?,?,?)',
      ).run(proposalId, owner, payload, 'pending', at, at);
    });
    return {domain: LEASE_DOMAIN, proposalId, payloadHash, expiresAtUtc};
  }

  getProposal(proposalId, owner) {
    if (typeof proposalId !== 'string' || !proposalIdPattern.test(proposalId)) {
      fail('invalid_proposal_id');
    }
    const row = this.db.prepare(`SELECT a.*, p.expires_at_utc FROM lease_proposals a
      JOIN confirmation_proposals p ON p.proposal_id=a.id WHERE a.id=? AND a.owner_qq=?`).get(proposalId, owner);
    if (!row) fail('proposal_unavailable');
    const state = row.state === 'pending' && row.expires_at_utc <= this.now() ? 'expired' : row.state;
    return {
      ...row,
      state,
      plan: JSON.parse(row.plan),
      hash: sha256(row.plan),
    };
  }

  listRecentProposals(owner, limit = 10) {
    const rows = this.db.prepare(`SELECT a.id, a.plan, a.state, a.created_at, a.updated_at, a.lease_id, a.error, p.expires_at_utc
      FROM lease_proposals a JOIN confirmation_proposals p ON p.proposal_id=a.id
      WHERE a.owner_qq=? ORDER BY a.rowid DESC LIMIT ?`).all(owner, limit);
    const now = this.now();
    return rows.map(row => {
      const plan = JSON.parse(row.plan);
      const state = row.state === 'pending' && row.expires_at_utc <= now ? 'expired' : row.state;
      return {
        proposalId: row.id,
        label: plan.label,
        actions: plan.actions,
        roots: plan.roots,
        state,
        ...(row.lease_id ? {leaseId: row.lease_id} : {}),
        createdAtUtc: row.created_at,
        updatedAtUtc: row.updated_at,
        ...(row.error ? {code: row.error} : {}),
      };
    });
  }

  commitProposal(proposalId, owner, scope, originSessionKey, verify) {
    if (typeof proposalId !== 'string' || !proposalIdPattern.test(proposalId)) {
      fail('invalid_proposal_id');
    }
    return this.transaction(() => {
      const row = this.getProposal(proposalId, owner);
      if (row.state === 'expired') fail('lease_proposal_expired');
      if (row.state !== 'pending') fail('lease_proposal_already_submitted');
      verify(row.plan);
      const at = this.now();
      const approval = checkApprovalGrant(this.db, {
        proposalId,
        domain: LEASE_DOMAIN,
        subjectId: 'owner',
        payloadHash: row.hash,
        scope,
        nowUtc: at,
        consume: true,
      });
      if (!approval.ok) fail(approval.code);
      markConfirmationProposalCommitted(this.db, {proposalId, subjectId: 'owner', atUtc: at});

      const leaseId = randomUUID();
      const expiresAt = at + row.plan.ttlSeconds;
      this.db.prepare(`
        INSERT INTO active_leases (
          lease_id, proposal_id, owner_qq, origin_session_key, label,
          actions_json, roots_json, max_ops, used_ops, max_bytes, used_bytes,
          created_at, expires_at, state
        ) VALUES (?,?,?,?,?,?,?,?,0,?,0,?,?,?)
      `).run(
        leaseId,
        proposalId,
        owner,
        String(originSessionKey ?? scope.primary ?? ''),
        row.plan.label,
        JSON.stringify(row.plan.actions),
        JSON.stringify(row.plan.roots),
        row.plan.maxOps,
        row.plan.maxBytes,
        at,
        expiresAt,
        'active',
      );
      this.db.prepare(
        'UPDATE lease_proposals SET state=?, updated_at=?, lease_id=? WHERE id=?',
      ).run('active', at, leaseId, proposalId);

      const created = this.db.prepare('SELECT * FROM active_leases WHERE lease_id=?').get(leaseId);
      return {
        proposalId,
        payloadHash: row.hash,
        lease: formatLeaseRow(created, at),
      };
    });
  }

  getLease(leaseId, owner) {
    if (typeof leaseId !== 'string' || !leaseIdPattern.test(leaseId)) {
      fail('invalid_lease_id');
    }
    const row = this.db.prepare('SELECT * FROM active_leases WHERE lease_id=? AND owner_qq=?').get(leaseId, owner);
    if (!row) fail('lease_not_found');
    const now = this.now();
    const usage = this.db.prepare(
      'SELECT id, at, tool, action, target_summary AS targetSummary, op_count AS opCount, byte_count AS byteCount, outcome FROM lease_usage_log WHERE lease_id=? ORDER BY id DESC LIMIT 20',
    ).all(leaseId);
    return {
      ...formatLeaseRow(row, now),
      usageLog: usage,
    };
  }

  listLeases(owner, {includeInactive = false, limit = 20} = {}) {
    const rows = this.db.prepare(
      'SELECT * FROM active_leases WHERE owner_qq=? ORDER BY rowid DESC LIMIT ?',
    ).all(owner, limit);
    const now = this.now();
    const formatted = rows.map(row => formatLeaseRow(row, now));
    return includeInactive ? formatted : formatted.filter(item => item.state === 'active');
  }

  revoke(leaseId, owner, reason = 'owner_revoked') {
    if (typeof leaseId !== 'string' || !leaseIdPattern.test(leaseId)) {
      fail('invalid_lease_id');
    }
    return this.transaction(() => {
      const row = this.db.prepare('SELECT * FROM active_leases WHERE lease_id=? AND owner_qq=?').get(leaseId, owner);
      if (!row) fail('lease_not_found');
      const at = this.now();
      const current = effectiveLeaseState(row, at);
      if (current === 'revoked') {
        return {leaseId, state: 'revoked', revokedAtUtc: row.revoked_at, alreadyInactive: true};
      }
      if (current !== 'active') {
        if (row.state === 'active' && current === 'expired') {
          this.db.prepare('UPDATE active_leases SET state=? WHERE lease_id=?').run('expired', leaseId);
        }
        return {leaseId, state: current, revokedAtUtc: row.revoked_at ?? null, alreadyInactive: true};
      }
      this.db.prepare(
        'UPDATE active_leases SET state=?, revoked_at=?, revoke_reason=? WHERE lease_id=?',
      ).run('revoked', at, reason, leaseId);
      return {leaseId, state: 'revoked', revokedAtUtc: at, alreadyInactive: false};
    });
  }

  revokeAll(owner, reason = 'owner_revoked_all') {
    return this.transaction(() => {
      const at = this.now();
      const rows = this.db.prepare(
        'SELECT lease_id, expires_at FROM active_leases WHERE owner_qq=? AND state=?',
      ).all(owner, 'active');
      const revokedLeaseIds = [];
      for (const row of rows) {
        if (row.expires_at <= at) {
          this.db.prepare('UPDATE active_leases SET state=? WHERE lease_id=?').run('expired', row.lease_id);
        } else {
          this.db.prepare(
            'UPDATE active_leases SET state=?, revoked_at=?, revoke_reason=? WHERE lease_id=?',
          ).run('revoked', at, reason, row.lease_id);
          revokedLeaseIds.push(row.lease_id);
        }
      }
      return {revokedCount: revokedLeaseIds.length, revokedLeaseIds, revokedAtUtc: at};
    });
  }

  consume(leaseId, owner, {
    action,
    paths,
    opCount = 1,
    byteCount = 0,
    tool = 'kurumi_files',
    targetSummary = '',
    isInteractiveOwner = true,
  }) {
    if (isInteractiveOwner !== true) fail('lease_forbidden_in_wake_session');
    if (typeof leaseId !== 'string' || !leaseIdPattern.test(leaseId)) fail('invalid_lease_id');
    if (typeof action !== 'string' || !action) fail('invalid_lease_arguments');
    if (!Number.isSafeInteger(opCount) || opCount < 1) fail('invalid_lease_arguments');
    if (!Number.isSafeInteger(byteCount) || byteCount < 0) fail('invalid_lease_arguments');
    if (!Array.isArray(paths) || paths.length === 0 || paths.some(p => typeof p !== 'string' || !path.isAbsolute(p))) {
      fail('lease_scope_violation');
    }

    this.db.exec('BEGIN IMMEDIATE');
    let committed = false;
    try {
      const row = this.db.prepare('SELECT * FROM active_leases WHERE lease_id=? AND owner_qq=?').get(leaseId, owner);
      if (!row) fail('lease_not_found');
      const at = this.now();
      if (row.state === 'revoked') fail('lease_revoked');
      if (row.state === 'exhausted') fail('lease_quota_exceeded');
      if (row.state === 'expired') fail('lease_expired');
      if (row.state !== 'active') fail('lease_inactive');

      if (row.expires_at <= at) {
        this.db.prepare('UPDATE active_leases SET state=? WHERE lease_id=?').run('expired', leaseId);
        this.db.exec('COMMIT');
        committed = true;
        fail('lease_expired');
      }

      const actions = JSON.parse(row.actions_json);
      if (!actions.includes(action)) fail('lease_action_not_covered');

      const roots = JSON.parse(row.roots_json);
      for (const target of paths) {
        if (!roots.some(root => insideRoot(target, root))) {
          fail('lease_scope_violation');
        }
      }

      if (row.used_ops + opCount > row.max_ops || row.used_bytes + byteCount > row.max_bytes) {
        fail('lease_quota_exceeded');
      }

      const nextUsedOps = row.used_ops + opCount;
      const nextUsedBytes = row.used_bytes + byteCount;
      const nextState = (nextUsedOps >= row.max_ops || nextUsedBytes >= row.max_bytes) ? 'exhausted' : 'active';

      this.db.prepare(
        'UPDATE active_leases SET used_ops=?, used_bytes=?, state=? WHERE lease_id=?',
      ).run(nextUsedOps, nextUsedBytes, nextState, leaseId);

      this.db.prepare(`
        INSERT INTO lease_usage_log (lease_id, at, tool, action, target_summary, op_count, byte_count, outcome)
        VALUES (?,?,?,?,?,?,?,?)
      `).run(leaseId, at, tool, action, String(targetSummary).slice(0, 160), opCount, byteCount, 'consumed');

      const updated = this.db.prepare('SELECT * FROM active_leases WHERE lease_id=?').get(leaseId);
      this.db.exec('COMMIT');
      committed = true;
      return formatLeaseRow(updated, at);
    } catch (error) {
      if (!committed) this.db.exec('ROLLBACK');
      throw error;
    }
  }
}
