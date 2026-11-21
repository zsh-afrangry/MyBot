import {existsSync} from 'node:fs';
import {homedir} from 'node:os';
import {join, resolve} from 'node:path';
import {DatabaseSync} from 'node:sqlite';

export function openClawStateDirectory(env = process.env) {
  return env.OPENCLAW_STATE_DIR?.trim() ? resolve(env.OPENCLAW_STATE_DIR) : join(homedir(), '.openclaw-fusion');
}

export function mailStateDirectory(env = process.env) {
  return join(openClawStateDirectory(env), 'state', 'kurumi-mail');
}

// The caller authorizes mail history before consulting frozen attachment references.
export function readAttachmentDrafts(documentId) {
  const file = join(mailStateDirectory(), 'mail.sqlite');
  if (!existsSync(file)) return {drafts: [], truncated: false};
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    const rows = db.prepare(`
      SELECT draft_id AS draftId, created_at_utc AS createdAtUtc FROM mail_drafts d
      WHERE instr(d.attachments_json, ?) > 0 AND EXISTS (
        SELECT 1 FROM json_each(d.attachments_json) a
        WHERE CASE WHEN a.type = 'object' THEN json_extract(a.value, '$.documentId') END = ?
      )
      ORDER BY created_at_utc DESC, rowid DESC LIMIT 11
    `).all(documentId, documentId);
    return {drafts: rows.slice(0, 10), truncated: rows.length > 10};
  } finally { db.close(); }
}
