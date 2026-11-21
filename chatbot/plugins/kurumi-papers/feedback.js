import {authorizedOwner} from '../../packages/access-control/index.js';
import {validId} from '../../packages/documents/index.js';
import {businessFeedback, notificationFeedback} from '../../packages/feedback-core/index.js';
import {readAttachmentDrafts} from '../../packages/mail-state/index.js';
import {readDocumentDeliveries} from '../../packages/qq-delivery/index.js';
import {selectedOutputs} from './outputs.js';

const translate = 'paper.translate';
const upload = 'paper.qq_upload';
const mailDraft = 'paper.mail_draft';
export const paperFeedbackActions = [translate, upload, mailDraft];

function canReadMail(ctx, cfg) {
  const mail = cfg.plugins?.entries?.['kurumi-mail'];
  const tools = cfg.agents?.entries?.main?.tools;
  return cfg.plugins?.enabled !== false && mail?.enabled === true && (mail.config?.storeAdapter ?? 'sqlite') === 'sqlite'
    && (tools?.alsoAllow?.includes('email_outbox') || tools?.allow?.includes('email_outbox'))
    && !tools?.deny?.includes('email_outbox') && !cfg.tools?.deny?.includes('email_outbox')
    && authorizedOwner(ctx, cfg, 'mail.history');
}

function automaticEvidence(job, kind, documentId, attempt) {
  if (attempt) return attempt;
  const receipt = job.delivery?.receipts?.find(row => row?.documentId === documentId
    && (row.kind ? row.kind === kind : Object.values(job.artifacts).filter(id => id === documentId).length === 1)
    && row.channel === 'kurumi-qq' && row.status === 'platform_accepted');
  if (receipt) return {platformStatus: 'accepted', ...(receipt.fileId != null && {fileId: receipt.fileId})};
  const handoff = job.delivery?.attemptedKinds;
  const uncertain = handoff ? handoff.includes(kind)
    : ['dispatching', 'failed_or_unknown', 'platform_accepted'].includes(job.delivery?.status);
  return {platformStatus: uncertain ? 'unknown' : 'not_attempted'};
}

function pdfDeliveryFeedback(documentId, {actions, ctx, cfg, to}, job, kind) {
  const evidence = {documentId, ...(job && {jobId: job.id, kind})};
  const feedback = [];
  if (actions.has(upload)) {
    let history;
    try {
      history = readDocumentDeliveries({cfg, to, documentId, key: job && job.id + ':' + kind});
    } catch { /* A failed read cannot erase the job's saved receipt. */ }
    const automatic = job && automaticEvidence(job, kind, documentId, history?.automatic);
    const status = automatic?.platformStatus ?? history?.attempts[0]?.platformStatus ?? (history ? 'unrecorded' : 'unknown');
    const {action, ...channel} = notificationFeedback({action: upload, platformStatus: status === 'unrecorded' ? 'unknown' : status});
    feedback.push(businessFeedback(action, status, {
      ...evidence, ...channel, ...(automatic && {automatic}),
      ...(history ? {attempts: history.attempts, truncated: history.truncated} : {receiptSource: 'unavailable'}),
    }));
  }
  if (actions.has(mailDraft) && canReadMail(ctx, cfg)) {
    let history;
    try { history = readAttachmentDrafts(documentId); }
    catch { /* A failed read leaves draft linkage unknown. */ }
    const status = history ? (history.drafts.length ? 'drafted' : 'unrecorded') : 'unknown';
    feedback.push(businessFeedback(mailDraft, status, {...evidence, ...history}));
  }
  return feedback;
}

export function paperJobFeedback(job, options) {
  const kinds = new Set([...selectedOutputs(job.deliveryKind), ...Object.keys(job.artifacts ?? {})]);
  const outputs = Array.from(kinds, kind => {
    const documentId = job.artifacts?.[kind];
    return validId(documentId) ? {kind, documentId, status: 'generated'} : {kind, status: 'unrecorded'};
  });
  const feedback = options.actions.has(translate) ? [businessFeedback(translate, job.status, {
    jobId: job.id, documentId: job.documentId, outputs, ...(job.error && {code: job.error}),
  })] : [];
  return feedback.concat(outputs.flatMap(({kind, documentId}) =>
    documentId ? pdfDeliveryFeedback(documentId, options, job, kind) : []));
}

export function paperDocumentFeedback(document, options) {
  if (document.kind !== 'artifact') return [];
  const feedback = options.actions.has(translate) ? [businessFeedback(translate, 'generated', {
    documentId: document.id, ...(document.jobId && {jobId: document.jobId}),
  })] : [];
  return feedback.concat(pdfDeliveryFeedback(document.id, options));
}
