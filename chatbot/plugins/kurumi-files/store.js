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
} from '../../packages/confirmation-core/dist/index.js';
import {insideRoot} from '../../packages/scoped-lease/index.js';
import {
  DEFAULT_LIMITS,
  FILES_DOMAIN,
  FilesError,
  fail,
  proposalIdPattern,
  sha256,
  snapshotIdPattern,
} from './policy.js';

function assertSafeSnapshotDir(dir) {
  const lstat = fs.lstatSync(dir, {throwIfNoEntry: false});
  if (lstat && (lstat.isSymbolicLink() || !lstat.isDirectory())) {
    throw new FilesError('files_state_path_invalid');
  }
}

export class FilesStore {
  constructor(stateRoot, cfg = DEFAULT_LIMITS, now = Date.now) {
    if (typeof stateRoot !== 'string' || !path.isAbsolute(stateRoot)
      || fs.realpathSync(stateRoot) !== stateRoot) {
      throw new FilesError('files_state_root_invalid');
    }
    const directory = path.join(stateRoot, 'state', 'files');
    fs.mkdirSync(directory, {recursive: true, mode: 0o700});
    if (fs.realpathSync(directory) !== directory) {
      throw new FilesError('files_state_path_invalid');
    }
    const snapshotsDir = path.join(directory, 'snapshots');
    assertSafeSnapshotDir(snapshotsDir);
    fs.mkdirSync(snapshotsDir, {recursive: true, mode: 0o700});
    if (fs.realpathSync(snapshotsDir) !== snapshotsDir) {
      throw new FilesError('files_state_path_invalid');
    }

    const file = path.join(directory, 'files.sqlite');
    const stat = fs.lstatSync(file, {throwIfNoEntry: false});
    if (stat && (!stat.isFile() || stat.nlink !== 1)) {
      throw new FilesError('files_state_path_invalid');
    }
    const db = new DatabaseSync(file);
    try {
      fs.chmodSync(file, 0o600);
      db.exec('PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL');
      ensureConfirmationGateSchema(db);
      db.exec(`
        CREATE TABLE IF NOT EXISTS file_proposals (
          id TEXT PRIMARY KEY,
          owner_qq TEXT NOT NULL,
          operation TEXT NOT NULL,
          plan TEXT NOT NULL,
          state TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          result_summary TEXT,
          error TEXT
        ) STRICT;

        CREATE TABLE IF NOT EXISTS file_snapshots (
          snapshot_id TEXT PRIMARY KEY,
          owner_qq TEXT NOT NULL,
          original_path TEXT NOT NULL,
          tier TEXT NOT NULL,
          op_kind TEXT NOT NULL,
          batch_id TEXT,
          sha256 TEXT NOT NULL,
          size_bytes INTEGER NOT NULL,
          mode INTEGER NOT NULL,
          blob_rel_path TEXT NOT NULL,
          created_at INTEGER NOT NULL,
          expires_at INTEGER NOT NULL,
          restored_at INTEGER
        ) STRICT;

        CREATE INDEX IF NOT EXISTS file_snapshots_owner_created_index
          ON file_snapshots(owner_qq, created_at, expires_at);

        CREATE TABLE IF NOT EXISTS file_audit_ops (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          at INTEGER NOT NULL,
          owner_qq TEXT NOT NULL,
          auth_mode TEXT NOT NULL,
          proposal_id TEXT,
          lease_id TEXT,
          operation TEXT NOT NULL,
          tier TEXT NOT NULL,
          target_path TEXT NOT NULL,
          destination_path TEXT,
          snapshot_id TEXT,
          outcome TEXT NOT NULL,
          detail_json TEXT
        ) STRICT;

        CREATE INDEX IF NOT EXISTS file_audit_ops_owner_at_index
          ON file_audit_ops(owner_qq, at);
      `);
      this.db = db;
      this.snapshotsDir = snapshotsDir;
      this.getCfg = typeof cfg === 'function' ? cfg : () => cfg;
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
      domains: [FILES_DOMAIN],
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

  propose(plan, owner, scope, proposalId = randomUUID(), ttlSeconds = this.getCfg().proposalTtlSeconds) {
    if (!proposalIdPattern.test(proposalId)) fail('invalid_proposal_id');
    const payload = JSON.stringify(plan);
    const payloadHash = sha256(payload);
    const at = this.now();
    const expiresAtUtc = at + ttlSeconds;
    this.transaction(() => {
      registerConfirmationProposal(this.db, {
        proposalId,
        payloadHash,
        domain: FILES_DOMAIN,
        actionKind: 'files.' + plan.operation,
        subjectId: 'owner',
        scope,
        createdAtUtc: at,
        expiresAtUtc,
      });
      this.db.prepare(
        'INSERT INTO file_proposals (id, owner_qq, operation, plan, state, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
      ).run(proposalId, owner, plan.operation, payload, 'pending', at, at);
    });
    return {domain: FILES_DOMAIN, proposalId, payloadHash, expiresAtUtc};
  }

  getProposal(proposalId, owner) {
    if (typeof proposalId !== 'string' || !proposalIdPattern.test(proposalId)) {
      fail('invalid_proposal_id');
    }
    const row = this.db.prepare(`SELECT a.*, p.expires_at_utc FROM file_proposals a
      JOIN confirmation_proposals p ON p.proposal_id=a.id WHERE a.id=? AND a.owner_qq=?`).get(proposalId, owner);
    if (!row) fail('proposal_unavailable');
    const state = row.state === 'pending' && row.expires_at_utc <= this.now() ? 'expired' : row.state;
    return {
      ...row,
      state,
      plan: JSON.parse(row.plan),
      hash: sha256(row.plan),
      resultSummary: row.result_summary ? JSON.parse(row.result_summary) : null,
    };
  }

  claimProposal(proposalId, owner, scope, verify) {
    return this.transaction(() => {
      const row = this.getProposal(proposalId, owner);
      if (row.state === 'expired') fail('files_proposal_expired');
      if (row.state !== 'pending') fail('files_proposal_already_submitted');
      verify(row.plan);
      const at = this.now();
      const approval = checkApprovalGrant(this.db, {
        proposalId,
        domain: FILES_DOMAIN,
        subjectId: 'owner',
        payloadHash: row.hash,
        scope,
        nowUtc: at,
        consume: true,
      });
      if (!approval.ok) fail(approval.code);
      markConfirmationProposalCommitted(this.db, {proposalId, subjectId: 'owner', atUtc: at});
      this.db.prepare('UPDATE file_proposals SET state=?, updated_at=? WHERE id=?').run('executing', at, proposalId);
      return {plan: row.plan, hash: row.hash};
    });
  }

  finishProposal(proposalId, owner, {state, summary = null, code = null}) {
    return this.transaction(() => {
      const row = this.getProposal(proposalId, owner);
      if (row.state !== 'executing') fail('files_proposal_already_submitted');
      const at = this.now();
      this.db.prepare(
        'UPDATE file_proposals SET state=?, updated_at=?, result_summary=?, error=? WHERE id=?',
      ).run(state, at, summary ? JSON.stringify(summary) : null, code ?? null, proposalId);
      return {state, updatedAtUtc: at, ...(code ? {code} : {})};
    });
  }

  captureSnapshot(filePath, {owner, opKind, tier, batchId = null, allowOversizeSkip = false}) {
    const cfg = this.getCfg();
    const lstat = fs.lstatSync(filePath);
    if (lstat.isSymbolicLink()) fail('files_symlink_not_allowed');
    if (!lstat.isFile()) fail('files_not_regular_file');
    if (lstat.size > cfg.maxSnapshotFileBytes) {
      if (!allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {snapshotId: null, snapshotSkipped: 'too_large', sizeBytes: lstat.size};
    }

    const buf = fs.readFileSync(filePath);
    if (buf.length > cfg.maxSnapshotFileBytes) {
      if (!allowOversizeSkip) fail('files_snapshot_too_large_requires_confirmation');
      return {snapshotId: null, snapshotSkipped: 'too_large', sizeBytes: buf.length};
    }

    const at = this.now();
    const day = new Date(at * 1000).toISOString().slice(0, 10).replaceAll('-', '');
    const dayDir = path.join(this.snapshotsDir, day);
    assertSafeSnapshotDir(dayDir);
    fs.mkdirSync(dayDir, {recursive: true, mode: 0o700});
    if (fs.realpathSync(dayDir) !== dayDir) fail('files_state_path_invalid');

    const snapshotId = randomUUID();
    const relPath = path.posix.join(day, `${snapshotId}.bin`);
    const absPath = path.join(this.snapshotsDir, relPath);
    const digest = sha256(buf);
    const mode = lstat.mode & 0o777;
    const expiresAt = at + cfg.snapshotRetentionDays * 86400;

    const fd = fs.openSync(absPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
    try {
      let written = 0;
      while (written < buf.length) {
        written += fs.writeSync(fd, buf, written, buf.length - written);
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    let removedBlobs = [];
    try {
      removedBlobs = this.transaction(() => {
        this.db.prepare(`
          INSERT INTO file_snapshots (
            snapshot_id, owner_qq, original_path, tier, op_kind, batch_id,
            sha256, size_bytes, mode, blob_rel_path, created_at, expires_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(snapshotId, owner, filePath, tier, opKind, batchId, digest, buf.length, mode, relPath, at, expiresAt);

        const toDelete = [];
        const expired = this.db.prepare(
          'SELECT snapshot_id, blob_rel_path FROM file_snapshots WHERE expires_at <= ? AND (batch_id IS NULL OR batch_id != ?)',
        ).all(at, batchId ?? '__none__');
        for (const row of expired) {
          this.db.prepare('DELETE FROM file_snapshots WHERE snapshot_id=?').run(row.snapshot_id);
          toDelete.push(row.blob_rel_path);
        }

        let total = this.db.prepare('SELECT COALESCE(SUM(size_bytes), 0) AS total FROM file_snapshots').get().total;
        if (total > cfg.maxSnapshotTotalBytes) {
          const oldest = this.db.prepare(
            'SELECT snapshot_id, size_bytes, blob_rel_path FROM file_snapshots WHERE snapshot_id != ? AND (batch_id IS NULL OR batch_id != ?) ORDER BY created_at ASC, rowid ASC',
          ).all(snapshotId, batchId ?? '__none__');
          for (const row of oldest) {
            if (total <= cfg.maxSnapshotTotalBytes) break;
            this.db.prepare('DELETE FROM file_snapshots WHERE snapshot_id=?').run(row.snapshot_id);
            toDelete.push(row.blob_rel_path);
            total -= row.size_bytes;
          }
        }
        return toDelete;
      });
    } catch (error) {
      fs.rmSync(absPath, {force: true});
      throw error;
    }

    for (const rel of removedBlobs) {
      const target = path.resolve(this.snapshotsDir, rel);
      if (insideRoot(target, this.snapshotsDir)) fs.rmSync(target, {force: true});
    }

    return {
      snapshotId,
      sha256: digest,
      sizeBytes: buf.length,
      createdAtUtc: at,
      expiresAtUtc: expiresAt,
    };
  }

  getSnapshot(snapshotId, owner) {
    if (typeof snapshotId !== 'string' || !snapshotIdPattern.test(snapshotId)) {
      fail('invalid_snapshot_id');
    }
    const row = this.db.prepare(
      'SELECT * FROM file_snapshots WHERE snapshot_id=? AND owner_qq=?',
    ).get(snapshotId, owner);
    if (!row) fail('files_snapshot_not_found');

    const blobPath = path.resolve(this.snapshotsDir, row.blob_rel_path);
    if (!insideRoot(blobPath, this.snapshotsDir)) fail('files_snapshot_corrupted');
    let lstat;
    try {
      lstat = fs.lstatSync(blobPath);
    } catch {
      fail('files_snapshot_corrupted');
    }
    if (lstat.isSymbolicLink() || !lstat.isFile()) fail('files_snapshot_corrupted');
    const buffer = fs.readFileSync(blobPath);
    if (buffer.length !== row.size_bytes || sha256(buffer) !== row.sha256) {
      fail('files_snapshot_corrupted');
    }

    return {
      snapshotId: row.snapshot_id,
      originalPath: row.original_path,
      tier: row.tier,
      opKind: row.op_kind,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      mode: row.mode,
      createdAtUtc: row.created_at,
      expiresAtUtc: row.expires_at,
      restoredAtUtc: row.restored_at ?? null,
      buffer,
    };
  }

  listSnapshots(owner, {limit = 20, pathPrefix} = {}) {
    const capped = Math.max(1, Math.min(100, Number.isSafeInteger(limit) ? limit : 20));
    const rows = this.db.prepare(
      'SELECT snapshot_id, original_path, tier, op_kind, batch_id, sha256, size_bytes, created_at, expires_at, restored_at FROM file_snapshots WHERE owner_qq=? ORDER BY created_at DESC, rowid DESC LIMIT ?',
    ).all(owner, pathPrefix ? 500 : capped);
    const filtered = pathPrefix
      ? rows.filter(r => insideRoot(r.original_path, path.resolve(pathPrefix))).slice(0, capped)
      : rows;
    return filtered.map(row => ({
      snapshotId: row.snapshot_id,
      originalPath: row.original_path,
      tier: row.tier,
      opKind: row.op_kind,
      batchId: row.batch_id ?? null,
      sha256: row.sha256,
      sizeBytes: row.size_bytes,
      createdAtUtc: row.created_at,
      expiresAtUtc: row.expires_at,
      restoredAtUtc: row.restored_at ?? null,
    }));
  }

  markSnapshotRestored(snapshotId, owner) {
    const at = this.now();
    this.db.prepare(
      'UPDATE file_snapshots SET restored_at=? WHERE snapshot_id=? AND owner_qq=?',
    ).run(at, snapshotId, owner);
    return at;
  }

  recordAuditOp({owner, authMode, proposalId = null, leaseId = null, operation, tier, targetPath, destinationPath = null, snapshotId = null, outcome, detail = null}) {
    const at = this.now();
    this.db.prepare(`
      INSERT INTO file_audit_ops (
        at, owner_qq, auth_mode, proposal_id, lease_id, operation, tier,
        target_path, destination_path, snapshot_id, outcome, detail_json
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      at,
      owner,
      authMode,
      proposalId,
      leaseId,
      operation,
      tier,
      targetPath,
      destinationPath,
      snapshotId,
      outcome,
      detail ? JSON.stringify(detail) : null,
    );
  }
}
