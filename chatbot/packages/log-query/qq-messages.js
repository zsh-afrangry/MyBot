import {existsSync} from 'node:fs';
import {join} from 'node:path';
import {agentFor, QQ_ID, sessionFor} from '../access-control/index.js';
import {transcriptEvents} from './source-adapters.js';
import {callMembers, groupTurns} from './log-query-views.mjs';
import {eventReference, paginateQueryContent, queryOutputFits} from './log-query-privacy.mjs';

export function readQqTranscript(runtimeRoot, peer, from, to, options = {}) {
  if (typeof peer !== 'string' || !QQ_ID.test(peer)) throw Error('Invalid QQ private peer');
  const events = [], sourceStatus = [];
  for (const role of ['owner', 'member']) {
    const subject = {qq:peer, role}, agent = agentFor(subject);
    const file = join(runtimeRoot, 'agents', agent, 'agent', 'openclaw-agent.sqlite');
    if (!existsSync(file)) continue;
    try {
      const result = transcriptEvents(file, from, to, {...options, privateSessionKey:sessionFor(subject)});
      sourceStatus.push({source:'openclaw-session', agent, status:result.windows.length ? 'available' : 'unverified'});
      for (const event of result.events) events.push(event);
    } catch {
      sourceStatus.push({source:'openclaw-session', agent, status:'read_failed'});
    }
  }
  if (!sourceStatus.length) sourceStatus.push({source:'openclaw-session', status:'missing'});
  events.sort((a,b) => a.epochMs-b.epochMs);
  return {events, sourceStatus};
}

function actionsFor(turn) {
  return turn.calls.flatMap(call => callMembers(call).flatMap(event => {
    if (event.kind !== 'agent.tool_call') return [];
    const {tool, arguments:args} = event.data;
    const action = args?.action ?? args?.args?.action;
    return /^[a-z][a-z0-9_]{0,79}$/u.test(tool)
      ? [typeof action === 'string' && /^[a-z][a-z0-9_]{0,39}$/u.test(action) ? tool+'.'+action : tool] : [];
  })).filter((value, index, all) => all.indexOf(value) === index).slice(0, 8);
}

export function qqMessages({runtimeRoot, peer, from, to, direction, limit = 10, offset = 0, ...budget}) {
  if (direction !== undefined && !['inbound','reply'].includes(direction)
    || !Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0) {
    throw Error('Invalid QQ message query');
  }
  const {events, sourceStatus} = readQqTranscript(runtimeRoot, peer, from, to);
  const {turns} = groupTurns(events);
  let inbound = 0;
  const candidates = [];
  for (const event of events) {
    const dir = event.kind === 'agent.inbound' ? 'inbound' : event.kind === 'agent.reply' ? 'reply' : undefined;
    if (!dir) continue;
    const actions = dir === 'inbound' ? actionsFor(turns[inbound++]) : [];
    if (direction && direction !== dir) continue;
    const preview = Array.from(String(event.data.text ?? '').replace(/\s+/gu,' ').trim());
    candidates.push({at:event.at, direction:dir, eventRef:eventReference(event), actions,
      preview:preview.slice(0,100).join(''), previewTruncated:preview.length > 100});
  }
  candidates.reverse();
  const page = size => {
    const items = candidates.slice(offset, offset+size);
    const nextOffset = offset + items.length < candidates.length ? offset + items.length : null;
    return {schemaVersion:1, view:'qq-messages', peer, from:new Date(from).toISOString(), to:new Date(to).toISOString(),
      total:candidates.length, shown:items.length, offset, nextOffset, truncated:nextOffset !== null, sourceStatus, items};
  };
  let value = page(limit);
  while (value.shown > 1 && !queryOutputFits(value, budget)) value = page(value.shown - 1);
  return paginateQueryContent(value, budget);
}
