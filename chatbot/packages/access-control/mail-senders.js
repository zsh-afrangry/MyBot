import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {accessPolicy} from './index.js';
import {openPolicySource} from './config-source.js';

export const accessChangeFile = stateRoot => path.join(stateRoot, 'state', 'access-admin', 'changes.sqlite');

function writtenSenderChanges(stateRoot, owner, revision) {
  const file = accessChangeFile(stateRoot);
  const dir = path.dirname(file);
  if (!path.isAbsolute(stateRoot) || fs.realpathSync(dir) !== dir) throw Error('invalid_access_change_directory');
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    const stat = fs.lstatSync(file + suffix, {throwIfNoEntry: false});
    if ((!stat && !suffix) || (stat && (!stat.isFile() || stat.nlink !== 1))) {
      throw Error('invalid_access_change_file');
    }
  }
  const db = new DatabaseSync(file, {readOnly: true, timeout: 350});
  try {
    return db.prepare(`
      SELECT c.plan, p.payload_hash
      FROM access_changes c JOIN confirmation_proposals p ON p.proposal_id = c.id
      WHERE c.owner_qq = ? AND c.state = 'written'
        AND p.domain = 'access' AND p.subject_id = 'owner' AND p.status = 'committed'
        AND p.action_kind IN ('mail_sender.add','mail_sender.replace','mail_sender.remove')
        AND json_extract(c.plan, '$.baseRevision') >= ?
        AND EXISTS (
          SELECT 1 FROM approval_grants g
          WHERE g.proposal_id = c.id AND g.domain = p.domain AND g.subject_id = p.subject_id
            AND g.payload_hash = p.payload_hash AND g.status = 'consumed'
        )
      ORDER BY json_extract(c.plan, '$.baseRevision'), c.updated_at, c.rowid
    `).all(owner, revision);
  } finally {
    db.close();
  }
}

// Only confirmed mail_sender writes can supplement the compiled list. The
// repository must still list an added address; unrelated edits await sync.
export function effectiveMailSenders(config, stateRoot, {sourcePolicy} = {}) {
  const admin = config?.plugins?.entries?.['kurumi-access-admin'];
  const compiled = config?.plugins?.entries?.['kurumi-mail']?.config?.allowedSenders;
  const base = Array.isArray(compiled) ? compiled : [];
  const revision = config?.channels?.['kurumi-qq']?.accessControl?.revision;
  const categories = admin?.config?.enabledCategories;
  if (admin?.enabled !== true || !Array.isArray(categories) || !categories.includes('mail_sender')) {
    return {entries: base, revision, available: true};
  }
  try {
    const runtime = accessPolicy(config);
    const owner = runtime.subjects.find(row => row.role === 'owner');
    const source = sourcePolicy ?? openPolicySource(admin.config.sourceRoot).read().policy;
    const sourceOwner = source.subjects.find(row => row.role === 'owner' && row.qq === owner.qq);
    if (!sourceOwner?.enabled || source.revision < runtime.revision) throw Error('invalid_mail_sender_source');

    const entries = new Set(base), declared = new Set(sourceOwner.mailSenders ?? []);
    let effectiveRevision = runtime.revision;
    const changes = writtenSenderChanges(stateRoot, owner.qq, runtime.revision);
    for (const row of changes) {
      const plan = JSON.parse(row.plan);
      if (plan.category !== 'mail_sender' || !Number.isSafeInteger(plan.baseRevision)
        || createHash('sha256').update(row.plan).digest('hex') !== row.payload_hash) {
        throw Error('invalid_mail_sender_receipt');
      }
      // A recorded removal remains effective until an approved addition or
      // a deployment supersedes it, even if a repository edit re-adds it.
      if (plan.before !== null) entries.delete(plan.before);
      if (plan.after !== null && plan.baseRevision < source.revision && declared.has(plan.after)) {
        entries.add(plan.after);
      }
      effectiveRevision = Math.max(effectiveRevision, plan.baseRevision + 1);
    }
    return {entries: [...entries].sort(), revision: effectiveRevision, available: true};
  } catch {
    // Cannot distinguish a revoked sender from a trusted one without the receipts.
    return {entries: [], revision, available: false};
  }
}
