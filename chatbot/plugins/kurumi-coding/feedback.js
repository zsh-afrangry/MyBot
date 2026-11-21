import {businessFeedback} from '../../packages/feedback-core/index.js';

export const codingFeedbackActions = ['coding.start','coding.continue','coding.complete','coding.delivery'];

export function codingRoundFeedback(action, task, round, actions) {
  const roundId = round?.roundId ?? task.executionRoundId;
  const current = roundId === task.executionRoundId;
  const state = current ? task.state : round?.state;
  const check = current ? task.checks : round?.hostChecks;
  const integration = round?.integration ?? (current && ['merged','written_back'].includes(task.state) ? task.state : undefined);
  const delivery = round?.delivery ?? (current && task.delivery?.roundId === roundId ? task.delivery : undefined);
  const deliveryState = delivery?.state;
  const persistedDeliveryState = deliveryState === 'sending' && (!current || state === 'needs_reconciliation')
    ? 'unknown' : deliveryState;
  const evidence = {
    taskId:task.id, ...(roundId && {roundId}), state, currentRound:current,
    checkStatus: check?.ok === true ? 'passed' : check?.ok === false ? 'failed' : 'unverified',
    ...(integration && {integration}),
    ...(state === 'ready' && {integration:'pending_review'}),
    ...(state === 'ready' && (round?.verifiedCommit ?? task.verifiedCommit) && {verifiedCommit:round?.verifiedCommit ?? task.verifiedCommit}),
  };
  const feedback = [];
  if (actions.has(action)) feedback.push(businessFeedback(action,state ?? 'unknown',evidence));
  if (actions.has('coding.delivery') && roundId) {
    feedback.push(businessFeedback('coding.delivery',persistedDeliveryState ?? (round?.notification ? 'unknown' : 'unrecorded'),{
      taskId:task.id,roundId,
      ...(delivery?.messageId && {messageId:delivery.messageId}),
      ...(delivery?.key && {deliveryKey:delivery.key}),
      ...(delivery?.code && {code:delivery.code}),
      recipientStatus:'unverified',
    }));
  }
  return feedback;
}
