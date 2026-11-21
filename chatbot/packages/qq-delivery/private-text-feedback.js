// Optional observer for QQ private text. The outbound ledger owns sends and retries.
import {notificationFeedback, observeFeedback} from '../feedback-core/index.js';

const action = 'qq.private_text_reply';
const cronAction = 'qq.cron_text';
const cronRunPrefix = 'cron:';
const schema = `
  CREATE TABLE IF NOT EXISTS qq_reply_parts (
    id TEXT PRIMARY KEY, delivery_key TEXT NOT NULL, bot TEXT NOT NULL, peer TEXT NOT NULL,
    source_message TEXT NOT NULL, part INTEGER NOT NULL, parts INTEGER NOT NULL, planned_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS qq_reply_planned_at ON qq_reply_parts(planned_at);
  CREATE INDEX IF NOT EXISTS qq_reply_subject ON qq_reply_parts(bot,peer);
  CREATE INDEX IF NOT EXISTS qq_reply_source ON qq_reply_parts(source_message,peer);
  CREATE INDEX IF NOT EXISTS qq_outbound_message ON outbound(message_id);
  CREATE TABLE IF NOT EXISTS qq_reply_ack (
    bot TEXT NOT NULL, peer TEXT NOT NULL, quoted_id TEXT NOT NULL, message_id TEXT NOT NULL,
    observed_at INTEGER NOT NULL, PRIMARY KEY(bot,peer,quoted_id,message_id)
  );`;

export function isReceiptReply(event) {
  if (!Array.isArray(event.message) || event.message_type !== 'private' || event.post_type !== 'message') return false;
  if (event.sender?.user_id != null && String(event.sender.user_id) !== String(event.user_id)) return false;
  const replies = event.message.filter(segment => segment.type === 'reply');
  if (replies.length !== 1 || !event.message.every(segment => ['reply','text'].includes(segment.type))) return false;
  const text = event.message.filter(segment => segment.type === 'text').map(segment => segment.data?.text).join('').trim();
  return /^我?(?:已经|已)?收到了?[。.!！]?$/u.test(text);
}

export function privateTextFeedback(db, {selfId, peer, sourceMessage, log}) {
  return {
    plan(deliveryKey, parts) {
      observeFeedback(sourceMessage.startsWith(cronRunPrefix) ? cronAction : action, log, () => {
        db.exec('BEGIN IMMEDIATE');
        try {
          db.exec(schema);
          const first = deliveryKey + ':0';
          // A replay of an older send cannot establish its original recipient or segment count.
          if (!db.prepare('SELECT 1 FROM outbound WHERE id=? UNION ALL SELECT 1 FROM qq_reply_parts WHERE id=?').get(first, first)) {
            const insert = db.prepare('INSERT INTO qq_reply_parts VALUES (?,?,?,?,?,?,?,?)');
            const at = Date.now();
            for (let i = 0; i < parts; i++) insert.run(deliveryKey + ':' + i, deliveryKey, selfId, peer, sourceMessage, i+1, parts, at);
          }
          db.exec('COMMIT');
        } catch (error) { db.exec('ROLLBACK'); throw error; }
      });
    },
    acknowledge(quotedId, observedAt) {
      observeFeedback(action, log, () => {
        if (!hasReplyFeedback(db)) return;
        // The websocket reply can arrive before the sending HTTP request returns.
        // Keep its reference only if an eligible accepted or unresolved attempt exists.
        db.prepare(`INSERT OR IGNORE INTO qq_reply_ack (bot, peer, quoted_id, message_id, observed_at)
          SELECT ?,?,?,?,? WHERE EXISTS (
            SELECT 1 FROM qq_reply_parts p JOIN outbound o ON o.id=p.id
            WHERE p.bot=? AND p.peer=? AND o.at<=? AND (o.message_id=? OR o.status='unknown')
          )`).run(selfId, peer, quotedId, sourceMessage, observedAt, selfId, peer, observedAt, quotedId);
      });
    },
  };
}

function hasReplyFeedback(db) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='qq_reply_parts'").get();
}

const trackedParts = `
    SELECT p.id, coalesce(o.status,'not_attempted') AS status, o.message_id, p.planned_at AS at,
           p.delivery_key, p.peer, p.bot, p.source_message, p.part, p.parts, a.message_id AS ack_id, a.observed_at AS ack_at
      FROM qq_reply_parts p LEFT JOIN outbound o ON p.id=o.id
      LEFT JOIN qq_reply_ack a ON o.status='sent'
        AND NOT EXISTS (SELECT 1 FROM outbound other WHERE other.message_id=o.message_id AND other.id<>o.id)
        AND a.rowid=(SELECT ack.rowid FROM qq_reply_ack ack
          WHERE ack.bot=p.bot AND ack.peer=p.peer AND ack.quoted_id=o.message_id AND ack.observed_at>=o.at
          ORDER BY ack.observed_at,ack.rowid LIMIT 1)`;

export function readCronDeliveryParts(db, runId, peer, endedAtMs) {
  if (!hasReplyFeedback(db)) return [];
  if (endedAtMs !== undefined) {
    const startIndex = runId.lastIndexOf(':') + 1;
    const prefix = runId.slice(0, startIndex);
    const startedAtMs = Number(runId.slice(startIndex));
    const ids = db.prepare('SELECT DISTINCT source_message FROM qq_reply_parts WHERE source_message GLOB ? AND peer=?')
      .all(prefix + '*', peer).map(row => row.source_message).filter(id => {
        const suffix = id.slice(startIndex);
        return /^\d+$/u.test(suffix) && Number(suffix) >= startedAtMs && Number(suffix) < endedAtMs;
      });
    if (ids.length !== 1) return [];
    [runId] = ids;
  }
  return db.prepare(trackedParts + ' WHERE p.source_message=? AND p.peer=? ORDER BY p.part').all(runId,peer);
}

// Includes planned segments that never reached reserve(). All reads share a snapshot.
export function readDeliveryRows(db, from, to) {
  if (!hasReplyFeedback(db)) return db.prepare('SELECT * FROM outbound WHERE at BETWEEN ? AND ? ORDER BY at,id').all(from,to);
  return db.prepare(`
    SELECT o.id, o.status, o.message_id, o.at, NULL AS delivery_key, NULL AS peer, NULL AS bot,
           NULL AS source_message, NULL AS part, NULL AS parts, NULL AS ack_id, NULL AS ack_at
      FROM outbound o WHERE o.at BETWEEN ? AND ? AND NOT EXISTS (SELECT 1 FROM qq_reply_parts p WHERE p.id=o.id)
    UNION ALL
    ${trackedParts} WHERE p.planned_at BETWEEN ? AND ?
    ORDER BY at,delivery_key,part,id`).all(from,to,from,to);
}

export function replyFeedbackData(row) {
  if (!row.delivery_key) return {};
  const fromCron = row.source_message.startsWith(cronRunPrefix);
  return {
    ...notificationFeedback({
      action: fromCron ? cronAction : action,
      platformStatus: ({sent:'accepted', failed:'rejected', not_attempted:'not_attempted'})[row.status] ?? 'unknown',
      acknowledgement: row.ack_id && {id:row.ack_id, at:row.ack_at, source:'onebot.recipient_quoted_reply'},
    }),
    ...(fromCron ? {runId:row.source_message} : {sourceMessageId:row.source_message}),
    part:row.part, parts:row.parts,
  };
}
