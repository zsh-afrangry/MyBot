import {businessFeedback, notificationFeedback} from '../feedback-core/index.js';
import {account, ownerTarget} from './config.js';
import {Ledger} from './ledger.js';

export const imageDeliveryPrefix = 'image:';
export const subjectDeliveryPrefix = (peer, ownerId) => peer === ownerId ? '' : 'subject:' + peer + ':';
const messageId = /^-?[1-9]\d{0,19}$/u;

// For a send, the writer runs inside the same reservation transaction as outbound.
// Later attempts may not overwrite the business evidence for that reservation.
export function writeImageFeedback(db, {id, peer, action, sourceMessageId, runId, imageStatus, evidence, reserved = false}) {
  if (!messageId.test(sourceMessageId ?? '')) return;
  db.exec(`
    CREATE TABLE IF NOT EXISTS qq_image_feedback (
      delivery_id TEXT PRIMARY KEY, peer TEXT NOT NULL, source_message TEXT NOT NULL, run_id TEXT NOT NULL,
      action TEXT NOT NULL, image_status TEXT NOT NULL, evidence_json TEXT NOT NULL, observed_at INTEGER NOT NULL,
      reserved INTEGER NOT NULL CHECK (reserved IN (0, 1))
    );
    CREATE INDEX IF NOT EXISTS qq_image_feedback_time ON qq_image_feedback(observed_at);
    CREATE INDEX IF NOT EXISTS qq_image_feedback_request ON qq_image_feedback(source_message, peer);
  `);
  db.prepare(`
    INSERT INTO qq_image_feedback
    SELECT ?,?,?,?,?,?,?,?,?
    WHERE NOT EXISTS (SELECT 1 FROM outbound WHERE id=?)
    ON CONFLICT(delivery_id) DO UPDATE SET
      image_status=excluded.image_status, evidence_json=excluded.evidence_json, observed_at=excluded.observed_at, reserved=excluded.reserved
    WHERE peer=excluded.peer AND source_message=excluded.source_message AND action=excluded.action
      AND (image_status<>'generated' OR excluded.image_status='generated')
  `).run(id, peer, sourceMessageId, runId, action, imageStatus, JSON.stringify(evidence), Date.now(), Number(reserved), id);
}

export function recordImageFeedback(cfg, {to, key, ...observation}) {
  const channel = account(cfg);
  const peer = ownerTarget(to, channel);
  const id = subjectDeliveryPrefix(peer, channel.ownerId) + imageDeliveryPrefix + key;
  const ledger = new Ledger(channel.stateDir);
  try {writeImageFeedback(ledger.db, {id, peer, ...observation});}
  finally {ledger.close();}
}

// Read the image facts and the current native receipt in the same SQLite statement.
export function readImageFeedback(db, from, to, sourceMessageId) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qq_image_feedback'").get()) return [];
  const exact = sourceMessageId !== undefined;
  const rows = db.prepare(`
    SELECT i.*, CASE WHEN i.reserved THEN o.status WHEN o.id IS NOT NULL THEN 'unknown' END AS outbound_status, o.message_id
    FROM qq_image_feedback i
    LEFT JOIN outbound o ON i.delivery_id=o.id
    WHERE i.observed_at BETWEEN ? AND ?${exact ? ' AND i.source_message=?' : ''}
    ORDER BY i.observed_at, i.delivery_id
  `).all(from, to, ...(exact ? [sourceMessageId] : []));
  return rows.map(row => {
    const {outbound_status: outboundStatus} = row;
    const unboundSend = !row.reserved && outboundStatus === 'unknown';
    const imageStatus = unboundSend ? 'unknown' : row.image_status;
    const accepted = outboundStatus === 'sent' && messageId.test(row.message_id ?? '');
    const platformStatus = accepted ? 'accepted' : outboundStatus === 'failed' ? 'rejected'
      : row.reserved || outboundStatus ? 'unknown' : 'not_attempted';
    const status = {generated: 'succeeded', no_results: 'skipped', failed: 'failed'}[imageStatus] ?? 'unknown';
    return {
      at: row.observed_at,
      correlation: {qqMessageId: row.source_message, recipientId: row.peer, runId: row.run_id, eventKey: row.delivery_id},
      data: {
        sourceMessageId: row.source_message, imageStatus,
        feedback: businessFeedback(row.action, status, unboundSend ? {} : JSON.parse(row.evidence_json)),
        notification: {...notificationFeedback({action: 'qq.image', platformStatus}),
          ...(accepted && {messageId: row.message_id})},
      },
    };
  });
}
