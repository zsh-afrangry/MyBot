import {readQqTranscript} from './qq-messages.js';
import {accessLedgerStages, readAccessEvidence} from './access-evidence.js';
import {eventReference, paginateQueryContent, queryOutputFits} from './log-query-privacy.mjs';

const messageIdPattern = /^[+-]?\d{1,20}$/u;
const refPattern = /^event:[a-f0-9]{32}$/u;
const isMessage = event => ['agent.inbound','agent.reply'].includes(event.kind);
const isAccessTool = event => ['kurumi_access','personal_confirmation'].includes(event.data.tool);
const sameRun = (event, anchor) => anchor?.correlation.runId && event.correlation.runId===anchor.correlation.runId
  && event.correlation.sessionId===anchor.correlation.sessionId;
const ref = event => ({at:event.at,eventRef:eventReference(event)});

export function qqEvidence({runtimeRoot, peer, from, to, eventRef, messageId, channelEvents, limit=10, offset=0, ...budget}) {
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
  const effectiveMessageIds = new Set(messageId ? [messageId] : []);
  if (messageId) for (const delivery of deliveries) {
    if (delivery.correlation.qqMessageId===messageId) effectiveMessageIds.add(delivery.data.sourceMessageId);
  }
  const items = [];
  for (const proposal of proposals) {
    const approvals = grants.filter(grant => grant.proposal_id===proposal.id);
    if (!byTurn.has(proposal.id) && !effectiveMessageIds.has(proposal.source_message_id)
      && !effectiveMessageIds.has(proposal.presentation_message_id)
      && !approvals.some(grant=>effectiveMessageIds.has(grant.confirmation_message_id))) continue;
    const {preview,confirmations,write} = accessLedgerStages(proposal,approvals);
    const messages = new Set([proposal.source_message_id,...approvals.map(grant=>grant.confirmation_message_id)].filter(Boolean));
    const versionChecks = events.filter(event => event.data.tool==='kurumi_access' && event.data.accessVersions?.proposalId===proposal.id)
      .map(event=>({...ref(event),source:event.data.accessVersions.source,runtime:event.data.accessVersions.runtime}));
    const replies = deliveries.filter(event=>messages.has(event.data.sourceMessageId)).map(event=>({
      ...ref(event), sourceMessageId:event.data.sourceMessageId, messageId:event.correlation.qqMessageId,
      deliveryKey:event.correlation.eventKey, part:event.data.part, parts:event.data.parts, platformStatus:event.data.platformStatus,
      recipientStatus:event.data.recipientStatus, clientDelivery:event.data.clientDelivery, readStatus:event.data.readStatus,
    }));
    items.push({proposalId:proposal.id,action:proposal.action_kind,preview,confirmations,write,versionChecks,replies});
  }
  const selection = eventRef ? {eventRef,found:Boolean(anchor),...(anchor&&ref(anchor))} : {messageId};
  const page = size => {
    const rows = items.slice(offset,offset+size);
    const nextOffset = offset+rows.length<items.length ? offset+rows.length : null;
    return {schemaVersion:1,view:'qq-evidence',peer,from:new Date(from).toISOString(),to:new Date(to).toISOString(),
      selection,total:items.length,shown:rows.length,offset,nextOffset,truncated:nextOffset!==null,
      sourceStatus:[...sourceStatus,source,...(channelEvents.sourceStatus??[])],items:rows};
  };
  let value = page(limit);
  while (value.shown>1 && !queryOutputFits(value,budget)) value = page(value.shown-1);
  return paginateQueryContent(value,budget);
}
