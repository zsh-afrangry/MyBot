import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  checkApprovalGrant, createNaturalConfirmationBackend, ensureConfirmationGateSchema,
  markConfirmationProposalCommitted, registerConfirmationProposal,
} from '@kurumi/confirmation-core';
import {DEFAULT_PROPOSAL_TTL_SECONDS, DOMAIN, HostAdminError, sha256} from './policy.js';

export class HostAdminStore {
  constructor(stateRoot, now = Date.now) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
      || fs.realpathSync(stateRoot) !== stateRoot) {
      throw new HostAdminError('host_admin_state_root_invalid');
    }
    const directory = path.join(stateRoot, 'state', 'host-admin');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.realpathSync(directory) !== directory) {
      throw new HostAdminError('host_admin_state_path_invalid');
    }
    const file = path.join(directory, 'actions.sqlite');
    const stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      throw new HostAdminError('host_admin_state_path_invalid');
    }
    const db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      ensureConfirmationGateSchema(db);
      db.exec('CREATE TABLE IF NOT EXISTS host_admin_actions (' +
        'id TEXT PRIMARY KEY, owner_qq TEXT NOT NULL, action_id TEXT NOT NULL, ' +
        'plan TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, ' +
        'updated_at INTEGER NOT NULL, after_state TEXT, exec_result TEXT, error TEXT) STRICT');
      this.db = db;
      this.now = () => Math.floor(now() / 1000);
    } catch (error) {
      db.close();
      throw error;
    }
  }

  close() { this.db.close(); }

  get natural() {
    return createNaturalConfirmationBackend(this.db, {subjectId: 'owner', domains: [DOMAIN], now: this.now});
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

  propose(plan, owner, scope, proposalId = randomUUID(), ttlSeconds = DEFAULT_PROPOSAL_TTL_SECONDS) {
    const payload = JSON.stringify(plan);
    const payloadHash = sha256(payload);
    const at = this.now();
    const expiresAtUtc = at + ttlSeconds;
    this.transaction(() => {
      registerConfirmationProposal(this.db, {
        proposalId, payloadHash, domain: DOMAIN,
        actionKind: plan.template, subjectId: 'owner', scope,
        createdAtUtc: at, expiresAtUtc,
      });
      this.db.prepare(
        'INSERT INTO host_admin_actions (id, owner_qq, action_id, plan, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)'
      ).run(proposalId, owner, plan.actionId, payload, 'pending', at, at);
    });
    return {domain: DOMAIN, proposalId, payloadHash, expiresAtUtc};
  }

  get(proposalId, owner) {
    const row = this.db.prepare(`SELECT a.*, p.expires_at_utc FROM host_admin_actions a
      JOIN confirmation_proposals p ON p.proposal_id=a.id WHERE a.id=? AND a.owner_qq=?`).get(proposalId, owner);
    if (!row) throw new HostAdminError('proposal_unavailable');
    const state = row.state === 'pending' && row.expires_at_utc <= this.now() ? 'expired' : row.state;
    return {
      ...row,
      state,
      plan: JSON.parse(row.plan),
      hash: sha256(row.plan),
      afterState: row.after_state ? JSON.parse(row.after_state) : null,
      execResult: row.exec_result ? JSON.parse(row.exec_result) : null,
    };
  }

  listRecent(owner, limit = 10) {
    const rows = this.db.prepare(`SELECT a.id, a.action_id, a.plan, a.state, a.created_at, a.updated_at, a.error, p.expires_at_utc
      FROM host_admin_actions a JOIN confirmation_proposals p ON p.proposal_id=a.id
      WHERE a.owner_qq=? ORDER BY a.rowid DESC LIMIT ?`).all(owner, limit);
    const now = this.now();
    return rows.map(row => {
      const plan = JSON.parse(row.plan);
      const state = row.state === 'pending' && row.expires_at_utc <= now ? 'expired' : row.state;
      return {
        proposalId: row.id,
        actionId: row.action_id,
        template: plan.template,
        target: plan.target,
        state,
        createdAtUtc: row.created_at,
        updatedAtUtc: row.updated_at,
        ...(row.error ? {code: row.error} : {}),
      };
    });
  }

  claim(proposalId, owner, scope, verify) {
    return this.transaction(() => {
      const row = this.get(proposalId, owner);
      if (row.state === 'expired') throw new HostAdminError('host_admin_proposal_expired');
      if (row.state !== 'pending') throw new HostAdminError('host_admin_already_submitted');
      verify(row.plan);
      const at = this.now();
      const approval = checkApprovalGrant(this.db, {
        proposalId, domain: DOMAIN, subjectId: 'owner',
        payloadHash: row.hash, scope, nowUtc: at, consume: true,
      });
      if (!approval.ok) throw new HostAdminError(approval.code);
      markConfirmationProposalCommitted(this.db, {proposalId, subjectId: 'owner', atUtc: at});
      this.db.prepare('UPDATE host_admin_actions SET state=?, updated_at=? WHERE id=?').run('executing', at, proposalId);
      return {plan: row.plan, hash: row.hash};
    });
  }

  finish(proposalId, owner, outcome) {
    return this.transaction(() => {
      const row = this.get(proposalId, owner);
      if (row.state !== 'executing') throw new HostAdminError('host_admin_already_submitted');
      const at = this.now();
      this.db.prepare(
        'UPDATE host_admin_actions SET state=?, updated_at=?, after_state=?, exec_result=?, error=? WHERE id=?'
      ).run(
        outcome.state,
        at,
        JSON.stringify(outcome.afterState ?? null),
        JSON.stringify(outcome.execSummary ?? null),
        outcome.code ?? null,
        proposalId,
      );
      return {...outcome, updatedAtUtc: at};
    });
  }
}
