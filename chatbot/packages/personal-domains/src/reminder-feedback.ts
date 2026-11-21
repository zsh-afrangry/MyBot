import {businessFeedback} from '../../feedback-core/index.js';
import {readQqCronFeedback} from '../../qq-delivery/cron-text-feedback.js';
import {formatShanghaiDateTime, type ReminderCronScheduler} from './reminders.js';
import type {ReminderDelivery, ReminderStore, StoredReminder} from './reminder-store.js';

const reminderManagementActions = ['reminder.create', 'reminder.update', 'reminder.cancel'] as const;
export const reminderFeedbackActions = [...reminderManagementActions, 'reminder.delivery'] as const;
export type ReminderFeedbackAction = typeof reminderFeedbackActions[number];
export type ReminderScheduleObservation =
  | {status: 'active'; cronJobId: string; scheduledAtUtc: number}
  | {status: 'absent' | 'mismatch' | 'unknown'};

export interface ReminderRunObservation {
  cronJobId: string;
  runAtMs: number;
  executionStatus: 'succeeded' | 'failed' | 'skipped' | 'unknown';
  hostDeliveryStatus: 'reported_sent' | 'not_delivered' | 'not_requested' | 'unknown';
}

export const sameReminderOwner = (a: ReminderDelivery, b: ReminderDelivery) =>
  a.channel === b.channel && a.to === b.to && (a.accountId ?? 'default') === (b.accountId ?? 'default');

/** Read the current schedule without reconciling or invoking a write RPC. */
export async function readReminderFeedback(store: ReminderStore, reminder: StoredReminder, scheduler: ReminderCronScheduler) {
  const declarationKey = store.getCurrentDeclarationKey(reminder.reminderId) ?? reminder.eventKey;
  let cron: ReminderScheduleObservation = {status:'unknown'};
  try {
    if (scheduler.inspectSchedule) cron = await scheduler.inspectSchedule(reminder, declarationKey);
  } catch { /* Domain state remains available when the scheduler cannot be read. */ }

  // A change during the scheduler call invalidates the combined observation.
  const current = store.getReminder(reminder.reminderId);
  const stable = current && current.status === reminder.status && current.updatedAtUtc === reminder.updatedAtUtc
    && current.cronJobId === reminder.cronJobId && current.scheduledAtUtc === reminder.scheduledAtUtc
    && current.content === reminder.content && current.failureCode === reminder.failureCode
    && (store.getCurrentDeclarationKey(reminder.reminderId) ?? current.eventKey) === declarationKey;
  if (!stable) cron = {status:'unknown'};

  let scheduleStatus: 'scheduled' | 'cancelled' | 'finished' | 'unknown' = 'unknown';
  if ((reminder.status === 'scheduled' || reminder.status === 'scheduling'
      || (reminder.status === 'failed' && reminder.failureCode === 'cron_add_unknown'))
      && cron.status === 'active' && cron.scheduledAtUtc === reminder.scheduledAtUtc) scheduleStatus = 'scheduled';
  if (reminder.status === 'cancelled' && cron.status === 'absent') scheduleStatus = 'cancelled';
  if (reminder.status === 'delivered' && cron.status === 'absent') scheduleStatus = 'finished';

  const stored = stable ? reminder : current ?? reminder;
  return businessFeedback('reminder.schedule', scheduleStatus, {
    reminderId: stored.reminderId,
    domainStatus: stored.status,
    plannedAtLocal: formatShanghaiDateTime(stored.scheduledAtUtc),
    timezone: stored.timezone,
    cancelledAtUtc: stored.cancelledAtUtc,
    failureCode: stored.failureCode,
    cronStatus: cron.status,
    ...(cron.status === 'active' && {
      cronJobId: cron.cronJobId,
      actualScheduledAtLocal: formatShanghaiDateTime(cron.scheduledAtUtc),
    }),
  });
}

async function readReminderRunFeedback(reminder: StoredReminder, scheduler: ReminderCronScheduler, qqStateDirectory?: string) {
  let run: ReminderRunObservation | undefined;
  try {
    run = await scheduler.inspectRun?.(reminder);
  } catch { /* An unavailable run history cannot prove failure. */ }
  const peer = /^user:(\d{5,12})$/u.exec(reminder.delivery.to)?.[1];
  const runId = run ? `cron:${run.cronJobId}:${run.runAtMs}` : undefined;
  let segments: ReturnType<typeof readQqCronFeedback> = [];
  if (runId && qqStateDirectory && peer && reminder.delivery.channel === 'kurumi-qq') {
    try { segments = readQqCronFeedback(qqStateDirectory,runId,peer); }
    catch { /* Host observations can still be returned when the QQ ledger is unreadable. */ }
  }
  return {
    ...businessFeedback('reminder.delivery', run?.executionStatus ?? 'unknown', {
      source: 'cron.runs',
      cronJobId: reminder.cronJobId,
      runAtMs: run?.runAtMs ?? null,
      runId: runId ?? null,
      hostDeliveryStatus: run?.hostDeliveryStatus ?? 'unknown',
      noticeStatus: segments.length || run?.executionStatus === 'succeeded' && run.hostDeliveryStatus === 'reported_sent'
        ? 'generated' : reminder.failureCode === 'assistant_notice_generation_failed' ? 'failed' : 'unknown',
    }),
    segments,
  };
}

export async function queryReminderFeedback(options: {
  store: ReminderStore;
  scheduler: ReminderCronScheduler;
  delivery: ReminderDelivery;
  actions: ReadonlySet<ReminderFeedbackAction>;
  qqStateDirectory?: string;
  reminderId?: string;
  proposalId?: string;
}) {
  const {store, scheduler, delivery, actions, proposalId, reminderId} = options;
  const proposal = proposalId ? store.getProposal(proposalId) : undefined;
  if (proposalId && (!proposal || !sameReminderOwner(proposal.delivery, delivery))) {
    return {ok:false, error:{code:'proposal_not_found'}};
  }
  const action = proposal && reminderManagementActions.find(candidate => candidate.replace('.', '_') === proposal.kind);
  if (!actions.size || (action && !actions.has(action))) return {ok:false, error:{code:'feedback_disabled'}};

  const id = proposal?.resultReminderId ?? reminderId;
  const reminder = id ? store.getReminder(id) : undefined;
  if (id && (!reminder || !sameReminderOwner(reminder.delivery, delivery))) {
    return {ok:false, error:{code:'reminder_not_found'}};
  }

  const proposalStatus = proposal?.status === 'pending'
    ? store.getNowUtc() >= proposal.expiresAtUtc ? 'expired' : 'pending_confirmation'
    : proposal?.status;
  const [schedule, notification] = await Promise.all([
    reminder && reminderManagementActions.some(name => actions.has(name))
      ? readReminderFeedback(store, reminder, scheduler) : undefined,
    reminder && actions.has('reminder.delivery')
      ? readReminderRunFeedback(reminder, scheduler, options.qqStateDirectory) : undefined,
  ]);
  return {
    ok: true,
    ...(proposal && action && proposalStatus && {proposal: businessFeedback(action, proposalStatus,
      {proposalId: proposal.proposalId, reminderId: proposal.resultReminderId})}),
    ...(reminder && {reminderId: reminder.reminderId, content: reminder.content}),
    ...(schedule && {feedback: schedule}),
    ...(notification && {notification}),
  };
}
