import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  checkApprovalGrant, createNaturalConfirmationBackend, ensureConfirmationGateSchema,
  markConfirmationProposalCommitted, registerConfirmationProposal,
} from '@kurumi/confirmation-core';
import {AccessError} from '../../packages/access-control/index.js';
import {DOMAIN, sha256} from './policy.js';

export class AccessChangeStore {
  constructor(stateRoot, now = Date.now) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
      || fs.realpathSync(stateRoot) !== stateRoot) throw new AccessError('access_state_root_invalid');
    const directory = path.join(stateRoot, 'state', 'access-admin');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.realpathSync(directory) !== directory) throw new AccessError('access_state_path_invalid');
    const file = path.join(directory, 'changes.sqlite');
    const stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.nlink !== 1)) throw new AccessError('access_state_path_invalid');
    const db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      ensureConfirmationGateSchema(db);
      db.exec('CREATE TABLE IF NOT EXISTS access_changes (' +
        'id TEXT PRIMARY KEY, owner_qq TEXT NOT NULL, plan TEXT NOT NULL, ' +
        'state TEXT NOT NULL, updated_at INTEGER NOT NULL, error TEXT) STRICT');
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

  propose(plan, owner, scope) {
    const proposalId = randomUUID();
    const payload = JSON.stringify(plan);
    const payloadHash = sha256(payload);
    const at = this.now();
    this.transaction(() => {
      registerConfirmationProposal(this.db, {proposalId, payloadHash, domain: DOMAIN,
        actionKind: (plan.category ?? 'member') + '.' + plan.change.op, subjectId: 'owner', scope,
        createdAtUtc: at, expiresAtUtc: at + 86400});
      this.db.prepare('INSERT INTO access_changes VALUES (?,?,?,?,?,NULL)').run(proposalId, owner, payload, 'pending', at);
    });
    return {domain: DOMAIN, proposalId, payloadHash};
  }

  get(proposalId, owner) {
    const row = this.db.prepare(`SELECT c.*, p.expires_at_utc FROM access_changes c
      JOIN confirmation_proposals p ON p.proposal_id=c.id WHERE c.id=? AND c.owner_qq=?`).get(proposalId, owner);
    if (!row) throw new AccessError('proposal_unavailable');
    const state = row.state === 'pending' && row.expires_at_utc <= this.now() ? 'expired' : row.state;
    return {...row, state, plan: JSON.parse(row.plan), hash: sha256(row.plan)};
  }

  claim(proposalId, owner, scope, verify) {
    return this.transaction(() => {
      const row = this.get(proposalId, owner);
      if (row.state === 'expired') throw new AccessError('access_proposal_expired');
      if (row.state !== 'pending') throw new AccessError('access_change_already_submitted');
      const candidate = verify(row.plan);
      const at = this.now();
      const approval = checkApprovalGrant(this.db, {proposalId, domain: DOMAIN, subjectId: 'owner',
        payloadHash: row.hash, scope, nowUtc: at, consume: true});
      if (!approval.ok) throw new AccessError(approval.code);
      markConfirmationProposalCommitted(this.db, {proposalId, subjectId: 'owner', atUtc: at});
      this.db.prepare('UPDATE access_changes SET state=?, updated_at=? WHERE id=?').run('writing', at, proposalId);
      return candidate;
    });
  }

  finish(proposalId, owner, execute) {
    return this.transaction(() => {
      const {plan, state} = this.get(proposalId, owner);
      if (state !== 'writing') throw new AccessError('access_change_already_submitted');
      const result = execute(plan);
      this.db.prepare('UPDATE access_changes SET state=?, updated_at=?, error=? WHERE id=?')
        .run(result.state, this.now(), result.code ?? null, proposalId);
      return result;
    });
  }
}
