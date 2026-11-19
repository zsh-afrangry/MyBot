import path from 'node:path';
import {createHash} from 'node:crypto';
import {CHANNEL, QQ_ID, sessionFor} from '../access-control/index.js';
import {messageText, readHostRecords} from '../session-records/index.js';
import {paginateQueryContent, queryOutputFits} from './log-query-privacy.mjs';
import {agentDatabases} from './source-adapters.js';

const isQQ = value => typeof value === 'string' && QQ_ID.test(value);
const PREVIEW_POINTS = 220;

function preview(text) {
  let end = 0, points = 0;
  for (const character of text) {
    if (points++ === PREVIEW_POINTS) break;
    end += character.length;
  }
  return text.slice(0, end);
}

/** Only retained user/assistant message text from other accounts' trusted QQ DM windows. */
export function privateInteractions({runtimeRoot, from, to, ownerId, peer, direction, expand = false,
  eventRef, limit = 10, offset = 0, ...budget}) {
  if (!isQQ(ownerId) || peer !== undefined && (!isQQ(peer) || peer === ownerId)
    || expand && !peer || eventRef !== undefined && (!expand || !/^event:[a-f0-9]{32}$/u.test(eventRef))
    || direction !== undefined && !['inbound', 'reply'].includes(direction)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw new Error('Invalid private interaction query');
  }

  const matches = [];
  let inspected = 0, failed = 0, unverified = 0;
  for (const file of agentDatabases(runtimeRoot)) {
    const agentId = path.basename(path.dirname(path.dirname(file)));
    const id = agentId.startsWith('qq-user-') ? agentId.slice('qq-user-'.length) : '';
    if (!isQQ(id) || id === ownerId || peer !== undefined && id !== peer) continue;
    inspected++;
    try {
      const sessionKey = sessionFor({role:'member', qq:id});
      const trusted = window => window?.sessionKey === sessionKey && window.channel === CHANNEL
        && window.accountId === 'default' && window.chatType === 'direct';
      const {rows, windows} = readHostRecords(file, {from, to, sessionKey});
      if (!windows.some(trusted)) { unverified++; continue; }
      for (const row of rows) {
        if (!trusted(row.window) || row.record.type !== 'message') continue;
        const message = row.record.message;
        const kind = message?.role === 'user' ? 'inbound' : message?.role === 'assistant' ? 'reply' : undefined;
        if (!kind || direction && kind !== direction) continue;
        const text = messageText(message.content);
        if (kind === 'reply' && !text.trim()) continue;
        const ref = 'event:' + createHash('sha256').update(JSON.stringify([id, row.sessionId, row.seq, row.eventHash])).digest('hex').slice(0, 32);
        if (eventRef && ref !== eventRef) continue;
        matches.push({peer:id, direction:kind, at:row.createdAt, eventRef:ref, seq:row.seq, text});
      }
    } catch { failed++; }
  }
  matches.sort((a, b) => b.at - a.at || a.peer.localeCompare(b.peer) || b.seq - a.seq || a.eventRef.localeCompare(b.eventRef));
  const sourceStatus = [{source:'openclaw-session', status:!inspected ? 'missing' : failed + unverified === inspected && failed ? 'read_failed'
    : failed || unverified ? 'partial' : 'available', inspected, failed, unverified}];

  const page = size => {
    const items = matches.slice(offset, offset + size).map(({seq, at, text, ...row}) => {
      const shown = expand ? text : preview(text);
      return {...row, at:new Date(at).toISOString(), text:shown, textTruncated:shown.length < text.length};
    });
    const nextOffset = offset + items.length < matches.length ? offset + items.length : null;
    return {schemaVersion:1, view:'interactions', from:new Date(from).toISOString(), to:new Date(to).toISOString(),
      total:matches.length, shown:items.length, offset, nextOffset, truncated:nextOffset !== null, sourceStatus, items};
  };
  let value = page(limit);
  // Keep complete items on a page where possible. Only oversized individual
  // messages use the same lossless content cursor as the diagnostic views.
  if (!queryOutputFits(value, budget) && value.shown > 1) {
    let low = 1, high = value.shown - 1;
    value = page(1);
    while (low <= high) {
      const count = Math.floor((low + high) / 2), candidate = page(count);
      if (queryOutputFits(candidate, budget)) { value = candidate; low = count + 1; }
      else high = count - 1;
    }
  }
  return paginateQueryContent(value, budget);
}
