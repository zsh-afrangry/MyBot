// Actions opt in at their own execution boundary. A failed observation cannot fail the action.
export function observeFeedback(action, log, record) {
  try { record(); }
  catch { log?.warn?.(`Feedback unavailable for ${action}`); }
}

// A recipient's statement, client delivery, and read status are independent claims.
export function notificationFeedback({action, platformStatus, acknowledgement}) {
  return {
    action, platformStatus,
    recipientStatus: acknowledgement ? 'acknowledged' : 'unverified',
    clientDelivery: 'unknown', readStatus: 'unknown',
    ...(acknowledgement && {
      receiptId: acknowledgement.id,
      receiptSource: acknowledgement.source,
      recordedAt: new Date(acknowledgement.at).toISOString(),
    }),
  };
}

// Business adapters project their own authoritative results into a common envelope.
export function businessFeedback(action, status, evidence) {
  return {action, status, evidence};
}
