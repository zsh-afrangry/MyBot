import {businessFeedback, notificationFeedback} from '../../packages/feedback-core/index.js';

export const mailFeedbackActions = ['mail.draft', 'mail.send'];
const rejectedBySmtp = new Set(['sender_rejected', 'all_recipients_rejected', 'data_rejected', 'message_rejected']);

export function mailDraftFeedback({draftId, createdAtUtc, expiresAtUtc}) {
  return businessFeedback('mail.draft', 'created', {draftId, createdAtUtc, expiresAtUtc});
}

export function mailSendFeedback({status, draftId, messageId, sentAtUtc, code, stage, responseCode, acceptedCount, rejectedCount, receiptRecorded}) {
  let platformStatus = 'not_attempted';
  if (status === 'accepted' || status === 'unknown') platformStatus = status;
  if (status === 'failed' && rejectedBySmtp.has(code)) platformStatus = 'rejected';
  const {action, ...delivery} = notificationFeedback({action: 'mail.send', platformStatus});
  return businessFeedback(action, status, {
    draftId, ...delivery,
    messageId, sentAtUtc, code, stage, responseCode, acceptedCount, rejectedCount, receiptRecorded,
  });
}

// Older error rows lacked the SMTP phase. Only codes that prove the message
// never reached submission, or an explicit negative DATA response, are definitive.
const legacyPreSubmissionFailures = new Set([
  'missing_message', 'missing_sender', 'missing_recipient', 'missing_credentials',
  'bad_greeting', 'ehlo_rejected', 'auth_unsupported', 'auth_failed',
  'sender_rejected', 'all_recipients_rejected', 'data_rejected',
]);

function receiptStatus(receipt, now) {
  switch (receipt.state) {
    case 'sent':
      return receipt.messageId && receipt.sentAtUtc !== undefined ? 'accepted' : 'unknown';
    case 'failed':
      return receipt.detail.stage || legacyPreSubmissionFailures.has(receipt.detail.code) ||
        /^message_rejected: message rejected \([45]\d{2}\)$/u.test(receipt.lastError ?? '')
        ? 'failed' : 'unknown';
    case 'cancelled':
      return 'cancelled';
    case 'pending':
      if (receipt.proposalState === 'cancelled') return 'cancelled';
      if (receipt.proposalState === 'expired') return 'expired';
      if (receipt.proposalState !== 'pending') return 'unknown';
      if (receipt.expiresAtUtc <= now) return 'expired';
      return receipt.approved ? 'confirmed' : 'needs_confirmation';
    default:
      return 'unknown';
  }
}

export function mailReceiptFeedback(receipt, now, actions) {
  const feedback = [];
  if (actions.has('mail.draft')) feedback.push(mailDraftFeedback(receipt));
  if (actions.has('mail.send')) {
    const status = receiptStatus(receipt, now);
    feedback.push(mailSendFeedback({...receipt, ...receipt.detail, status}));
  }
  return feedback;
}
