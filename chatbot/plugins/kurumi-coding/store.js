// Private task facts and domain-owned confirmation transaction. No chat parsing or filesystem execution.
import fs from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {ensureConfirmationGateSchema, registerConfirmationProposal, createNaturalConfirmationBackend,
  checkApprovalGrant, markConfirmationProposalCommitted} from '@kurumi/confirmation-core';
import {digest, fail} from './policy.js';

export class CodingStore {
  constructor(root) {
    fs.mkdirSync(root, {recursive: true, mode: 0o700});
    this.file = path.join(root, 'coding.sqlite'); this.db = new DatabaseSync(this.file);
    fs.chmodSync(this.file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS coding_tasks(id TEXT PRIMARY KEY, request_key TEXT UNIQUE NOT NULL, facts TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coding_commands(request_key TEXT PRIMARY KEY, task_id TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS coding_previews(id TEXT PRIMARY KEY, task_id TEXT NOT NULL, payload TEXT NOT NULL, text TEXT NOT NULL);`);
    // Private, task-bound execution rounds and selected ACP result events. Never a general file reader.
    this.db.exec(`CREATE TABLE IF NOT EXISTS coding_results(task_id TEXT NOT NULL, round_id TEXT NOT NULL, facts TEXT NOT NULL,
      PRIMARY KEY(task_id,round_id));
      CREATE TABLE IF NOT EXISTS coding_result_events(task_id TEXT NOT NULL, round_id TEXT NOT NULL, seq INTEGER NOT NULL, facts TEXT NOT NULL,
      PRIMARY KEY(task_id,round_id,seq));`);
    ensureConfirmationGateSchema(this.db);
  }
  close() { this.db.close(); }
  get(id) { const row = this.db.prepare('SELECT facts FROM coding_tasks WHERE id=?').get(id); return row ? JSON.parse(row.facts) : null; }
  find(key) { const row = this.db.prepare('SELECT facts FROM coding_tasks WHERE request_key=?').get(key); return row ? JSON.parse(row.facts) : null; }
  list() { return this.db.prepare('SELECT facts FROM coding_tasks ORDER BY rowid DESC').all().map(row => JSON.parse(row.facts)); }
  create(task) { this.db.prepare('INSERT INTO coding_tasks VALUES (?,?,?)').run(task.id, task.requestKey, JSON.stringify(task)); }
  save(task) { this.db.prepare('UPDATE coding_tasks SET facts=? WHERE id=?').run(JSON.stringify({...task, updatedAt: Date.now()}), task.id); }
  createResult(task, round) {
    this.transaction(() => {
      this.db.prepare('INSERT INTO coding_results VALUES (?,?,?)').run(task.id, round.roundId, JSON.stringify(round));
      this.save({...task, executionRoundId: round.roundId, state: 'queued', checks: undefined, mergeChecks: undefined, candidate: undefined, reason: undefined, delivery: undefined});
    });
  }
  result(taskId, roundId) {
    const row = this.db.prepare('SELECT facts FROM coding_results WHERE task_id=? AND round_id=?').get(taskId, roundId);
    return row ? JSON.parse(row.facts) : null;
  }
  saveResult(taskId, round) {
    this.db.prepare('UPDATE coding_results SET facts=? WHERE task_id=? AND round_id=?').run(JSON.stringify(round), taskId, round.roundId);
  }
  appendResultEvent(taskId, roundId, event) {
    this.db.prepare(`INSERT INTO coding_result_events SELECT ?,?,COALESCE(MAX(seq),0)+1,?
      FROM coding_result_events WHERE task_id=? AND round_id=?`).run(taskId, roundId, JSON.stringify(event), taskId, roundId);
  }
  resultEvents(taskId, roundId) {
    return this.db.prepare('SELECT facts FROM coding_result_events WHERE task_id=? AND round_id=? ORDER BY seq').all(taskId, roundId).map(row => JSON.parse(row.facts));
  }
  transaction(action) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = action(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  findCommand(key) {return this.db.prepare('SELECT * FROM coding_commands WHERE request_key=?').get(key);}
  command(key, taskId, hash) {
    const old = this.db.prepare('SELECT * FROM coding_commands WHERE request_key=?').get(key);
    if (old) { if (old.task_id !== taskId || old.hash !== hash) throw fail('coding_request_key_conflict'); return false; }
    this.db.prepare('INSERT INTO coding_commands VALUES (?,?,?)').run(key, taskId, hash); return true;
  }
  invalidate(taskId) {
    this.db.prepare(`UPDATE confirmation_proposals SET status='cancelled',updated_at_utc=? WHERE domain='coding'
      AND status='pending' AND proposal_id IN (SELECT id FROM coding_previews WHERE task_id=?)`).run(Math.floor(Date.now() / 1000), taskId);
  }
  preview(task, payload, text, scope) {
    return this.transaction(() => {
      this.invalidate(task.id);
      const proposalId = randomUUID(), payloadHash = digest(JSON.stringify(payload)), at = Math.floor(Date.now() / 1000);
      registerConfirmationProposal(this.db, {proposalId, payloadHash, domain: 'coding', actionKind: payload.directoryPlan ? 'coding.writeback' : 'coding.merge', subjectId: 'owner',
        scope, createdAtUtc: at, expiresAtUtc: at + 86400});
      this.db.prepare('INSERT INTO coding_previews VALUES (?,?,?,?)').run(proposalId, task.id, JSON.stringify(payload), text);
      return {ok: true, status: 'pending', domain: 'coding', proposalId, payloadHash, previewText: text};
    });
  }
  getPreview(id) {
    const row = this.db.prepare('SELECT * FROM coding_previews WHERE id=?').get(id);
    return row ? {taskId: row.task_id, payload: JSON.parse(row.payload), text: row.text} : null;
  }
  claimMerge(task, proposalId, scope) {
    return this.transaction(() => {
      const current = this.get(task.id), preview = this.getPreview(proposalId);
      if (current?.state !== 'ready' || preview?.taskId !== task.id) throw fail('merge_not_pending');
      const result = checkApprovalGrant(this.db, {proposalId, domain: 'coding', subjectId: 'owner',
        payloadHash: digest(JSON.stringify(preview.payload)), scope, nowUtc: Math.floor(Date.now() / 1000), consume: true});
      if (!result.ok) throw fail(result.code);
      markConfirmationProposalCommitted(this.db, {proposalId, subjectId: 'owner', atUtc: Math.floor(Date.now() / 1000)});
      this.save({...current, state: 'merging', mergeProposalId: proposalId, mergeCandidate: preview.payload.candidate});
      return preview.payload;
    });
  }
  get natural() { return createNaturalConfirmationBackend(this.db, {subjectId: 'owner', domains: ['coding']}); }
}
