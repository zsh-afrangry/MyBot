import {readQqTranscript} from './qq-messages.js';
import {accessLedgerStages, readAccessEvidence} from './access-evidence.js';
import {eventReference, paginateQueryContent, queryOutputFits} from './log-query-privacy.mjs';
import {eventError} from './log-query-views.mjs';

const messageIdPattern = /^[+-]?\d{1,20}$/u;
const refPattern = /^event:[a-f0-9]{32}$/u;
const isMessage = event => ['agent.inbound','agent.reply'].includes(event.kind);
const isAccessTool = event => ['kurumi_access','personal_confirmation'].includes(event.data.tool);
const sameRun = (event, anchor) => anchor?.correlation.runId && event.correlation.runId===anchor.correlation.runId
  && event.correlation.sessionId===anchor.correlation.sessionId;
const ref = event => ({at:event.at,eventRef:eventReference(event)});

const covered = (at, from, to) => at+999>=from && at<=to;
function ledgerRecord(record, from, to) {
  return {...record, coverage:covered(Date.parse(record.at),from,to) ? 'recorded' : 'outside_window'};
}

function emptyCoverage(sources) {
  return sources.length && sources.every(source=>source.status==='available') ? 'no_record' : 'source_unavailable';
}

export function qqEvidence({runtimeRoot, peer, from, to, eventRef, messageId, channelEvents, runtimeEvents, limit=10, offset=0, ...budget}) {
  if (Number(eventRef !== undefined)+Number(messageId !== undefined)!==1
    || eventRef !== undefined && !refPattern.test(eventRef) || messageId !== undefined && !messageIdPattern.test(messageId)
    || !Number.isSafeInteger(limit) || limit<1 || limit>100 || !Number.isSafeInteger(offset) || offset<0) {
    throw Error('Select one QQ message ID or event reference');
  }
  const {events,sourceStatus} = readQqTranscript(runtimeRoot,peer,from,to);
  const {proposals,grants,source} = readAccessEvidence(runtimeRoot,peer);
  const anchor = eventRef && events.find(event => isMessage(event) && eventReference(event)===eventRef);
  const byTurn = new Set(events.filter(event => isAccessTool(event) && sameRun(event,anchor)
    && ['agent.tool_result','agent.tool_nested'].includes(event.kind)).flatMap(event => [
    event.data.summary?.proposalId, ...((event.data.targetResults??[]).filter(target => target.domain==='access').map(target => target.proposalId)),
  ]).filter(Boolean));
  const deliveries = channelEvents.filter(event => event.kind==='qq.delivery_state' && event.correlation.recipientId===peer
    && typeof event.data.sourceMessageId==='string');
  const channelSources = channelEvents.sourceStatus ?? [];
  const effectiveMessageIds = new Set(messageId ? [messageId] : []);
  if (messageId) for (const delivery of deliveries) {
    if (delivery.correlation.qqMessageId===messageId) effectiveMessageIds.add(delivery.data.sourceMessageId);
  }
  const items = [], selectedTimes = anchor ? [anchor.epochMs] : [];
  for (const proposal of proposals) {
    const approvals = grants.filter(grant => grant.proposal_id===proposal.id);
    if (!byTurn.has(proposal.id) && !effectiveMessageIds.has(proposal.source_message_id)
      && !effectiveMessageIds.has(proposal.presentation_message_id)
      && !approvals.some(grant=>effectiveMessageIds.has(grant.confirmation_message_id))) continue;
    const {preview,confirmations,write} = accessLedgerStages(proposal,approvals);
    const messageTimes = new Map([
      [proposal.source_message_id,1000*proposal.created_at_utc],
      ...approvals.map(grant=>[grant.confirmation_message_id,1000*grant.issued_at_utc]),
    ].filter(([id])=>id));
    for (const [id,at] of messageTimes) if (effectiveMessageIds.has(id)) selectedTimes.push(at);
    const versionChecks = events.filter(event => event.data.tool==='kurumi_access' && event.data.accessVersions?.proposalId===proposal.id)
      .map(event=>({...ref(event),source:event.data.accessVersions.source,runtime:event.data.accessVersions.runtime}));
    const replies = deliveries.filter(event=>messageTimes.has(event.data.sourceMessageId)).map(event=>({
      ...ref(event), sourceMessageId:event.data.sourceMessageId, messageId:event.correlation.qqMessageId,
      deliveryKey:event.correlation.eventKey, part:event.data.part, parts:event.data.parts, platformStatus:event.data.platformStatus,
      recipientStatus:event.data.recipientStatus, clientDelivery:event.data.clientDelivery, readStatus:event.data.readStatus,
    }));
    const replyCoverage = [...messageTimes].map(([sourceMessageId,at])=>({sourceMessageId,
      status:replies.some(reply=>reply.sourceMessageId===sourceMessageId) ? 'recorded'
        : !covered(at,from,to) ? 'outside_window' : emptyCoverage(channelSources),
    }));
    items.push({proposalId:proposal.id,action:proposal.action_kind,
      preview:ledgerRecord(preview,from,to), confirmations:confirmations.map(record=>ledgerRecord(record,from,to)),
      write:ledgerRecord(write,from,to), versionChecks,
      versionCoverage:versionChecks.length ? 'recorded' : emptyCoverage(sourceStatus),
      replies,replyCoverage});
  }
  const selectionStatus = selectedTimes.length && selectedTimes.every(at=>!covered(at,from,to)) ? 'outside_window'
    : items.length ? 'recorded' : emptyCoverage(eventRef && !anchor ? sourceStatus : [source]);
  const selection = {status:selectionStatus,...(eventRef ? {eventRef,found:Boolean(anchor),...(anchor&&ref(anchor))} : {messageId})};
  const context = runtimeEvents.flatMap(event => {
    if (!selectedTimes.some(at=>Math.abs(event.epochMs-at)<=3_000)) return [];
    const error = eventError(event);
    return error ? [{...ref(event),source:event.source,code:error.code,association:'time_adjacent'}] : [];
  }).slice(-10);
  const page = size => {
    const rows = items.slice(offset,offset+size);
    const nextOffset = offset+rows.length<items.length ? offset+rows.length : null;
    return {schemaVersion:1,view:'qq-evidence',peer,from:new Date(from).toISOString(),to:new Date(to).toISOString(),
      selection,total:items.length,shown:rows.length,offset,nextOffset,truncated:nextOffset!==null,
      sourceStatus:[...sourceStatus,source,...channelSources,...(runtimeEvents.sourceStatus??[])],context,items:rows};
  };
  let value = page(limit);
  while (value.shown>1 && !queryOutputFits(value,budget)) value = page(value.shown-1);
  return paginateQueryContent(value,budget);
}
