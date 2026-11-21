// Read-only native transcript adapter shared by diagnostics and domain readers.
// No identity inference, memory masks, plugin imports or writes to the host database.
import fs from 'node:fs';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {zstdDecompressSync} from 'node:zlib';
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const decode = (json, zstd) => json || zstdDecompressSync(zstd, {maxOutputLength: 64 * 1024 * 1024}).toString('utf8');
export function readHostRecords(file, {from = 0, to = Number.MAX_SAFE_INTEGER, sessionKey, sessionId, archives = false} = {}) {
  if (!fs.existsSync(file)) return {rows: [], windows: []};
  const db = new DatabaseSync(file, {readOnly: true});
  try {
    db.exec('PRAGMA busy_timeout=2000; BEGIN');
    let windows = [];
    try {windows = db.prepare(`SELECT session_id AS sessionId, session_key AS sessionKey, created_at AS createdAt,
      updated_at AS updatedAt, channel, account_id AS accountId, chat_type AS chatType,
      primary_conversation_id AS conversationId FROM session_windows${sessionId ? ' WHERE session_id=?' : ''}`).all(...(sessionId ? [sessionId] : []));} catch { /* legacy diagnostics */ }
    const windowMap = new Map(windows.map(w => [w.sessionId, w]));
    const rows = [], seen = new Set();
    const add = (id, seq, raw, createdAt, window, source) => {
      const record = JSON.parse(raw), eventHash = hash(raw), at = Date.parse(record.timestamp) || Number(record.timestamp) || createdAt;
      if (at < from || at > to || (sessionKey && window?.sessionKey !== sessionKey) || (sessionId && id !== sessionId)) return;
      const key = JSON.stringify([id, seq, eventHash]); if (seen.has(key)) return; seen.add(key);
      rows.push({sessionId: id, seq, eventHash, record, raw, createdAt: at, window, source});
    };
    for (const row of db.prepare(`SELECT session_id, seq, event_json, event_zstd, created_at FROM transcript_events
      WHERE created_at BETWEEN ? AND ?${sessionId ? ' AND session_id=?' : ''} ORDER BY created_at,seq`).iterate(from, to, ...(sessionId ? [sessionId] : []))) {
      if (sessionKey && windowMap.get(row.session_id)?.sessionKey !== sessionKey) continue;
      add(row.session_id, row.seq, decode(row.event_json, row.event_zstd), row.created_at, windowMap.get(row.session_id), 'transcript_events');
    }
    if (archives && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_transcript_archives'").get()) {
      const filter = sessionId ? ' WHERE session_id=?' : sessionKey ? ' WHERE session_key=?' : '';
      const query = `SELECT archive_name,session_id,session_key,archive_blob,archive_sha256,encoding,created_at FROM session_transcript_archives${filter} ORDER BY created_at`;
      const selector = sessionId || sessionKey;
      for (const row of db.prepare(query).iterate(...(selector ? [selector] : []))) {
        if (sessionKey && row.session_key !== sessionKey) continue;
        const bytes = Buffer.from(row.archive_blob); if (hash(bytes) !== row.archive_sha256) throw Error('Transcript archive hash mismatch');
        if (!['zstd', 'identity', 'jsonl', 'plain'].includes(row.encoding)) throw Error('Unsupported transcript archive encoding');
        const text = (row.encoding === 'zstd' ? zstdDecompressSync(bytes, {maxOutputLength: 64 * 1024 * 1024}) : bytes).toString('utf8');
        const lines = text.trimEnd().split('\n'), header = JSON.parse(lines.shift());
        if (header.type !== 'session' || header.id !== row.session_id) throw Error('Transcript archive identity mismatch');
        const window = windowMap.get(row.session_id) ?? {sessionId: row.session_id, sessionKey: row.session_key};
        lines.forEach((line, i) => add(row.session_id, i + 1, line, row.created_at, window, 'session_transcript_archives'));
      }
    }
    db.exec('COMMIT'); return {rows: rows.sort((a,b) => a.createdAt - b.createdAt || a.seq - b.seq), windows};
  } finally {db.close();}
}
export function messageText(content) {
  return typeof content === 'string' ? content : Array.isArray(content) ? content.filter(p => p?.type === 'text').map(p => p.text ?? '').join('\n') : '';
}
