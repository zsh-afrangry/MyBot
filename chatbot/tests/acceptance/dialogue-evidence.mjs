import assert from 'node:assert/strict';
import {readQqTranscript} from '../../packages/log-query/qq-messages.js';
import {eventReference} from '../../packages/log-query/log-query-privacy.mjs';

// Preserve technical event evidence after a disposable Gateway is removed.
export function captureDialogueEvidence({root, owner, startedAt, finishedAt, messageIds}) {
  const {events} = readQqTranscript(root, owner, startedAt, finishedAt);
  const inbound = events.filter(event => event.kind === 'agent.inbound');
  assert.equal(inbound.length, 1, 'Turn has no uniquely correlated inbound log');
  const runId = inbound[0].correlation?.runId;
  assert(runId, 'Turn has no recorded run ID');
  const scoped = events.filter(event => event.correlation?.runId === runId);
  return {
    source: 'openclaw-session', runId, messageIds,
    events: scoped.map(event => ({
      kind: event.kind, eventRef: eventReference(event), at: event.at,
      ...(typeof event.data?.tool === 'string' && {tool: event.data.tool}),
      ...Object.fromEntries(['toolCallId', 'parentToolCallId', 'reminderId', 'cronJobId', 'qqMessageId']
        .filter(key => typeof event.correlation?.[key] === 'string').map(key => [key, event.correlation[key]])),
    })),
  };
}
