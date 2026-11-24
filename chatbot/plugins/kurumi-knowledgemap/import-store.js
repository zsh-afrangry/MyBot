import fs from 'node:fs';
import path from 'node:path';
import {createHash, randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {
  checkApprovalGrant,
  createNaturalConfirmationBackend,
  ensureConfirmationGateSchema,
  markConfirmationProposalCommitted,
  registerConfirmationProposal,
} from '../../packages/confirmation-core/dist/index.js';

export const BILLS_IMPORT_DOMAIN = 'bills_import';
export const BILLS_IMPORT_BACKEND_ID = 'kurumi-bills-import';
export const BILL_IMPORT_PROPOSAL_TTL_SECONDS = 1800;
export const proposalIdPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu;

export const sha256 = value => createHash('sha256').update(value).digest('hex');

export class BillImportError extends Error {
  constructor(code = 'bill_import_failed', message) {
    super(message ?? code);
    this.code = code;
  }
}

export function failImport(code, message) {
  throw new BillImportError(code, message);
}

export class BillImportStore {
  constructor(stateRoot, now = Date.now) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
      || fs.realpathSync(stateRoot) !== stateRoot) {
      failImport('bill_import_state_root_invalid', '账单导入状态目录无效');
    }
    const directory = path.join(stateRoot, 'state', 'knowledgemap');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.realpathSync(directory) !== directory) {
      failImport('bill_import_state_path_invalid', '账单导入状态目录不能包含符号链接');
    }
    const file = path.join(directory, 'bill-imports.sqlite');
    const stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      failImport('bill_import_state_path_invalid', '账单导入状态库路径不安全');
    }
    const db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      ensureConfirmationGateSchema(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS bill_import_proposals (
          id TEXT PRIMARY KEY,
          owner_qq TEXT NOT NULL,
          source_path TEXT NOT NULL,
          source_filename TEXT NOT NULL,
          sheet_name TEXT,
          file_sha256 TEXT NOT NULL,
          preview_hash TEXT NOT NULL,
          plan_json TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          result_json TEXT,
          error TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS bill_import_proposals_owner_created_index
          ON bill_import_proposals(owner_qq, created_at);
      `);
      this.db = db;
      this.file = file;
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
      domains: [BILLS_IMPORT_DOMAIN],
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

  propose(plan, owner, scope, proposalId = randomUUID(), ttlSeconds = BILL_IMPORT_PROPOSAL_TTL_SECONDS) {
    if (!proposalIdPattern.test(proposalId)) failImport('invalid_proposal_id', '无效的导入提案 ID');
    const canonicalPlan = JSON.stringify(plan);
    const payloadHash = sha256(canonicalPlan);
    const at = this.now();
    const expiresAtUtc = at + ttlSeconds;
    this.transaction(() => {
      registerConfirmationProposal(this.db, {
        proposalId,
        payloadHash,
        domain: BILLS_IMPORT_DOMAIN,
        actionKind: 'bills.import',
        subjectId: 'owner',
        scope,
        createdAtUtc: at,
        expiresAtUtc,
      });
      this.db.prepare(`
        INSERT INTO bill_import_proposals (
          id, owner_qq, source_path, source_filename, sheet_name, file_sha256,
          preview_hash, plan_json, state, created_at, updated_at
        ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
      `).run(
        proposalId,
        owner,
        plan.sourcePath,
        plan.fileName,
        plan.sheetName ?? null,
        plan.fileSha256,
        plan.previewHash,
        canonicalPlan,
        'pending',
        at,
        at,
      );
    });
    return {domain: BILLS_IMPORT_DOMAIN, proposalId, payloadHash, expiresAtUtc};
  }

  getProposal(proposalId, owner) {
    if (typeof proposalId !== 'string' || !proposalIdPattern.test(proposalId)) {
      failImport('invalid_proposal_id', '请提供有效的导入提案 ID');
    }
    const row = this.db.prepare(`
      SELECT a.*, p.expires_at_utc, p.payload_hash
      FROM bill_import_proposals a
      JOIN confirmation_proposals p ON p.proposal_id = a.id
      WHERE a.id = ? AND a.owner_qq = ?
    `).get(proposalId, owner);
    if (!row) failImport('proposal_unavailable', '未找到对应的账单导入提案');
    const state = row.state === 'pending' && row.expires_at_utc <= this.now() ? 'expired' : row.state;
    return {
      ...row,
      state,
      plan: JSON.parse(row.plan_json),
      hash: sha256(row.plan_json),
      result: row.result_json ? JSON.parse(row.result_json) : null,
    };
  }

  claimProposal(proposalId, owner, scope, verify) {
    return this.transaction(() => {
      const row = this.getProposal(proposalId, owner);
      if (row.state === 'expired') failImport('bill_import_proposal_expired', '账单导入提案已过期，请重新预览');
      if (row.state !== 'pending') failImport('bill_import_already_submitted', '该账单导入提案已提交或不可重复执行');
      const verified = verify(row);
      const at = this.now();
      const approval = checkApprovalGrant(this.db, {
        proposalId,
        domain: BILLS_IMPORT_DOMAIN,
        subjectId: 'owner',
        payloadHash: row.hash,
        scope,
        nowUtc: at,
        consume: true,
      });
      if (!approval.ok) failImport(approval.code, '尚未获得本人对本次导入预览的有效确认');
      markConfirmationProposalCommitted(this.db, {proposalId, subjectId: 'owner', atUtc: at});
      this.db.prepare('UPDATE bill_import_proposals SET state = ?, updated_at = ? WHERE id = ?')
        .run('executing', at, proposalId);
      return {row, plan: row.plan, verified};
    });
  }

  finishProposal(proposalId, owner, {state, result = null, code = null}) {
    return this.transaction(() => {
      const row = this.getProposal(proposalId, owner);
      if (row.state !== 'executing') failImport('bill_import_already_submitted', '导入提案状态已结束');
      const at = this.now();
      this.db.prepare(
        'UPDATE bill_import_proposals SET state = ?, updated_at = ?, result_json = ?, error = ? WHERE id = ?',
      ).run(state, at, result ? JSON.stringify(result) : null, code ?? null, proposalId);
      return {state, updatedAtUtc: at, ...(code ? {code} : {})};
    });
  }

  recoverCommitted(proposalId, owner, result) {
    return this.transaction(() => {
      const row = this.getProposal(proposalId, owner);
      if (!['executing', 'unknown', 'committed'].includes(row.state)) {
        failImport('bill_import_already_submitted', '导入提案状态不支持恢复');
      }
      if (row.state === 'committed') return {state: 'committed', updatedAtUtc: row.updated_at};
      const at = this.now();
      this.db.prepare(
        'UPDATE bill_import_proposals SET state = ?, updated_at = ?, result_json = ?, error = NULL WHERE id = ?',
      ).run('committed', at, JSON.stringify(result), proposalId);
      return {state: 'committed', updatedAtUtc: at};
    });
  }
}
